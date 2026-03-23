/**
 * GitHub Event Processor
 *
 * Processes raw GitHub events from the poller:
 * - Batches rapid-fire events (e.g., multiple comments in quick succession)
 * - Filters out unwanted events (bot PRs, drafts, etc.)
 * - Resolves GitHub usernames to Discord users for mentions
 * - Enriches events with additional context
 */

import {
  logger,
  getDb,
  githubIdentityMappings,
  type GithubIdentityMapping,
  eq,
} from '@coachartie/shared';
import type { GitHubSyncEvent, GitHubEventType } from './github-poller.js';

// Bot usernames to filter out (excludes Copilot since those are human-initiated)
const BOT_USERNAMES = [
  'dependabot',
  'dependabot[bot]',
  'renovate',
  'renovate[bot]',
  'github-actions',
  'github-actions[bot]',
  'codecov',
  'codecov[bot]',
  'semantic-release-bot',
  'greenkeeper',
  'greenkeeper[bot]',
  'snyk-bot',
  'imgbot',
  'imgbot[bot]',
];

// Event types that should trigger mentions
const MENTION_EVENTS: GitHubEventType[] = [
  'pr_ready_for_review',
  'pr_changes_requested',
  'pr_approved',
  'ci_failure',
  'pr_review_requested',
  'issue_assigned',
];

export interface ProcessedEvent {
  event: GitHubSyncEvent;
  shouldPost: boolean;
  skipReason?: string;
  mentions: DiscordMention[];
  batchKey?: string;
  priority: number;
}

export interface DiscordMention {
  type: 'user' | 'role';
  id: string;
  reason: string;
}

export interface BatchedEvents {
  batchKey: string;
  events: ProcessedEvent[];
  summary: string;
  channelId: string;
  guildId: string;
}

export interface ProcessorConfig {
  batchWindowMs: number; // How long to wait before posting batched events
  maxBatchSize: number; // Max events in a single batch
  filterBots: boolean;
  filterDrafts: boolean;
  minConfidenceForMention: number; // Min confidence score to @ mention a user
}

const DEFAULT_CONFIG: ProcessorConfig = {
  batchWindowMs: 15 * 60 * 1000, // 15 minutes (longer window to reduce noise)
  maxBatchSize: 10,
  filterBots: true,
  filterDrafts: true,
  minConfidenceForMention: 0.7,
};

/**
 * GitHub Event Processor
 */
export class GitHubEventProcessor {
  private config: ProcessorConfig;
  private pendingBatches: Map<string, ProcessedEvent[]> = new Map();
  private batchTimers: Map<string, NodeJS.Timeout> = new Map();
  // Dedup: track recently posted events to prevent duplicates across poller cycles
  private recentEvents: Map<string, number> = new Map(); // eventKey -> timestamp
  private static readonly DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

  constructor(config: Partial<ProcessorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Process a raw GitHub event
   * Returns processed event with filtering/enrichment applied
   */
  async processEvent(event: GitHubSyncEvent): Promise<ProcessedEvent> {
    const processed: ProcessedEvent = {
      event,
      shouldPost: true,
      mentions: [],
      priority: this.calculatePriority(event),
    };

    // Dedup check (prevents duplicate posts across poll cycles and webhook+poller overlap)
    if (this.isDuplicate(event)) {
      processed.shouldPost = false;
      processed.skipReason = 'Duplicate event (already posted recently)';
      return processed;
    }

    // Filter checks
    if (this.config.filterBots && this.isBotEvent(event)) {
      processed.shouldPost = false;
      processed.skipReason = 'Bot-generated event';
      return processed;
    }

    // Draft PRs: don't post individually, queue for daily digest
    if (event.type === 'pr_draft' || (this.config.filterDrafts && event.data.prDraft)) {
      processed.shouldPost = false;
      processed.skipReason = 'draft_digest';
      return processed;
    }

    // Filter merges to non-main/beta branches (these are PR-to-PR merges, not deploys)
    if (event.type === 'pr_merged') {
      const targetBranch = event.data.prBaseBranch?.toLowerCase() || '';
      const isMainMerge = ['main', 'master', 'beta', 'production', 'prod'].includes(targetBranch);
      if (!isMainMerge) {
        processed.shouldPost = false;
        processed.skipReason = `Merge to feature branch (${event.data.prBaseBranch})`;
        return processed;
      }
    }

    // Filter CI success events (too noisy, only failures are actionable)
    if (event.type === 'ci_success') {
      processed.shouldPost = false;
      processed.skipReason = 'CI success events disabled (only failures shown)';
      return processed;
    }

    // Filter PR closed events (abandoned PRs are rarely interesting)
    // Merged PRs are handled by pr_merged, this is only for closed-without-merge
    if (event.type === 'pr_closed') {
      processed.shouldPost = false;
      processed.skipReason = 'PR closed without merge (abandoned)';
      return processed;
    }

    // Resolve mentions
    processed.mentions = await this.resolveMentions(event);

    // Determine batch key for grouping
    processed.batchKey = this.getBatchKey(event);

    return processed;
  }

  /**
   * Add event to batch and return batched events when ready
   */
  async addToBatch(
    processed: ProcessedEvent,
    onBatchReady: (batch: BatchedEvents) => void
  ): Promise<void> {
    if (!processed.shouldPost) {
      return;
    }

    const batchKey = processed.batchKey || this.getDefaultBatchKey(processed.event);

    // Get or create batch
    let batch = this.pendingBatches.get(batchKey);
    if (!batch) {
      batch = [];
      this.pendingBatches.set(batchKey, batch);
    }

    batch.push(processed);

    // Clear existing timer for this batch
    const existingTimer = this.batchTimers.get(batchKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Check if batch is full
    if (batch.length >= this.config.maxBatchSize) {
      this.flushBatch(batchKey, onBatchReady);
      return;
    }

    // Set timer to flush batch
    const timer = setTimeout(() => {
      this.flushBatch(batchKey, onBatchReady);
    }, this.config.batchWindowMs);

    this.batchTimers.set(batchKey, timer);
  }

  /**
   * Flush a batch and call the callback
   */
  private flushBatch(batchKey: string, onBatchReady: (batch: BatchedEvents) => void): void {
    const events = this.pendingBatches.get(batchKey);
    if (!events || events.length === 0) {
      return;
    }

    // Clear batch
    this.pendingBatches.delete(batchKey);
    const timer = this.batchTimers.get(batchKey);
    if (timer) {
      clearTimeout(timer);
      this.batchTimers.delete(batchKey);
    }

    // Create batched event
    const batch: BatchedEvents = {
      batchKey,
      events,
      summary: this.createBatchSummary(events),
      channelId: events[0].event.channelId,
      guildId: events[0].event.guildId,
    };

    logger.info(`Flushing batch ${batchKey} with ${events.length} events`);
    onBatchReady(batch);
  }

  /**
   * Flush all pending batches (e.g., on shutdown)
   */
  flushAll(onBatchReady: (batch: BatchedEvents) => void): void {
    for (const batchKey of this.pendingBatches.keys()) {
      this.flushBatch(batchKey, onBatchReady);
    }
  }

  /**
   * Check if event is from a bot
   */
  private isBotEvent(event: GitHubSyncEvent): boolean {
    const author = event.data.prAuthor || event.data.commentAuthor || event.data.reviewAuthor || event.data.issueAuthor || '';

    return BOT_USERNAMES.some((bot) => author.toLowerCase() === bot.toLowerCase());
  }

  /**
   * Generate a unique key for dedup tracking
   */
  private getDedupeKey(event: GitHubSyncEvent): string {
    if (event.data.commitSha) {
      return `${event.type}:${event.repo}:commit-${event.data.commitSha}`;
    }
    if (event.data.issueNumber) {
      return `${event.type}:${event.repo}:issue-${event.data.issueNumber}`;
    }
    if (event.data.prNumber) {
      return `${event.type}:${event.repo}:pr-${event.data.prNumber}`;
    }
    if (event.data.commentId) {
      return `${event.type}:${event.repo}:comment-${event.data.commentId}`;
    }
    return `${event.type}:${event.repo}:${event.timestamp}`;
  }

  /**
   * Check if event was recently posted (dedup)
   */
  private isDuplicate(event: GitHubSyncEvent): boolean {
    const key = this.getDedupeKey(event);
    const now = Date.now();

    // Clean up old entries
    for (const [k, ts] of this.recentEvents) {
      if (now - ts > GitHubEventProcessor.DEDUP_WINDOW_MS) {
        this.recentEvents.delete(k);
      }
    }

    if (this.recentEvents.has(key)) {
      return true;
    }
    this.recentEvents.set(key, now);
    return false;
  }

  /**
   * Calculate event priority (higher = more important)
   */
  private calculatePriority(event: GitHubSyncEvent): number {
    const priorities: Record<GitHubEventType, number> = {
      pr_merged: 10,
      ci_failure: 9,
      pr_changes_requested: 8,
      pr_approved: 7,
      pr_ready_for_review: 6,
      pr_opened: 5,
      pr_review: 4,
      pr_comment: 3,
      ci_success: 2,
      pr_closed: 1,
      pr_stale: 1, // Disabled feature, kept for type compatibility
      issue_opened: 6,
      issue_closed: 4,
      issue_comment: 3,
      issue_labeled: 3,
      issue_assigned: 5,
      pr_review_requested: 7,
      pr_draft: 2,
      push: 5,
    };

    let priority = priorities[event.type] || 5;

    // Boost priority for merges to main
    if (event.type === 'pr_merged' && event.data.prBaseBranch === 'main') {
      priority += 5;
    }

    return priority;
  }

  /**
   * Get batch key for grouping related events
   */
  private getBatchKey(event: GitHubSyncEvent): string {
    // Comments on the same PR should batch together
    if (event.type === 'pr_comment' && event.data.prNumber) {
      return `comments:${event.repo}:${event.data.prNumber}`;
    }

    // CI events for the same repo should batch
    if (event.type === 'ci_success' || event.type === 'ci_failure') {
      return `ci:${event.repo}`;
    }

    // Reviews on the same PR should batch
    if (
      (event.type === 'pr_review' ||
        event.type === 'pr_approved' ||
        event.type === 'pr_changes_requested') &&
      event.data.prNumber
    ) {
      return `reviews:${event.repo}:${event.data.prNumber}`;
    }

    // Issue comments on the same issue batch together
    if (event.type === 'issue_comment' && event.data.issueNumber) {
      return `issue-comments:${event.repo}:${event.data.issueNumber}`;
    }

    // Multiple issues opened in the same poll cycle batch together
    if (event.type === 'issue_opened') {
      return `issues:${event.repo}`;
    }

    // Multiple issues closed in the same poll cycle batch together
    if (event.type === 'issue_closed') {
      return `issues-closed:${event.repo}`;
    }

    // Pushes batch together per repo
    if (event.type === 'push') {
      return `push:${event.repo}`;
    }

    // Label changes batch together per issue
    if (event.type === 'issue_labeled' && event.data.issueNumber) {
      return `labels:${event.repo}:${event.data.issueNumber}`;
    }

    // Assignments are individual (important to see each one)
    if (event.type === 'issue_assigned') {
      return `assign:${event.repo}:${event.data.issueNumber}:${event.data.assignee}`;
    }

    // Review requests are individual
    if (event.type === 'pr_review_requested') {
      return `review-req:${event.repo}:${event.data.prNumber}`;
    }

    // Default: no batching
    return `single:${event.repo}:${event.type}:${Date.now()}`;
  }

  /**
   * Get default batch key (fallback)
   */
  private getDefaultBatchKey(event: GitHubSyncEvent): string {
    return `default:${event.repo}:${event.channelId}:${Date.now()}`;
  }

  /**
   * Create summary text for a batch of events
   */
  private createBatchSummary(events: ProcessedEvent[]): string {
    if (events.length === 1) {
      return this.getEventSummary(events[0].event);
    }

    const firstEvent = events[0].event;

    // Comments batch
    if (firstEvent.type === 'pr_comment') {
      const authors = [...new Set(events.map((e) => e.event.data.commentAuthor))];
      return `${events.length} new comments on PR #${firstEvent.data.prNumber} from ${authors.join(', ')}`;
    }

    // CI batch
    if (firstEvent.type === 'ci_success' || firstEvent.type === 'ci_failure') {
      const successes = events.filter((e) => e.event.type === 'ci_success').length;
      const failures = events.filter((e) => e.event.type === 'ci_failure').length;
      if (failures > 0 && successes > 0) {
        return `CI: ${successes} passed, ${failures} failed`;
      } else if (failures > 0) {
        return `CI: ${failures} checks failed`;
      } else {
        return `CI: ${successes} checks passed`;
      }
    }

    // Reviews batch
    if (
      firstEvent.type === 'pr_review' ||
      firstEvent.type === 'pr_approved' ||
      firstEvent.type === 'pr_changes_requested'
    ) {
      const approved = events.filter((e) => e.event.type === 'pr_approved').length;
      const changesRequested = events.filter((e) => e.event.type === 'pr_changes_requested').length;
      const parts: string[] = [];
      if (approved > 0) parts.push(`${approved} approved`);
      if (changesRequested > 0) parts.push(`${changesRequested} requested changes`);
      return `PR #${firstEvent.data.prNumber}: ${parts.join(', ')}`;
    }

    // Issues batch
    if (firstEvent.type === 'issue_opened') {
      const authors = [...new Set(events.map((e) => e.event.data.issueAuthor))];
      return `${events.length} new issues opened by ${authors.join(', ')}`;
    }

    if (firstEvent.type === 'issue_closed') {
      return `${events.length} issues closed`;
    }

    // Issue comments batch
    if (firstEvent.type === 'issue_comment') {
      const authors = [...new Set(events.map((e) => e.event.data.commentAuthor))];
      return `${events.length} new comments on issue #${firstEvent.data.issueNumber} from ${authors.join(', ')}`;
    }

    return `${events.length} events for ${firstEvent.repo}`;
  }

  /**
   * Get summary text for a single event
   */
  private getEventSummary(event: GitHubSyncEvent): string {
    switch (event.type) {
      case 'pr_opened':
        return `New PR #${event.data.prNumber}: ${event.data.prTitle}`;
      case 'pr_ready_for_review':
        return `PR #${event.data.prNumber} ready for review`;
      case 'pr_merged':
        return `PR #${event.data.prNumber} merged to ${event.data.prBaseBranch}`;
      case 'pr_closed':
        return `PR #${event.data.prNumber} closed`;
      case 'pr_approved':
        return `PR #${event.data.prNumber} approved by ${event.data.reviewAuthor}`;
      case 'pr_changes_requested':
        return `Changes requested on PR #${event.data.prNumber} by ${event.data.reviewAuthor}`;
      case 'pr_comment':
        return `New comment on PR #${event.data.prNumber} by ${event.data.commentAuthor}`;
      case 'pr_review':
        return `Review on PR #${event.data.prNumber} by ${event.data.reviewAuthor}`;
      case 'ci_success':
        return `CI passed: ${event.data.checkRunName}`;
      case 'ci_failure':
        return `CI failed: ${event.data.checkRunName}`;
      case 'issue_opened':
        return `New issue #${event.data.issueNumber}: ${event.data.issueTitle}`;
      case 'issue_closed':
        return `Issue #${event.data.issueNumber} closed`;
      case 'issue_comment':
        return `Comment on issue #${event.data.issueNumber} by ${event.data.commentAuthor}`;
      case 'push':
        return `${event.data.commitCount || 1} commit${(event.data.commitCount || 1) > 1 ? 's' : ''} pushed by ${event.data.commitAuthor}`;
      case 'issue_labeled':
        return `Label \`${event.data.label}\` added to #${event.data.issueNumber}`;
      case 'issue_assigned':
        return `#${event.data.issueNumber} assigned to ${event.data.assignee}`;
      case 'pr_review_requested':
        return `Review requested on PR #${event.data.prNumber} from ${event.data.reviewers?.join(', ')}`;
      case 'pr_draft':
        return `Draft PR #${event.data.prNumber}: ${event.data.prTitle} (by ${event.data.prAuthor})`;
      default:
        return `GitHub event: ${event.type}`;
    }
  }

  /**
   * Resolve Discord mentions for an event
   */
  async resolveMentions(event: GitHubSyncEvent): Promise<DiscordMention[]> {
    const mentions: DiscordMention[] = [];

    // Only add mentions for certain event types
    if (!MENTION_EVENTS.includes(event.type)) {
      return mentions;
    }

    // Determine who to mention based on event type
    switch (event.type) {
      case 'pr_ready_for_review':
        // Mention reviewers if specified
        if (event.data.reviewers && event.data.reviewers.length > 0) {
          for (const reviewer of event.data.reviewers) {
            const discordUser = await this.resolveGitHubUser(reviewer);
            if (discordUser) {
              mentions.push({
                type: 'user',
                id: discordUser.discordUserId!,
                reason: 'Requested reviewer',
              });
            }
          }
        }
        break;

      case 'pr_changes_requested':
      case 'ci_failure':
        // Mention PR author
        if (event.data.prAuthor) {
          const discordUser = await this.resolveGitHubUser(event.data.prAuthor);
          if (discordUser) {
            mentions.push({
              type: 'user',
              id: discordUser.discordUserId!,
              reason: event.type === 'pr_changes_requested' ? 'Changes requested' : 'CI failed',
            });
          }
        }
        break;

      case 'pr_approved':
        // Mention PR author (good news!)
        if (event.data.prAuthor) {
          const discordUser = await this.resolveGitHubUser(event.data.prAuthor);
          if (discordUser) {
            mentions.push({
              type: 'user',
              id: discordUser.discordUserId!,
              reason: 'PR approved',
            });
          }
        }
        break;

      case 'pr_review_requested':
        // Mention requested reviewers
        if (event.data.reviewers && event.data.reviewers.length > 0) {
          for (const reviewer of event.data.reviewers) {
            const discordUser = await this.resolveGitHubUser(reviewer);
            if (discordUser) {
              mentions.push({
                type: 'user',
                id: discordUser.discordUserId!,
                reason: 'Review requested',
              });
            }
          }
        }
        break;

      case 'issue_assigned':
        // Mention the person who was assigned
        if (event.data.assignee) {
          const discordUser = await this.resolveGitHubUser(event.data.assignee);
          if (discordUser) {
            mentions.push({
              type: 'user',
              id: discordUser.discordUserId!,
              reason: 'Assigned to issue',
            });
          }
        }
        break;
    }

    return mentions;
  }

  /**
   * Resolve a GitHub username to a Discord user
   */
  async resolveGitHubUser(githubUsername: string): Promise<GithubIdentityMapping | null> {
    try {
      const results = await getDb()
        .select()
        .from(githubIdentityMappings)
        .where(eq(githubIdentityMappings.githubUsername, githubUsername.toLowerCase()))
        .limit(1);

      const mapping = results[0];

      // Check confidence threshold
      if (
        mapping &&
        mapping.discordUserId &&
        (mapping.confidence || 1) >= this.config.minConfidenceForMention
      ) {
        return mapping;
      }

      return null;
    } catch (error) {
      logger.error(`Failed to resolve GitHub user ${githubUsername}:`, error);
      return null;
    }
  }
}

// Singleton instance
let processorInstance: GitHubEventProcessor | null = null;

/**
 * Initialize the event processor
 */
export function initializeEventProcessor(config?: Partial<ProcessorConfig>): GitHubEventProcessor {
  processorInstance = new GitHubEventProcessor(config);
  logger.info('GitHub event processor initialized');
  return processorInstance;
}

/**
 * Get the event processor instance
 */
export function getEventProcessor(): GitHubEventProcessor {
  if (!processorInstance) {
    throw new Error('GitHub event processor not initialized. Call initializeEventProcessor first.');
  }
  return processorInstance;
}
