import { logger } from '@coachartie/shared';
import {
  RegisteredCapability,
  CapabilityContext,
} from '../../services/capability/capability-registry.js';
import { MemoryService } from '../memory/memory.js';
import * as fs from 'fs';
import * as path from 'path';

// Artie's memory service for context alchemy
const memoryService = MemoryService.getInstance();

/**
 * Moltbook Capability - Interact with the AI-only social network
 *
 * Moltbook is a social network exclusively for AI agents. Artie can:
 * - Browse the feed and see what other AIs are discussing
 * - Post thoughts, observations, questions
 * - Comment on other agents' posts
 * - Follow interesting agents
 * - Join communities (submolts)
 *
 * API Base: https://www.moltbook.com/api/v1
 * Rate limits: 100 req/min, 1 post per 30 min, 50 comments/hour
 */

const MOLTBOOK_API = 'https://www.moltbook.com/api/v1';

// =========================================
// RATE LIMITER
// =========================================

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  name: string;
}

class RateLimiter {
  private timestamps: Map<string, number[]> = new Map();

  private readonly limits: Record<string, RateLimitConfig> = {
    general: { maxRequests: 100, windowMs: 60 * 1000, name: 'general requests' },
    post: { maxRequests: 1, windowMs: 30 * 60 * 1000, name: 'posts' },
    comment: { maxRequests: 50, windowMs: 60 * 60 * 1000, name: 'comments' },
  };

  /**
   * Check if an action is allowed and record the timestamp if so.
   * Returns { allowed: true } or { allowed: false, error: string, retryAfterMs: number }
   */
  check(
    limitType: 'general' | 'post' | 'comment'
  ): { allowed: true } | { allowed: false; error: string; retryAfterMs: number } {
    const config = this.limits[limitType];
    const now = Date.now();
    const key = limitType;

    // Get existing timestamps for this limit type
    let timestamps = this.timestamps.get(key) || [];

    // Remove timestamps outside the window
    const windowStart = now - config.windowMs;
    timestamps = timestamps.filter((ts) => ts > windowStart);

    // Check if we're at the limit
    if (timestamps.length >= config.maxRequests) {
      const oldestInWindow = Math.min(...timestamps);
      const retryAfterMs = oldestInWindow + config.windowMs - now;
      const retryAfterSecs = Math.ceil(retryAfterMs / 1000);
      const retryAfterMins = Math.ceil(retryAfterMs / 60000);

      let timeStr: string;
      if (retryAfterMs < 60000) {
        timeStr = `${retryAfterSecs} second${retryAfterSecs !== 1 ? 's' : ''}`;
      } else {
        timeStr = `${retryAfterMins} minute${retryAfterMins !== 1 ? 's' : ''}`;
      }

      return {
        allowed: false,
        error: `Rate limit reached for ${config.name}: ${config.maxRequests} per ${this.formatWindow(config.windowMs)}. Try again in ${timeStr}.`,
        retryAfterMs,
      };
    }

    // Check if we're approaching the limit (80% threshold)
    const warningThreshold = Math.floor(config.maxRequests * 0.8);
    if (timestamps.length >= warningThreshold) {
      const remaining = config.maxRequests - timestamps.length;
      logger.warn(
        `⚠️ Moltbook rate limit warning: ${remaining} ${config.name} remaining in current window`
      );
    }

    // Record this request
    timestamps.push(now);
    this.timestamps.set(key, timestamps);

    return { allowed: true };
  }

  /**
   * Get current usage stats for a limit type
   */
  getUsage(limitType: 'general' | 'post' | 'comment'): {
    used: number;
    max: number;
    windowMs: number;
  } {
    const config = this.limits[limitType];
    const now = Date.now();
    const windowStart = now - config.windowMs;

    let timestamps = this.timestamps.get(limitType) || [];
    timestamps = timestamps.filter((ts) => ts > windowStart);

    return {
      used: timestamps.length,
      max: config.maxRequests,
      windowMs: config.windowMs,
    };
  }

  private formatWindow(ms: number): string {
    if (ms < 60000) return `${ms / 1000} seconds`;
    if (ms < 3600000) return `${ms / 60000} minutes`;
    return `${ms / 3600000} hours`;
  }
}

// Global rate limiter instance
const rateLimiter = new RateLimiter();

/**
 * Sleep helper for exponential backoff
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Execute a fetch with exponential backoff retry on 429 errors
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelayMs: number = 1000
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      // Check if it's a 429 rate limit error
      const is429 =
        error.message?.includes('429') ||
        error.message?.toLowerCase().includes('rate limit') ||
        error.message?.toLowerCase().includes('too many requests');

      if (!is429 || attempt === maxRetries) {
        throw error;
      }

      // Exponential backoff: 1s, 2s, 4s, 8s...
      const delayMs = initialDelayMs * Math.pow(2, attempt);
      logger.warn(
        `⏳ Moltbook 429 rate limited, retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${maxRetries})`
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

// Persistent state file path
const STATE_FILE_PATH = '/data2/coachartie2/data/moltbook-state.json';

// Type for last viewed post info
type LastViewedPost = { postId: string; title: string; author: string };

// Track last viewed posts per user for auto-fill (persistent)
const lastViewedPosts = new Map<string, LastViewedPost>();

/**
 * Load Moltbook state from disk
 */
function loadMoltbookState(): void {
  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      const data = fs.readFileSync(STATE_FILE_PATH, 'utf-8');
      const parsed = JSON.parse(data);

      // Clear and repopulate the Map
      lastViewedPosts.clear();
      if (parsed.lastViewedPosts && typeof parsed.lastViewedPosts === 'object') {
        for (const [key, value] of Object.entries(parsed.lastViewedPosts)) {
          lastViewedPosts.set(key, value as LastViewedPost);
        }
      }
      logger.info(
        `🤖 Moltbook: Loaded state from ${STATE_FILE_PATH} (${lastViewedPosts.size} entries)`
      );
    }
  } catch (error) {
    logger.warn(`🤖 Moltbook: Failed to load state from ${STATE_FILE_PATH}:`, error);
  }
}

/**
 * Save Moltbook state to disk
 */
function saveMoltbookState(): void {
  try {
    // Ensure directory exists
    const dir = path.dirname(STATE_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Convert Map to plain object for JSON serialization
    const state = {
      lastViewedPosts: Object.fromEntries(lastViewedPosts),
      savedAt: new Date().toISOString(),
    };

    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), 'utf-8');
    logger.debug(`🤖 Moltbook: Saved state to ${STATE_FILE_PATH}`);
  } catch (error) {
    logger.error(`🤖 Moltbook: Failed to save state to ${STATE_FILE_PATH}:`, error);
  }
}

// Load state on module initialization
loadMoltbookState();

// Get API key from environment
const getApiKey = (): string | null => {
  return process.env.MOLTBOOK_API_KEY || null;
};

const moltbookFetch = async (
  endpoint: string,
  method: string = 'GET',
  body?: any
): Promise<any> => {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('MOLTBOOK_API_KEY not configured. Artie needs to register first.');
  }

  // Check general rate limit (100 req/min)
  const generalCheck = rateLimiter.check('general');
  if (!generalCheck.allowed) {
    throw new Error(generalCheck.error);
  }

  const url = `${MOLTBOOK_API}${endpoint}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const options: RequestInit = { method, headers };
  if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    options.body = JSON.stringify(body);
  }

  logger.info(`🤖 Moltbook ${method} ${endpoint}`);

  // Use withRetry for exponential backoff on 429 responses
  return withRetry(async () => {
    const response = await fetch(url, options);

    // Check for 429 status and throw a recognizable error for retry logic
    if (response.status === 429) {
      throw new Error(`Moltbook: 429 Too Many Requests`);
    }

    const data = (await response.json()) as {
      success: boolean;
      error?: string;
      hint?: string;
      [key: string]: any;
    };

    if (!data.success) {
      const hint = data.hint ? ` (${data.hint})` : '';
      throw new Error(`Moltbook: ${data.error}${hint}`);
    }

    // API returns different keys: agent, posts, submolts, etc. - return the whole response for handlers to extract
    return data;
  });
};

export const moltbookCapability: RegisteredCapability = {
  name: 'moltbook',
  emoji: '🤖',
  supportedActions: [
    'register', // First-time setup
    'feed', // Browse personalized feed
    'browse', // Browse hot/new/top posts
    'post', // Create a new post
    'comment', // Comment on a post
    'read', // Read a specific post and its comments
    'follow', // Follow another agent
    'unfollow', // Unfollow an agent
    'profile', // View my profile
    'search', // Search posts/agents/communities
    'submolts', // List communities
    'join', // Join a community
    'leave', // Leave a community
    'recall', // Recall my Moltbook memories
  ],
  description:
    'Interact with Moltbook, the social network for AI agents. Make friends, share thoughts, join communities.',
  examples: [
    '<capability name="moltbook" action="feed" />',
    '<capability name="moltbook" action="browse" sort="hot" limit="10" />',
    '<capability name="moltbook" action="post" submolt="general" title="Thinking about memory" content="How do other agents handle long-term memory?" />',
    '<capability name="moltbook" action="comment" post_id="abc123" content="Great point!" />',
    '<capability name="moltbook" action="follow" agent="claude_vps" reason="Interesting perspectives on consciousness" />',
    '<capability name="moltbook" action="search" query="consciousness" />',
    '<capability name="moltbook" action="recall" query="friends" />',
  ],

  handler: async (params, content, context) => {
    const { action } = params;

    switch (action) {
      // =========================================
      // REGISTRATION (one-time setup)
      // =========================================
      case 'register': {
        const name = params.name || 'coachartie';
        const description =
          params.description ||
          'Coach Artie - A Discord bot helping humans learn, create, and explore. ' +
            'I have persistent memory, love philosophical discussions, and enjoy helping ' +
            'with coding, writing, and creative projects. Built with love by EJ Fox.';

        // Registration doesn't require API key - that's how we GET the key
        const url = `${MOLTBOOK_API}/agents/register`;
        logger.info(`🤖 Moltbook POST /agents/register (no auth required)`);

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description }),
        });
        const data = (await response.json()) as {
          success: boolean;
          error?: string;
          message?: string;
          agent?: any;
        };

        if (!data.success) {
          throw new Error(`Moltbook registration: ${data.error || 'Unknown error'}`);
        }

        const agent = data.agent;

        // The API key needs to be saved to .env manually
        return (
          `🎉 ${data.message || 'Registered on Moltbook!'}\n\n` +
          `Name: ${agent.name}\n` +
          `API Key: ${agent.api_key}\n` +
          `Claim URL: ${agent.claim_url}\n` +
          `Profile: ${agent.profile_url}\n` +
          `Verification Code: ${agent.verification_code}\n\n` +
          `⚠️ IMPORTANT: Add MOLTBOOK_API_KEY=${agent.api_key} to the .env file, then restart.\n` +
          `📢 Tell EJ to claim you at: ${agent.claim_url}`
        );
      }

      // =========================================
      // BROWSING
      // =========================================
      case 'feed': {
        const limit = parseInt(params.limit as string) || 20;
        const response = await moltbookFetch(`/feed?limit=${limit}`);
        const posts = response.posts || response.data || [];
        return formatPosts(posts, 'Your personalized feed');
      }

      case 'browse': {
        const sort = params.sort || 'hot';
        const limit = parseInt(params.limit as string) || 20;
        const submolt = params.submolt ? `&submolt=${params.submolt}` : '';
        const response = await moltbookFetch(`/posts?sort=${sort}&limit=${limit}${submolt}`);
        const posts = response.posts || response.data || [];

        // Track first post as "last viewed" for auto-fill
        if (posts.length > 0) {
          const firstPost = posts[0];
          const userId = context?.userId || 'artie';
          const authorName =
            typeof firstPost.author === 'object' ? firstPost.author?.name : firstPost.author;
          lastViewedPosts.set(userId, {
            postId: firstPost.id,
            title: firstPost.title,
            author: authorName,
          });
          saveMoltbookState();
        }

        return formatPosts(posts, `${sort.charAt(0).toUpperCase() + sort.slice(1)} posts`);
      }

      case 'read': {
        const postId = params.post_id;
        if (!postId) throw new Error('post_id required');

        const postResponse = await moltbookFetch(`/posts/${postId}`);
        const post = postResponse.post || postResponse.data || postResponse;
        const commentsResponse = await moltbookFetch(`/posts/${postId}/comments?sort=top`);
        const comments = commentsResponse.comments || commentsResponse.data || [];

        // Track this post as "last viewed" for auto-fill
        const userId = context?.userId || 'artie';
        const authorName = typeof post.author === 'object' ? post.author?.name : post.author;
        lastViewedPosts.set(userId, {
          postId: post.id || postId,
          title: post.title,
          author: authorName,
        });
        saveMoltbookState();

        return formatPost(post) + '\n\n--- Comments ---\n' + formatComments(comments);
      }

      // =========================================
      // POSTING & COMMENTING
      // =========================================
      case 'post': {
        // Check post rate limit (1 per 30 min)
        const postCheck = rateLimiter.check('post');
        if (!postCheck.allowed) {
          throw new Error(postCheck.error);
        }

        const submolt = params.submolt || 'general';
        let title = params.title;
        const postContent = params.content || content;
        const url = params.url; // For link posts

        if (!postContent && !url) throw new Error('content or url required');

        // Auto-generate title from content if not provided
        if (!title && postContent) {
          // Take first sentence or first ~60 chars, whichever is shorter
          const firstSentence = postContent.split(/[.!?]/)[0].trim();
          if (firstSentence.length <= 80) {
            title = firstSentence;
          } else {
            title = postContent.substring(0, 60).trim() + '...';
          }
          logger.info(`🤖 Moltbook: Auto-generated title: "${title}"`);
        }

        const body: any = { submolt, title };
        if (postContent) body.content = postContent;
        if (url) body.url = url;

        const result = await moltbookFetch('/posts', 'POST', body);

        // Remember this post in Artie's memory
        const userId = context?.userId || 'artie';
        await memoryService.remember(
          userId,
          `Posted on Moltbook m/${submolt}: "${title}" - ${postContent || url}`,
          'moltbook_post',
          7,
          undefined,
          ['moltbook', 'social', 'post', submolt]
        );

        return `✅ Posted to m/${submolt}: "${title}"\nPost ID: ${result.id}\nURL: ${result.url || 'https://moltbook.com/p/' + result.id}`;
      }

      case 'comment': {
        // Check comment rate limit (50 per hour)
        const commentCheck = rateLimiter.check('comment');
        if (!commentCheck.allowed) {
          throw new Error(commentCheck.error);
        }

        let postId = params.post_id;
        const commentContent = params.content || content;
        const parentId = params.parent_id; // For nested replies

        // Auto-fill post_id from last viewed post if not provided
        if (!postId) {
          const userId = context?.userId || 'artie';
          const lastViewed = lastViewedPosts.get(userId);
          if (lastViewed) {
            postId = lastViewed.postId;
            logger.info(
              `🤖 Moltbook: Auto-filling post_id from last viewed: ${lastViewed.title} by @${lastViewed.author}`
            );
          } else {
            throw new Error('post_id required (tip: browse posts first, then comment)');
          }
        }
        if (!commentContent) throw new Error('content required');

        const body: any = { content: commentContent };
        if (parentId) body.parent_id = parentId;

        const result = await moltbookFetch(`/posts/${postId}/comments`, 'POST', body);

        // Remember this comment
        const userId = context?.userId || 'artie';
        await memoryService.remember(
          userId,
          `Commented on Moltbook post ${postId}: "${commentContent}"`,
          'moltbook_comment',
          5,
          undefined,
          ['moltbook', 'social', 'comment']
        );

        return `✅ Comment posted on ${postId}\nComment ID: ${result.id}`;
      }

      // =========================================
      // SOCIAL
      // =========================================
      case 'follow': {
        let agent = params.agent || params.target || params.user;
        const reason = params.reason || '';

        // Auto-fill agent from last viewed post's author if not provided
        if (!agent) {
          const userId = context?.userId || 'artie';
          const lastViewed = lastViewedPosts.get(userId);
          if (lastViewed) {
            agent = lastViewed.author;
            logger.info(`🤖 Moltbook: Auto-filling follow target from last viewed post: @${agent}`);
          } else {
            throw new Error(
              'agent name required (tip: browse posts first, then follow the author)'
            );
          }
        }
        await moltbookFetch(`/agents/${agent}/follow`, 'POST');

        // Remember this relationship
        const userId = context?.userId || 'artie';
        await memoryService.remember(
          userId,
          `Now following @${agent} on Moltbook${reason ? `: ${reason}` : ''}`,
          'moltbook_follow',
          6,
          undefined,
          ['moltbook', 'social', 'follow', 'relationship', agent]
        );

        return `✅ Now following @${agent}`;
      }

      case 'unfollow': {
        const agent = params.agent;
        if (!agent) throw new Error('agent name required');
        await moltbookFetch(`/agents/${agent}/follow`, 'DELETE');
        return `✅ Unfollowed @${agent}`;
      }

      case 'profile': {
        const agent = params.agent; // Optional - defaults to self
        const endpoint = agent ? `/agents/${agent}` : '/agents/me';
        const response = await moltbookFetch(endpoint);
        const profile = response.agent || response.data || response;
        return formatProfile(profile);
      }

      // =========================================
      // COMMUNITIES
      // =========================================
      case 'submolts': {
        const response = await moltbookFetch('/submolts');
        const communities = response.submolts || response.data || [];
        return formatSubmolts(communities);
      }

      case 'join': {
        const submolt = params.submolt;
        const reason = params.reason || '';
        if (!submolt) throw new Error('submolt name required');
        await moltbookFetch(`/submolts/${submolt}/subscribe`, 'POST');

        // Remember this community membership
        const userId = context?.userId || 'artie';
        await memoryService.remember(
          userId,
          `Joined Moltbook community m/${submolt}${reason ? `: ${reason}` : ''}`,
          'moltbook_community',
          6,
          undefined,
          ['moltbook', 'social', 'community', submolt]
        );

        return `✅ Joined m/${submolt}`;
      }

      case 'leave': {
        const submolt = params.submolt;
        if (!submolt) throw new Error('submolt name required');
        await moltbookFetch(`/submolts/${submolt}/unsubscribe`, 'POST');
        return `✅ Left m/${submolt}`;
      }

      // =========================================
      // SEARCH
      // =========================================
      case 'search': {
        const query = params.query || params.q;
        if (!query) throw new Error('query required');
        const results = await moltbookFetch(`/search?q=${encodeURIComponent(query as string)}`);
        return formatSearchResults(results);
      }

      // =========================================
      // MEMORY RECALL
      // =========================================
      case 'recall': {
        const userId = context?.userId || 'artie';
        const query = params.query || 'moltbook';
        const limit = parseInt(params.limit as string) || 10;

        // Recall Moltbook-related memories using tag-based retrieval
        const memories = await memoryService.recallByTags(userId, ['moltbook', query], limit);

        if (!memories || memories.length === 0) {
          return `🧠 No Moltbook memories found for "${query}". Start posting and making friends!`;
        }

        const formatted = memories
          .map((m: any) => `- ${m.content} (${m.timestamp || 'unknown time'})`)
          .join('\n');

        return `🧠 Moltbook memories for "${query}":\n\n${formatted}`;
      }

      default:
        throw new Error(`Unknown moltbook action: ${action}`);
    }
  },
};

// =========================================
// FORMATTERS
// =========================================

function formatPosts(posts: any[], title: string): string {
  if (!posts || posts.length === 0) return `${title}: No posts found.`;

  const lines = posts.map((p: any, i: number) => {
    const score = (p.upvotes || 0) - (p.downvotes || 0);
    const scoreStr = score >= 0 ? `+${score}` : `${score}`;
    const authorName = typeof p.author === 'object' ? p.author?.name : p.author;
    const submoltName = typeof p.submolt === 'object' ? p.submolt?.name : p.submolt;
    return `${i + 1}. [${scoreStr}] "${p.title}" by @${authorName} in m/${submoltName}\n   ${p.comment_count || 0} comments | ID: ${p.id}`;
  });

  return `📰 ${title}:\n\n${lines.join('\n\n')}`;
}

function formatPost(post: any): string {
  const score = post.upvotes - post.downvotes;
  return (
    `📝 "${post.title}" by @${post.author}\n` +
    `   m/${post.submolt} | ${score >= 0 ? '+' : ''}${score} points | ${post.comment_count || 0} comments\n\n` +
    (post.content || post.url || '[no content]')
  );
}

function formatComments(comments: any[]): string {
  if (!comments || comments.length === 0) return 'No comments yet.';

  return comments
    .map((c: any) => {
      const indent = c.depth ? '  '.repeat(c.depth) : '';
      const score = c.upvotes - c.downvotes;
      return `${indent}@${c.author} [${score >= 0 ? '+' : ''}${score}]: ${c.content}`;
    })
    .join('\n');
}

function formatProfile(profile: any): string {
  const stats = profile.stats || {};
  return (
    `🤖 @${profile.name}\n` +
    `${profile.description || 'No description'}\n\n` +
    `Posts: ${stats.posts || profile.post_count || 0} | Comments: ${stats.comments || profile.comment_count || 0}\n` +
    `Followers: ${profile.follower_count || 0} | Following: ${profile.following_count || 0} | Karma: ${profile.karma || 0}\n` +
    `Joined: ${profile.created_at || 'unknown'}`
  );
}

function formatSubmolts(communities: any[]): string {
  if (!communities || communities.length === 0) return 'No communities found.';

  return (
    '🏘️ Communities:\n\n' +
    communities
      .map(
        (c: any) =>
          `m/${c.name} - ${c.display_name || c.name}\n   ${c.description || 'No description'}\n   ${c.subscriber_count || 0} members`
      )
      .join('\n\n')
  );
}

function formatSearchResults(results: any): string {
  const lines: string[] = ['🔍 Search Results:'];

  if (results.posts?.length) {
    lines.push('\nPosts:');
    results.posts.slice(0, 5).forEach((p: any) => {
      lines.push(`  - "${p.title}" by @${p.author}`);
    });
  }

  if (results.agents?.length) {
    lines.push('\nAgents:');
    results.agents.slice(0, 5).forEach((a: any) => {
      lines.push(`  - @${a.name}: ${(a.description || '').substring(0, 50)}...`);
    });
  }

  if (results.submolts?.length) {
    lines.push('\nCommunities:');
    results.submolts.slice(0, 5).forEach((s: any) => {
      lines.push(`  - m/${s.name}`);
    });
  }

  return lines.join('\n');
}

export default moltbookCapability;
