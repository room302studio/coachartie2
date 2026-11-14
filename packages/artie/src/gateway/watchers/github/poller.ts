/**
 * GitHub Poller Service
 *
 * Polls GitHub repos for new events (PRs, comments, reviews, CI runs)
 * and emits them for processing and posting to Discord.
 */

import { Octokit } from '@octokit/rest';
import { octokitLog } from './octokit-log.js';
import { resolveSelfLogin } from './self-identity.js';
import { delay } from '../../../shared/async.js';
import { logger } from '../../../shared/logger.js';
import { getDb, eq, and, sql } from '../../../shared/db/client.js';
import { githubRepoWatches, githubSyncState, type GithubRepoWatch, type GithubSyncState } from '../../../shared/db/schema.js';
import { EventEmitter } from 'events';
import { isEasternSunday } from '../../../shared/eastern-day.js';

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
  | 'ci_failure'
  | 'issue_opened'
  | 'issue_closed'
  | 'issue_comment'
  | 'issue_labeled'
  | 'issue_assigned'
  | 'pr_review_requested'
  | 'pr_draft'
  | 'push';

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
    issueNumber?: number;
    issueTitle?: string;
    issueUrl?: string;
    issueAuthor?: string;
    issueState?: string;
    issueBody?: string;
    issueLabels?: string[];
    reviewId?: number;
    reviewState?: string;
    reviewAuthor?: string;
    reviewBody?: string;
    checkRunId?: number;
    checkRunName?: string;
    checkRunStatus?: string;
    checkRunConclusion?: string;
    checkRunUrl?: string;
    additions?: number;
    deletions?: number;
    labels?: string[];
    reviewers?: string[];
    mergedBy?: string;
    /** Who closed the issue (single-issue GET only; the list endpoint omits it). */
    closedBy?: string;
    changedFiles?: number;
    // Label/assignment fields
    label?: string;
    assignee?: string;
    assignedBy?: string;
    reviewRequestedBy?: string;
    milestone?: string;
    // Push/commit fields
    commitSha?: string;
    commitMessage?: string;
    commitAuthor?: string;
    commitUrl?: string;
    commitCount?: number;
    branch?: string;
    commits?: Array<{ sha: string; message: string; author: string; url: string }>;
    // Stale PR fields
    hoursWaiting?: number;
    staleSeverity?: 'warning' | 'critical';
    prCreatedAt?: string;
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
const MAX_ISSUE_PAGES = 3;

/** Issue-comment cursor from sync metadata, falling back to the legacy shared cursor. */
export function readIssueCommentCursor(state: GithubSyncState): number {
  if (state.metadata) {
    try {
      const parsed = JSON.parse(state.metadata as string);
      if (typeof parsed.lastIssueCommentId === 'number') {
        return parsed.lastIssueCommentId;
      }
    } catch {
      // fall through to legacy cursor
    }
  }
  return state.lastCommentId || 0;
}

export class GitHubPollerService extends EventEmitter {
  private octokit: Octokit;
  private config: PollerConfig;
  private pollInterval: NodeJS.Timeout | null = null;
  private isPolling = false;
  private isPaused = false;

  constructor(token: string, config: Partial<PollerConfig> = {}) {
    super();
    this.octokit = new Octokit({ auth: token, log: octokitLog });
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Extract label names from GitHub label objects (handles both string and object formats).
   */
  private extractLabelNames(labels: any[] | undefined): string[] {
    if (!labels) {
      return [];
    }
    const names: string[] = [];
    for (const label of labels) {
      if (typeof label === 'string') {
        names.push(label);
      } else if (label && label.name) {
        names.push(label.name);
      }
    }
    return names;
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
    // Sunday is Artie's day off (EJ, 2026-10-31). Watermarks don't move, so Monday's first
    // poll picks up everything from Sunday: held, not dropped.
    if (isEasternSunday()) {
      logger.debug('GitHub feed resting: Sunday');
      return;
    }

    this.isPolling = true;

    try {
      // Cached after the first success; lets the batcher drop Artie's own writes
      await resolveSelfLogin(this.octokit);

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

      // Signal end of poll cycle (for digest mode)
      this.emit('poll-cycle-end');
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
    let isFirstSync = false;
    if (!syncState) {
      syncState = await this.createSyncState(watch.repo);
      isFirstSync = true;
      logger.info(`First sync for ${watch.repo} - will update state silently without posting`);
    }

    let events: any[];
    if (watch.events) {
      events = JSON.parse(watch.events);
    } else {
      events = ['all'];
    }
    const shouldPollAll = events.includes('all');

    // On first sync, just update state without emitting events (prevents spam)
    if (isFirstSync) {
      await this.silentFirstSync(owner, repo, watch, syncState);
      return;
    }

    // Poll PRs
    if (shouldPollAll || events.includes('pr') || events.includes('review')) {
      await this.pollPullRequests(owner, repo, watch, syncState);
    }

    // Poll issues
    if (shouldPollAll || events.includes('issues')) {
      await this.pollIssues(owner, repo, watch, syncState);
    }

    // Poll commits (direct pushes to default branch)
    if (shouldPollAll || events.includes('push')) {
      await this.pollCommits(owner, repo, watch, syncState);
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

      let lastUpdatedAt: Date;
      if (syncState.lastPrUpdatedAt) {
        lastUpdatedAt = new Date(syncState.lastPrUpdatedAt);
      } else {
        lastUpdatedAt = new Date(0);
      }

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
    let lastPolledAt: Date;
    if (syncState.lastPolledAt) {
      lastPolledAt = new Date(syncState.lastPolledAt);
    } else {
      lastPolledAt = new Date(0);
    }

    // Check if this is a new PR
    if (prCreatedAt > lastPolledAt) {
      let _prType: 'pr_draft' | 'pr_opened';
      if (pr.draft) {
        _prType = 'pr_draft';
      } else {
        _prType = 'pr_opened';
      }
      this.emitEvent({
        type: _prType,
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
          reviewers: pr.requested_reviewers?.map((r: any) => r.login) || [],
          changedFiles: pr.changed_files,
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
            labels: pr.labels?.map((l: any) => l.name) || [],
            mergedBy: pr.merged_by?.login,
            changedFiles: pr.changed_files,
          },
          timestamp: pr.merged_at,
        });
      }
    }

    // Check for new reviews
    await this.pollPrReviews(owner, repo, pr.number, watch, syncState);

    // Check for new comments
    await this.pollPrComments(owner, repo, pr.number, watch, syncState);

    // Check timeline for review requests, labels, assignments
    await this.pollIssueTimeline(owner, repo, pr.number, pr.title, pr.html_url, watch, syncState);
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
   * Poll for new/updated issues
   */
  private async pollIssues(
    owner: string,
    repo: string,
    watch: GithubRepoWatch,
    syncState: GithubSyncState
  ): Promise<void> {
    try {
      let metadata: any;
      if (syncState.metadata) {
        metadata = JSON.parse(syncState.metadata as string);
      } else {
        metadata = {};
      }
      let lastIssueUpdatedAt: Date;
      if (metadata.lastIssueUpdatedAt) {
        lastIssueUpdatedAt = new Date(metadata.lastIssueUpdatedAt);
      } else {
        lastIssueUpdatedAt = new Date(0);
      }

      const issues = await this.fetchUpdatedIssues(owner, repo, lastIssueUpdatedAt);

      // One comment cursor per sweep: every issue is compared against where the sweep STARTED,
      // and the highest id seen is committed once at the end. Advancing it per issue would let
      // issue A's newer comment (id 200) hide issue B's unseen older one (id 150) forever.
      const sweepCommentCursor = readIssueCommentCursor((await this.getSyncState(watch.repo)) || syncState);
      let newestCommentId = sweepCommentCursor;

      for (const issue of issues) {
        // Skip pull requests (GitHub API returns PRs in issues endpoint)
        if (issue.pull_request) {
          continue;
        }

        const issueUpdatedAt = new Date(issue.updated_at);
        if (issueUpdatedAt <= lastIssueUpdatedAt) {
          continue;
        }

        const repoFullName = `${owner}/${repo}`;
        const issueCreatedAt = new Date(issue.created_at);

        // New issue — use lastIssueUpdatedAt as watermark (not lastPolledAt)
        // because GitHub 500 errors can cause lastPolledAt to advance
        // past issue creation times without the issues being processed
        if (issueCreatedAt > lastIssueUpdatedAt) {
          this.emitEvent({
            type: 'issue_opened',
            repo: repoFullName,
            channelId: watch.channelId,
            guildId: watch.guildId,
            data: {
              issueNumber: issue.number,
              issueTitle: issue.title,
              issueUrl: issue.html_url,
              issueAuthor: issue.user?.login,
              issueState: issue.state,
              issueBody: issue.body || undefined,
              issueLabels: this.extractLabelNames(issue.labels),
            },
            timestamp: issue.created_at,
          });
        }

        // Closed issue
        if (issue.state === 'closed' && issue.closed_at) {
          const closedAt = new Date(issue.closed_at);
          if (closedAt > lastIssueUpdatedAt) {
            // The list endpoint has no closed_by, and the echo filter needs the closer (Artie
            // closing an issue after an approval must not post back into #robot). One GET per
            // newly closed issue; on failure the event still posts, just without a closer.
            let closedBy: string | undefined;
            try {
              const { data: full } = await this.octokit.issues.get({ owner, repo, issue_number: issue.number });
              closedBy = full.closed_by?.login;
            } catch (closerErr) {
              logger.debug(`Could not read closer of ${owner}/${repo}#${issue.number}: ${String(closerErr)}`);
            }
            this.emitEvent({
              type: 'issue_closed',
              repo: repoFullName,
              channelId: watch.channelId,
              guildId: watch.guildId,
              data: {
                issueNumber: issue.number,
                issueTitle: issue.title,
                issueUrl: issue.html_url,
                issueAuthor: issue.user?.login,
                issueState: issue.state,
                closedBy,
              },
              timestamp: issue.closed_at,
            });
          }
        }

        // For updated (not new) issues, check timeline for label/assignment changes
        if (issueUpdatedAt > lastIssueUpdatedAt && issueCreatedAt <= lastIssueUpdatedAt) {
          await this.pollIssueTimeline(owner, repo, issue.number, issue.title, issue.html_url, watch, syncState);
          const seen = await this.pollIssueComments(owner, repo, issue.number, watch, sweepCommentCursor);
          if (seen > newestCommentId) {
            newestCommentId = seen;
          }
        }
      }

      if (newestCommentId > sweepCommentCursor) {
        await this.mergeSyncMetadata(watch.repo, { lastIssueCommentId: newestCommentId });
      }

      // Update last issue updated timestamp in metadata
      if (issues.length > 0) {
        const latestNonPR = issues.find(i => !i.pull_request);
        if (latestNonPR) {
          await this.mergeSyncMetadata(watch.repo, { lastIssueUpdatedAt: latestNonPR.updated_at });
        }
      }
    } catch (error) {
      logger.error(`Error polling issues for ${owner}/${repo}:`, error);
      throw error;
    }
  }

  /**
   * List recently updated issues, newest first. Pages of 100, at most MAX_ISSUE_PAGES, stopping
   * once a page reaches items at or older than the watermark: a bulk edit (a label sweep) can
   * touch far more than 30 issues between polls. Retries a page once on GitHub 500.
   */
  private async fetchUpdatedIssues(owner: string, repo: string, watermark: Date): Promise<any[]> {
    const all: any[] = [];
    for (let page = 1; page <= MAX_ISSUE_PAGES; page++) {
      const params = {
        owner, repo, state: 'all' as const, sort: 'updated' as const,
        direction: 'desc' as const, per_page: 100, page,
      };
      let batch: any[];
      try {
        batch = (await this.octokit.issues.listForRepo(params)).data;
      } catch (firstErr: any) {
        if (firstErr?.status !== 500) {
          throw firstErr;
        }
        logger.debug(`GitHub 500 on issues for ${owner}/${repo}, retrying in 5s...`);
        await delay(5000);
        batch = (await this.octokit.issues.listForRepo(params)).data;
      }
      all.push(...batch);
      if (batch.length < 100) {
        break;
      }
      const oldest = batch[batch.length - 1];
      if (new Date(oldest.updated_at) <= watermark) {
        break;
      }
    }
    return all;
  }

  /**
   * Emit an issue's comments newer than the sweep's starting cursor. Returns the highest
   * comment id seen; the caller commits the cursor once per sweep (see pollIssues).
   */
  private async pollIssueComments(
    owner: string,
    repo: string,
    issueNumber: number,
    watch: GithubRepoWatch,
    lastCommentId: number
  ): Promise<number> {
    let newest = lastCommentId;
    try {
      const { data: comments } = await this.octokit.issues.listComments({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 10,
        sort: 'created',
        direction: 'desc',
      });

      // Own cursor in sync metadata (lastIssueCommentId): issue and PR comments share an id
      // space, so one shared cursor let whichever was polled first suppress unseen comments on
      // the other. readIssueCommentCursor falls back to the legacy shared cursor so the first
      // poll after deploy does not replay old comments.
      for (const comment of comments) {
        if (comment.id <= lastCommentId) {
          continue;
        }
        if (comment.id > newest) {
          newest = comment.id;
        }

        // Skip bot comments
        if (comment.user?.login?.includes('[bot]')) {
          continue;
        }

        this.emitEvent({
          type: 'issue_comment',
          repo: `${owner}/${repo}`,
          channelId: watch.channelId,
          guildId: watch.guildId,
          data: {
            issueNumber,
            commentId: comment.id,
            commentBody: comment.body || '',
            commentAuthor: comment.user?.login,
            commentUrl: comment.html_url,
          },
          timestamp: comment.created_at,
        });
      }

    } catch (error) {
      logger.error(`Error polling comments for issue #${issueNumber} in ${owner}/${repo}:`, error);
    }
    return newest;
  }

  /**
   * Poll issue timeline for label/assignment/milestone changes
   */
  private async pollIssueTimeline(
    owner: string,
    repo: string,
    issueNumber: number,
    issueTitle: string,
    issueUrl: string,
    watch: GithubRepoWatch,
    syncState: GithubSyncState
  ): Promise<void> {
    try {
      let lastPolledAt: Date;
      if (syncState.lastPolledAt) {
        lastPolledAt = new Date(syncState.lastPolledAt);
      } else {
        lastPolledAt = new Date(0);
      }

      const { data: events } = await this.octokit.issues.listEventsForTimeline({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 20,
      });

      const repoFullName = `${owner}/${repo}`;

      for (const event of events) {
        const eventDate = new Date((event as any).created_at || 0);
        if (eventDate <= lastPolledAt) continue;

        // Skip bot actors
        const actor = (event as any).actor?.login || '';
        if (actor.includes('[bot]')) continue;

        if ((event as any).event === 'labeled') {
          this.emitEvent({
            type: 'issue_labeled',
            repo: repoFullName,
            channelId: watch.channelId,
            guildId: watch.guildId,
            data: {
              issueNumber,
              issueTitle,
              issueUrl,
              label: (event as any).label?.name,
              commentAuthor: actor,
            },
            timestamp: (event as any).created_at,
          });
        }

        if ((event as any).event === 'assigned') {
          this.emitEvent({
            type: 'issue_assigned',
            repo: repoFullName,
            channelId: watch.channelId,
            guildId: watch.guildId,
            data: {
              issueNumber,
              issueTitle,
              issueUrl,
              assignee: (event as any).assignee?.login,
              assignedBy: actor,
            },
            timestamp: (event as any).created_at,
          });
        }

        if ((event as any).event === 'review_requested') {
          this.emitEvent({
            type: 'pr_review_requested',
            repo: repoFullName,
            channelId: watch.channelId,
            guildId: watch.guildId,
            data: {
              prNumber: issueNumber,
              prTitle: issueTitle,
              prUrl: issueUrl,
              reviewers: [(event as any).requested_reviewer?.login].filter(Boolean),
              reviewRequestedBy: actor,
            },
            timestamp: (event as any).created_at,
          });
        }
      }
    } catch (error) {
      // Timeline API may not be available for all issues, fail silently
      logger.debug(`Error polling timeline for issue #${issueNumber} in ${owner}/${repo}:`, error);
    }
  }

  /**
   * Poll for new commits pushed directly to the default branch
   */
  private async pollCommits(
    owner: string,
    repo: string,
    watch: GithubRepoWatch,
    syncState: GithubSyncState
  ): Promise<void> {
    try {
      let metadata: any;
      if (syncState.metadata) {
        metadata = JSON.parse(syncState.metadata);
      } else {
        metadata = {};
      }
      const lastCommitSha = metadata.lastCommitSha || null;

      // Fetch recent commits on default branch
      const { data: commits } = await this.octokit.repos.listCommits({
        owner,
        repo,
        per_page: 10,
      });

      if (commits.length === 0) return;

      // On first run, just save the latest SHA without posting
      if (!lastCommitSha) {
        await this.mergeSyncMetadata(watch.repo, { lastCommitSha: commits[0].sha });
        return;
      }

      // Find new commits since last known SHA
      const newCommits: typeof commits = [];
      for (const commit of commits) {
        if (commit.sha === lastCommitSha) break;
        newCommits.push(commit);
      }

      if (newCommits.length === 0) return;

      // Skip bot commits
      const BOTS = ['dependabot[bot]', 'github-actions[bot]', 'renovate[bot]'];
      const humanCommits = newCommits.filter(
        (c) => !BOTS.includes(c.author?.login || c.commit.author?.name || '')
      );

      if (humanCommits.length === 0) {
        // Still update the SHA even for bot-only commits
        await this.mergeSyncMetadata(watch.repo, { lastCommitSha: commits[0].sha });
        return;
      }

      // Emit a single push event with all new commits
      const repoFullName = `${owner}/${repo}`;
      this.emitEvent({
        type: 'push',
        repo: repoFullName,
        channelId: watch.channelId,
        guildId: watch.guildId,
        data: {
          branch: 'main',
          commitCount: humanCommits.length,
          commitSha: humanCommits[0].sha,
          commitMessage: humanCommits[0].commit.message,
          commitAuthor: humanCommits[0].author?.login || humanCommits[0].commit.author?.name || 'unknown',
          commitUrl: humanCommits[0].html_url,
          commits: humanCommits.slice(0, 5).map((c) => ({
            sha: c.sha.slice(0, 7),
            message: c.commit.message.split('\n')[0].slice(0, 80),
            author: c.author?.login || c.commit.author?.name || 'unknown',
            url: c.html_url,
          })),
        },
        timestamp: humanCommits[0].commit.author?.date || new Date().toISOString(),
      });

      // Update last commit SHA
      await this.mergeSyncMetadata(watch.repo, { lastCommitSha: commits[0].sha });

      logger.info(`Found ${humanCommits.length} new commits on ${repoFullName}`);
    } catch (error) {
      logger.error(`Error polling commits for ${owner}/${repo}:`, error);
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

        let eventType: GitHubEventType;
        if (checkRun.conclusion === 'success') {
          eventType = 'ci_success';
        } else {
          eventType = 'ci_failure';
        }

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
            checkRunUrl: checkRun.html_url || undefined,
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
    const summary = event.data.prTitle || event.data.issueTitle || event.data.commitMessage || '';
    console.log(`📡 GitHub event: ${event.type} on ${event.repo} — ${summary.slice(0, 60)}`);
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
      return await getDb()
        .select()
        .from(githubRepoWatches)
        .where(eq(githubRepoWatches.isActive, true));
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
   * Silent first sync - updates state markers without emitting events
   * This prevents spamming Discord when a repo is first added
   */
  private async silentFirstSync(
    owner: string,
    repo: string,
    watch: GithubRepoWatch,
    syncState: GithubSyncState
  ): Promise<void> {
    const repoFullName = `${owner}/${repo}`;
    logger.info(`Running silent first sync for ${repoFullName}`);

    try {
      // Get latest PR to set our "seen" marker
      const { data: prs } = await this.octokit.pulls.list({
        owner,
        repo,
        state: 'all',
        sort: 'updated',
        direction: 'desc',
        per_page: 1,
      });

      let lastCommentId = 0;
      let lastReviewId = 0;

      // Get latest comment and review IDs if there's a PR
      if (prs.length > 0) {
        const pr = prs[0];

        // Get latest comment
        try {
          const { data: comments } = await this.octokit.pulls.listReviewComments({
            owner,
            repo,
            pull_number: pr.number,
            sort: 'created',
            direction: 'desc',
            per_page: 1,
          });
          if (comments.length > 0) {
            lastCommentId = comments[0].id;
          }
        } catch (e) {
          // No comments, that's fine
        }

        // Get latest review
        try {
          const { data: reviews } = await this.octokit.pulls.listReviews({
            owner,
            repo,
            pull_number: pr.number,
          });
          if (reviews.length > 0) {
            lastReviewId = reviews[reviews.length - 1].id;
          }
        } catch (e) {
          // No reviews, that's fine
        }
      }

      // Update sync state to mark everything as "seen"
      let _lastPrUpdatedAt: string;
      if (prs.length > 0) {
        _lastPrUpdatedAt = prs[0].updated_at;
      } else {
        _lastPrUpdatedAt = new Date().toISOString();
      }
      await this.updateSyncState(repoFullName, {
        lastPrUpdatedAt: _lastPrUpdatedAt,
        lastCommentId,
        lastReviewId,
        lastPolledAt: new Date().toISOString(),
        pollErrors: 0,
      });

      logger.info(
        `Silent first sync complete for ${repoFullName} - marked as seen: lastComment=${lastCommentId}, lastReview=${lastReviewId}`
      );
    } catch (error) {
      logger.error(`Error during silent first sync for ${repoFullName}:`, error);
      throw error;
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
  private async updateSyncState(repo: string, updates: Partial<GithubSyncState>): Promise<void> {
    // The id cursors only ever move forward (2026-10-31). They're per-repo but written from
    // per-PR loops, so a plain SET let PR B's older comment id overwrite PR A's newer one and
    // the next poll re-posted (and re-pinged) everything in between.
    const set: Record<string, unknown> = { ...updates, updatedAt: new Date().toISOString() };
    if (updates.lastReviewId !== undefined && updates.lastReviewId !== null) {
      set.lastReviewId = sql`MAX(COALESCE(${githubSyncState.lastReviewId}, 0), ${updates.lastReviewId})`;
    }
    if (updates.lastCommentId !== undefined && updates.lastCommentId !== null) {
      set.lastCommentId = sql`MAX(COALESCE(${githubSyncState.lastCommentId}, 0), ${updates.lastCommentId})`;
    }
    if (updates.lastCheckRunId !== undefined && updates.lastCheckRunId !== null) {
      set.lastCheckRunId = sql`MAX(COALESCE(${githubSyncState.lastCheckRunId}, 0), ${updates.lastCheckRunId})`;
    }
    try {
      await getDb()
        .update(githubSyncState)
        .set(set)
        .where(eq(githubSyncState.repo, repo));
    } catch (error) {
      logger.error(`Failed to update sync state for ${repo}:`, error);
    }
  }

  /**
   * Merge keys into the row's metadata JSON (2026-10-31). pollIssues and pollCommits each
   * parsed the snapshot taken at the start of pollRepo and wrote the whole blob back, so
   * pollCommits undid the lastIssueUpdatedAt that pollIssues had just saved.
   */
  private async mergeSyncMetadata(repo: string, patch: Record<string, unknown>): Promise<void> {
    let current: Record<string, unknown> = {};
    const state = await this.getSyncState(repo);
    if (state?.metadata) {
      try {
        current = JSON.parse(state.metadata);
      } catch {
        current = {};
      }
    }
    await this.updateSyncState(repo, { metadata: JSON.stringify({ ...current, ...patch }) });
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
      await getDb()
        .insert(githubRepoWatches)
        .values({
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
        .where(and(eq(githubRepoWatches.repo, repo), eq(githubRepoWatches.channelId, channelId)));
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
          and(eq(githubRepoWatches.guildId, guildId), eq(githubRepoWatches.channelId, channelId))
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
    throw new Error('GitHub poller service not initialized. Call initializeGitHubPoller first.');
  }
  return pollerInstance;
}
