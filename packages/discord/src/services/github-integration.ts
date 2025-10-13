/**
 * GitHub Integration Service
 *
 * Provides utilities for creating and managing GitHub issues from Discord data.
 * Supports bulk operations, intelligent tagging, and markdown formatting.
 */

import { Octokit } from '@octokit/rest';
import { logger } from '@coachartie/shared';
import type { ForumThreadData, ThreadMessageData } from './forum-traversal.js';

export interface GitHubIssueData {
  title: string;
  body: string;
  labels?: string[];
  assignees?: string[];
}

export interface SyncResult {
  success: boolean;
  issueNumber?: number;
  issueUrl?: string;
  error?: string;
}

/**
 * GitHub Integration Service - Create issues from Discord discussions
 */
export class GitHubIntegrationService {
  private octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  /**
   * Parse a GitHub repository reference (owner/repo or full URL)
   */
  parseRepoReference(ref: string): { owner: string; repo: string } | null {
    try {
      // Handle full GitHub URLs
      if (ref.includes('github.com')) {
        const match = ref.match(/github\.com\/([^\/]+)\/([^\/]+)/);
        if (match) {
          return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
        }
      }

      // Handle owner/repo format
      if (ref.includes('/')) {
        const [owner, repo] = ref.split('/');
        if (owner && repo) {
          return { owner, repo: repo.replace(/\.git$/, '') };
        }
      }

      return null;
    } catch (error) {
      logger.error(`Failed to parse repo reference "${ref}":`, error);
      return null;
    }
  }

  /**
   * Convert a Discord thread to a formatted GitHub issue
   */
  formatThreadAsIssue(thread: ForumThreadData, forumName: string): GitHubIssueData {
    const { threadName, starterMessage, messages, threadTags, ownerName, createdAt } = thread;

    // Create issue title
    const title = `[Discord Discussion] ${threadName}`;

    // Build issue body with markdown
    let body = `## Original Discussion\n\n`;
    body += `**Forum:** ${forumName}\n`;
    body += `**Author:** @${ownerName}\n`;
    body += `**Created:** ${createdAt.toISOString().split('T')[0]}\n`;
    body += `**Replies:** ${messages.length - 1}\n\n`;

    if (threadTags.length > 0) {
      body += `**Tags:** ${threadTags.join(', ')}\n\n`;
    }

    body += `---\n\n`;

    // Add starter message
    if (starterMessage) {
      body += `### Original Post\n\n`;
      body += `${starterMessage.content}\n\n`;

      if (starterMessage.attachments.length > 0) {
        body += `**Attachments:**\n`;
        starterMessage.attachments.forEach(url => {
          body += `- ${url}\n`;
        });
        body += `\n`;
      }
    }

    // Add summary of responses
    if (messages.length > 1) {
      body += `---\n\n`;
      body += `### Discussion Summary\n\n`;
      body += `This thread has ${messages.length - 1} ${messages.length === 2 ? 'reply' : 'replies'}.\n\n`;

      // Add top 3 responses (excluding starter message)
      const responses = messages.slice(1, 4);
      if (responses.length > 0) {
        body += `**Top Responses:**\n\n`;
        responses.forEach((msg, index) => {
          body += `${index + 1}. **@${msg.authorName}** (${msg.createdAt.toISOString().split('T')[0]}):\n`;
          const preview = msg.content.length > 200
            ? msg.content.substring(0, 200) + '...'
            : msg.content;
          body += `   > ${preview}\n\n`;
        });
      }

      if (messages.length > 4) {
        body += `_...and ${messages.length - 4} more ${messages.length - 4 === 1 ? 'reply' : 'replies'}_\n\n`;
      }
    }

    body += `---\n\n`;
    body += `*Synced from Discord Forums*\n`;

    return {
      title,
      body,
      labels: this.suggestLabels(thread)
    };
  }

  /**
   * Suggest GitHub labels based on thread content and metadata
   */
  private suggestLabels(thread: ForumThreadData): string[] {
    const labels: string[] = ['discord-sync'];

    // Add forum-specific label
    labels.push('discussion');

    // Check thread tags and map to common GitHub labels
    const tagMappings: Record<string, string> = {
      'bug': 'bug',
      'feature': 'enhancement',
      'question': 'question',
      'help': 'help wanted',
      'documentation': 'documentation',
      'feedback': 'feedback'
    };

    thread.threadTags.forEach(tag => {
      const normalizedTag = tag.toLowerCase();
      if (tagMappings[normalizedTag]) {
        labels.push(tagMappings[normalizedTag]);
      }
    });

    // Analyze content for keywords (simple keyword matching)
    const content = (thread.starterMessage?.content || '').toLowerCase();

    if (content.includes('bug') || content.includes('error') || content.includes('broken')) {
      labels.push('bug');
    }
    if (content.includes('feature') || content.includes('enhancement') || content.includes('suggestion')) {
      labels.push('enhancement');
    }
    if (content.includes('documentation') || content.includes('docs') || content.includes('readme')) {
      labels.push('documentation');
    }
    if (content.includes('help') || content.includes('how to') || content.includes('question')) {
      labels.push('question');
    }

    // Remove duplicates
    return Array.from(new Set(labels));
  }

  /**
   * Create a GitHub issue from a Discord thread
   */
  async createIssueFromThread(
    owner: string,
    repo: string,
    thread: ForumThreadData,
    forumName: string
  ): Promise<SyncResult> {
    try {
      const issueData = this.formatThreadAsIssue(thread, forumName);

      logger.info(`Creating GitHub issue for thread "${thread.threadName}" in ${owner}/${repo}`);

      const response = await this.octokit.issues.create({
        owner,
        repo,
        title: issueData.title,
        body: issueData.body,
        labels: issueData.labels
      });

      logger.info(`Created issue #${response.data.number}: ${response.data.html_url}`);

      return {
        success: true,
        issueNumber: response.data.number,
        issueUrl: response.data.html_url
      };
    } catch (error) {
      logger.error(`Failed to create GitHub issue for thread "${thread.threadName}":`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Sync multiple threads to GitHub issues
   */
  async syncThreadsToGitHub(
    owner: string,
    repo: string,
    threads: ForumThreadData[],
    forumName: string,
    onProgress?: (current: number, total: number, result: SyncResult) => void
  ): Promise<SyncResult[]> {
    logger.info(`Starting sync of ${threads.length} threads to ${owner}/${repo}`);

    const results: SyncResult[] = [];

    for (let i = 0; i < threads.length; i++) {
      const thread = threads[i];
      const result = await this.createIssueFromThread(owner, repo, thread, forumName);
      results.push(result);

      if (onProgress) {
        onProgress(i + 1, threads.length, result);
      }

      // Rate limiting: wait 1 second between issue creations
      if (i < threads.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    const successCount = results.filter(r => r.success).length;
    logger.info(`Sync complete: ${successCount}/${threads.length} issues created`);

    return results;
  }

  /**
   * Check if a repository exists and is accessible
   */
  async verifyRepository(owner: string, repo: string): Promise<boolean> {
    try {
      await this.octokit.repos.get({ owner, repo });
      return true;
    } catch (error) {
      logger.warn(`Repository ${owner}/${repo} not accessible:`, error);
      return false;
    }
  }

  /**
   * Get available labels in a repository
   */
  async getRepositoryLabels(owner: string, repo: string): Promise<string[]> {
    try {
      const response = await this.octokit.issues.listLabelsForRepo({
        owner,
        repo,
        per_page: 100
      });

      return response.data.map(label => label.name);
    } catch (error) {
      logger.error(`Failed to fetch labels for ${owner}/${repo}:`, error);
      return [];
    }
  }
}

/**
 * Global GitHub integration service instance
 * Initialized with token from environment
 */
let githubService: GitHubIntegrationService | null = null;

export function initializeGitHubIntegration(token?: string): GitHubIntegrationService {
  const githubToken = token || process.env.GITHUB_TOKEN;

  if (!githubToken) {
    throw new Error('GitHub token not provided and GITHUB_TOKEN environment variable not set');
  }

  githubService = new GitHubIntegrationService(githubToken);
  logger.info('GitHub integration service initialized');
  return githubService;
}

export function getGitHubIntegration(): GitHubIntegrationService {
  if (!githubService) {
    throw new Error('GitHub integration service not initialized. Call initializeGitHubIntegration first.');
  }
  return githubService;
}
