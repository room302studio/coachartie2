/**
 * GitHub Poller Service
 *
 * Polls GitHub repos for new events (PRs, comments, reviews, CI runs)
 * and emits them for processing and posting to Discord.
 */

import { Octokit } from '@octokit/rest';
import {
  logger,
  getDb,
  githubRepoWatches,
  githubSyncState,
  type GithubRepoWatch,
  type GithubSyncState,
} from '@coachartie/shared';
import { eq, and } from 'drizzle-orm';
import { EventEmitter } from 'events';

// Event types for GitHub sync
export type GitHubEventType =
  | 'pr_opened'
  | 'pr_ready_for_review'
  | 'pr_merged'
  | 'pr_closed'
  | 'pr_approved'
  | 'pr_changes_requested'
  | 'pr_comment'
  | 'pr_review'
  | 'ci_success'
  | 'ci_failure';

export interface GitHubSyncEvent {
  type: GitHubEventType;
  repo: string;
  channelId: string;
  guildId: string;
  data: {
    prNumber?: number;
    prTitle?: string;
    prUrl?: string;
    prAuthor?: string;
    prState?: string;
    prDraft?: boolean;
    prBaseBranch?: string;
    commentId?: number;
    commentBody?: string;
    commentAuthor?: string;
    commentUrl?: string;
    reviewId?: number;
    reviewState?: string;
    reviewAuthor?: string;
    reviewBody?: string;
    checkRunId?: number;
    checkRunName?: string;
    checkRunStatus?: string;
    checkRunConclusion?: string;
    additions?: number;
    deletions?: number;
    labels?: string[];
    reviewers?: string[];
  };
  timestamp: string;
}

export interface PollerConfig {
  pollIntervalMs: number;
  maxReposPerPoll: number;
  rateLimitBuffer: number; // Keep this many requests in reserve
  backoffMultiplier: number;
  maxBackoffMs: number;
}

const DEFAULT_CONFIG: PollerConfig = {
  pollIntervalMs: 3 * 60 * 1000, // 3 minutes
  maxReposPerPoll: 10,
  rateLimitBuffer: 100,
  backoffMultiplier: 2,
  maxBackoffMs: 30 * 60 * 1000, // 30 minutes max backoff
};

/**
 * GitHub Poller Service
 * Polls repos and emits events for new activity
 */
export class GitHubPollerService extends EventEmitter {
  private octokit: Octokit;
  private config: PollerConfig;
  private pollInterval: NodeJS.Timeout | null = null;
  private isPolling = false;
  private isPaused = false;

  constructor(token: string, config: Partial<PollerConfig> = {}) {
    super();
    this.octokit = new Octokit({ auth: token });
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the polling loop
   */
  start(): void {
    if (this.pollInterval) {
      logger.warn('GitHub poller already running');
      return;
    }

    logger.info('Starting GitHub poller service', {
      pollIntervalMs: this.config.pollIntervalMs,
    });

    // Initial poll
    this.poll().catch((err) => logger.error('Initial poll failed:', err));

    // Set up interval
    this.pollInterval = setInterval(() => {
      if (!this.isPaused) {
        this.poll().catch((err) => logger.error('Poll cycle failed:', err));
      }
    }, this.config.pollIntervalMs);
  }

  /**
   * Stop the polling loop
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      logger.info('GitHub poller service stopped');
    }
  }

  /**
   * Pause polling (e.g., during rate limiting)
   */
  pause(): void {
    this.isPaused = true;
    logger.info('GitHub poller paused');
  }

  /**
   * Resume polling
   */
  resume(): void {
    this.isPaused = false;
    logger.info('GitHub poller resumed');
  }

  /**
   * Run a single poll cycle
   */
  async poll(): Promise<void> {
    if (this.isPolling) {
      logger.debug('Poll already in progress, skipping');
      return;
    }

    this.isPolling = true;

    try {
      // Check rate limit before polling
      const rateLimit = await this.checkRateLimit();
      if (rateLimit.remaining < this.config.rateLimitBuffer) {
        const resetTime = new Date(rateLimit.reset * 1000);
        logger.warn('Rate limit low, pausing until reset', {
          remaining: rateLimit.remaining,
          resetTime,
        });
        this.pause();
        setTimeout(() => this.resume(), rateLimit.reset * 1000 - Date.now() + 1000);
        return;
      }

      // Get active repo watches
      const watches = await this.getActiveWatches();
      if (watches.length === 0) {
        logger.debug('No active repo watches configured');
        return;
      }

      logger.info(`Polling ${watches.length} repos for new events`);

      // Poll each repo
      for (const watch of watches.slice(0, this.config.maxReposPerPoll)) {
        try {
          await this.pollRepo(watch);
        } catch (error) {
          logger.error(`Error polling repo ${watch.repo}:`, error);
          await this.incrementPollErrors(watch.repo);
        }
      }
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Poll a single repository for new events
   */
  private async pollRepo(watch: GithubRepoWatch): Promise<void> {
    const [owner, repo] = watch.repo.split('/');
    if (!owner || !repo) {
      logger.error(`Invalid repo format: ${watch.repo}`);
      return;
    }

    // Get or create sync state
    let syncState = await this.getSyncState(watch.repo);
    if (!syncState) {
      syncState = await this.createSyncState(watch.repo);
    }

    const events = watch.events ? JSON.parse(watch.events) : ['all'];
    const shouldPollAll = events.includes('all');

    // Poll PRs
    if (shouldPollAll || events.includes('pr') || events.includes('review')) {
      await this.pollPullRequests(owner, repo, watch, syncState);
    }

    // Poll check runs (CI)
    if (shouldPollAll || events.includes('ci')) {
      await this.pollCheckRuns(owner, repo, watch, syncState);
    }

    // Update last polled time and reset errors
    await this.updateSyncState(watch.repo, {
      lastPolledAt: new Date().toISOString(),
      pollErrors: 0,
    });
  }

  /**
   * Poll for new/updated pull requests
   */
  private async pollPullRequests(
    owner: string,
    repo: string,
    watch: GithubRepoWatch,
    syncState: GithubSyncState
  ): Promise<void> {
    try {
      // Fetch recently updated PRs
      const { data: prs } = await this.octokit.pulls.list({
        owner,
        repo,
        state: 'all',
        sort: 'updated',
        direction: 'desc',
        per_page: 30,
      });

      const lastUpdatedAt = syncState.lastPrUpdatedAt
        ? new Date(syncState.lastPrUpdatedAt)
        : new Date(0);

      for (const pr of prs) {
        const prUpdatedAt = new Date(pr.updated_at);

        // Skip if we've already processed this update
        if (prUpdatedAt <= lastUpdatedAt) {
          continue;
        }

        // Check for various PR events
        await this.processPullRequest(owner, repo, pr, watch, syncState);
      }

      // Update last PR updated timestamp
      if (prs.length > 0) {
        await this.updateSyncState(watch.repo, {
          lastPrUpdatedAt: prs[0].updated_at,
        });
      }
    } catch (error) {
      logger.error(`Error polling PRs for ${owner}/${repo}:`, error);
      throw error;
    }
  }

  /**
   * Process a single pull request and emit relevant events
   */
  private async processPullRequest(
    owner: string,
    repo: string,
    pr: any,
    watch: GithubRepoWatch,
    syncState: GithubSyncState
  ): Promise<void> {
    const repoFullName = `${owner}/${repo}`;
    const prCreatedAt = new Date(pr.created_at);
    const lastPolledAt = syncState.lastPolledAt ? new Date(syncState.lastPolledAt) : new Date(0);

    // Check if this is a new PR
    if (prCreatedAt > lastPolledAt && !pr.draft) {
      this.emitEvent({
        type: 'pr_opened',
        repo: repoFullName,
        channelId: watch.channelId,
        guildId: watch.guildId,
        data: {
          prNumber: pr.number,
          prTitle: pr.title,
          prUrl: pr.html_url,
          prAuthor: pr.user?.login,
          prState: pr.state,
          prDraft: pr.draft,
          prBaseBranch: pr.base?.ref,
          additions: pr.additions,
          deletions: pr.deletions,
          labels: pr.labels?.map((l: any) => l.name) || [],
        },
        timestamp: pr.created_at,
      });
    }

    // Check if PR was just marked ready for review (was draft, now isn't)
    // This requires tracking draft state, which we'll handle via comments/timeline

    // Check if merged
    if (pr.merged_at) {
      const mergedAt = new Date(pr.merged_at);
      if (mergedAt > lastPolledAt) {
        this.emitEvent({
          type: 'pr_merged',
          repo: repoFullName,
          channelId: watch.channelId,
          guildId: watch.guildId,
          data: {
            prNumber: pr.number,
            prTitle: pr.title,
            prUrl: pr.html_url,
            prAuthor: pr.user?.login,
            prBaseBranch: pr.base?.ref,
            additions: pr.additions,
            deletions: pr.deletions,
          },
          timestamp: pr.merged_at,
        });
      }
    }

    // Check for new reviews
    await this.pollPrReviews(owner, repo, pr.number, watch, syncState);

    // Check for new comments
    await this.pollPrComments(owner, repo, pr.number, watch, syncState);
  }

  /**
   * Poll for PR reviews
   */
  private async pollPrReviews(
    owner: string,
    repo: string,
    prNumber: number,
    watch: GithubRepoWatch,
    syncState: GithubSyncState
  ): Promise<void> {
    try {
      const { data: reviews } = await this.octokit.pulls.listReviews({
        owner,
        repo,
        pull_number: prNumber,
        per_page: 30,
      });

      const lastReviewId = syncState.lastReviewId || 0;

      for (const review of reviews) {
        if (review.id <= lastReviewId) {
          continue;
        }

        // Determine event type based on review state
        let eventType: GitHubEventType = 'pr_review';
        if (review.state === 'APPROVED') {
          eventType = 'pr_approved';
        } else if (review.state === 'CHANGES_REQUESTED') {
          eventType = 'pr_changes_requested';
        }

        this.emitEvent({
          type: eventType,
          repo: `${owner}/${repo}`,
          channelId: watch.channelId,
          guildId: watch.guildId,
          data: {
            prNumber,
            reviewId: review.id,
            reviewState: review.state,
            reviewAuthor: review.user?.login,
            reviewBody: review.body,
          },
          timestamp: review.submitted_at || new Date().toISOString(),
        });

        // Update last review ID
        if (review.id > lastReviewId) {
          await this.updateSyncState(watch.repo, { lastReviewId: review.id });
        }
      }
    } catch (error) {
      logger.error(`Error polling reviews for PR #${prNumber} in ${owner}/${repo}:`, error);
    }
  }

  /**
   * Poll for PR comments (issue comments on PRs)
   */
  private async pollPrComments(
    owner: string,
    repo: string,
    prNumber: number,
    watch: GithubRepoWatch,
    syncState: GithubSyncState
  ): Promise<void> {
    try {
      const { data: comments } = await this.octokit.issues.listComments({
        owner,
        repo,
        issue_number: prNumber,
        per_page: 30,
        sort: 'created',
        direction: 'desc',
      });

      const lastCommentId = syncState.lastCommentId || 0;

      for (const comment of comments) {
        if (comment.id <= lastCommentId) {
          continue;
        }

        this.emitEvent({
          type: 'pr_comment',
          repo: `${owner}/${repo}`,
          channelId: watch.channelId,
          guildId: watch.guildId,
          data: {
            prNumber,
            commentId: comment.id,
            commentBody: comment.body || '',
            commentAuthor: comment.user?.login,
            commentUrl: comment.html_url,
          },
          timestamp: comment.created_at,
        });

        // Update last comment ID
        if (comment.id > lastCommentId) {
          await this.updateSyncState(watch.repo, { lastCommentId: comment.id });
        }
      }
    } catch (error) {
      logger.error(`Error polling comments for PR #${prNumber} in ${owner}/${repo}:`, error);
    }
  }

  /**
   * Poll for check runs (CI status)
   */
  private async pollCheckRuns(
    owner: string,
    repo: string,
    watch: GithubRepoWatch,
    syncState: GithubSyncState
  ): Promise<void> {
    try {
      // Get the default branch
      const { data: repoData } = await this.octokit.repos.get({ owner, repo });
      const defaultBranch = repoData.default_branch;

      // Get recent check runs for the default branch
      const { data: checkRuns } = await this.octokit.checks.listForRef({
        owner,
        repo,
        ref: defaultBranch,
        per_page: 30,
      });

      const lastCheckRunId = syncState.lastCheckRunId || 0;

      for (const checkRun of checkRuns.check_runs) {
        if (checkRun.id <= lastCheckRunId) {
          continue;
        }

        // Only emit for completed check runs
        if (checkRun.status !== 'completed') {
          continue;
        }

        const eventType: GitHubEventType =
          checkRun.conclusion === 'success' ? 'ci_success' : 'ci_failure';

        this.emitEvent({
          type: eventType,
          repo: `${owner}/${repo}`,
          channelId: watch.channelId,
          guildId: watch.guildId,
          data: {
            checkRunId: checkRun.id,
            checkRunName: checkRun.name,
            checkRunStatus: checkRun.status,
            checkRunConclusion: checkRun.conclusion || undefined,
          },
          timestamp: checkRun.completed_at || new Date().toISOString(),
        });

        // Update last check run ID
        if (checkRun.id > lastCheckRunId) {
          await this.updateSyncState(watch.repo, { lastCheckRunId: checkRun.id });
        }
      }
    } catch (error) {
      logger.error(`Error polling check runs for ${owner}/${repo}:`, error);
    }
  }

  /**
   * Emit a GitHub sync event
   */
  private emitEvent(event: GitHubSyncEvent): void {
    logger.info('GitHub event detected', {
      type: event.type,
      repo: event.repo,
      channelId: event.channelId,
    });
    this.emit('github-event', event);
  }

  /**
   * Check GitHub API rate limit
   */
  private async checkRateLimit(): Promise<{ remaining: number; reset: number }> {
    try {
      const { data } = await this.octokit.rateLimit.get();
      return {
        remaining: data.rate.remaining,
        reset: data.rate.reset,
      };
    } catch (error) {
      logger.error('Failed to check rate limit:', error);
      return { remaining: 1000, reset: Date.now() / 1000 + 3600 };
    }
  }

  /**
   * Get active repo watches from database
   */
  private async getActiveWatches(): Promise<GithubRepoWatch[]> {
    try {
      return await getDb().select().from(githubRepoWatches).where(eq(githubRepoWatches.isActive, true));
    } catch (error) {
      logger.error('Failed to get active watches:', error);
      return [];
    }
  }

  /**
   * Get sync state for a repo
   */
  private async getSyncState(repo: string): Promise<GithubSyncState | null> {
    try {
      const results = await getDb()
        .select()
        .from(githubSyncState)
        .where(eq(githubSyncState.repo, repo))
        .limit(1);
      return results[0] || null;
    } catch (error) {
      logger.error(`Failed to get sync state for ${repo}:`, error);
      return null;
    }
  }

  /**
   * Create initial sync state for a repo
   */
  private async createSyncState(repo: string): Promise<GithubSyncState> {
    try {
      const now = new Date().toISOString();
      await getDb().insert(githubSyncState).values({
        repo,
        lastPolledAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const results = await getDb()
        .select()
        .from(githubSyncState)
        .where(eq(githubSyncState.repo, repo))
        .limit(1);
      return results[0];
    } catch (error) {
      logger.error(`Failed to create sync state for ${repo}:`, error);
      throw error;
    }
  }

  /**
   * Update sync state for a repo
   */
  private async updateSyncState(
    repo: string,
    updates: Partial<GithubSyncState>
  ): Promise<void> {
    try {
      await getDb()
        .update(githubSyncState)
        .set({
          ...updates,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(githubSyncState.repo, repo));
    } catch (error) {
      logger.error(`Failed to update sync state for ${repo}:`, error);
    }
  }

  /**
   * Increment poll error count for backoff
   */
  private async incrementPollErrors(repo: string): Promise<void> {
    try {
      const state = await this.getSyncState(repo);
      if (state) {
        await this.updateSyncState(repo, {
          pollErrors: (state.pollErrors || 0) + 1,
        });
      }
    } catch (error) {
      logger.error(`Failed to increment poll errors for ${repo}:`, error);
    }
  }

  /**
   * Add a repo watch
   */
  async addWatch(
    repo: string,
    guildId: string,
    channelId: string,
    events: string[] = ['all'],
    createdBy?: string
  ): Promise<void> {
    try {
      const now = new Date().toISOString();
      await getDb().insert(githubRepoWatches).values({
        repo,
        guildId,
        channelId,
        events: JSON.stringify(events),
        isActive: true,
        createdBy,
        createdAt: now,
        updatedAt: now,
      });
      logger.info(`Added watch for ${repo} -> ${channelId}`);
    } catch (error) {
      logger.error(`Failed to add watch for ${repo}:`, error);
      throw error;
    }
  }

  /**
   * Remove a repo watch
   */
  async removeWatch(repo: string, channelId: string): Promise<void> {
    try {
      await getDb()
        .delete(githubRepoWatches)
        .where(
          and(eq(githubRepoWatches.repo, repo), eq(githubRepoWatches.channelId, channelId))
        );
      logger.info(`Removed watch for ${repo} -> ${channelId}`);
    } catch (error) {
      logger.error(`Failed to remove watch for ${repo}:`, error);
      throw error;
    }
  }

  /**
   * List watches for a guild or channel
   */
  async listWatches(guildId?: string, channelId?: string): Promise<GithubRepoWatch[]> {
    try {
      const db = getDb();
      let query = db.select().from(githubRepoWatches);

      if (guildId && channelId) {
        return await query.where(
          and(
            eq(githubRepoWatches.guildId, guildId),
            eq(githubRepoWatches.channelId, channelId)
          )
        );
      } else if (guildId) {
        return await query.where(eq(githubRepoWatches.guildId, guildId));
      } else if (channelId) {
        return await query.where(eq(githubRepoWatches.channelId, channelId));
      }

      return await query;
    } catch (error) {
      logger.error('Failed to list watches:', error);
      return [];
    }
  }
}

// Singleton instance
let pollerInstance: GitHubPollerService | null = null;

/**
 * Initialize the GitHub poller service
 */
export function initializeGitHubPoller(
  token?: string,
  config?: Partial<PollerConfig>
): GitHubPollerService {
  const githubToken = token || process.env.GITHUB_TOKEN;

  if (!githubToken) {
    throw new Error('GitHub token not provided and GITHUB_TOKEN environment variable not set');
  }

  if (pollerInstance) {
    pollerInstance.stop();
  }

  pollerInstance = new GitHubPollerService(githubToken, config);
  logger.info('GitHub poller service initialized');
  return pollerInstance;
}

/**
 * Get the GitHub poller service instance
 */
export function getGitHubPoller(): GitHubPollerService {
  if (!pollerInstance) {
    throw new Error(
      'GitHub poller service not initialized. Call initializeGitHubPoller first.'
    );
  }
  return pollerInstance;
}
