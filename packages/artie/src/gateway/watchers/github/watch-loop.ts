/**
 * GitHub Sync Orchestrator
 *
 * Wires together the GitHub poller, event processor, and Discord poster.
 * This is the main entry point for the GitHub-Discord sync feature.
 */

import { Client } from 'discord.js';
import { logger } from '../../../shared/logger.js';
import { octokitLog } from './octokit-log.js';
import { getDb, initializeDb, eq } from '../../../shared/db/client.js';
import { githubRepoWatches } from '../../../shared/db/schema.js';
import {
  GitHubPollerService,
  initializeGitHubPoller,
  getGitHubPoller,
  type GitHubSyncEvent,
  type PollerConfig,
} from './poller.js';
import {
  GitHubEventProcessor,
  initializeEventProcessor,
  getEventProcessor,
  type ProcessorConfig,
  type BatchedEvents,
} from './event-batcher.js';
import {
  GitHubDiscordPoster,
  initializeDiscordPoster,
  getDiscordPoster,
  type PosterConfig,
} from './poster.js';
import { GUILD_CONFIGS } from '../../../shared/config/guilds.js';
import { readState, writeState } from '../../../shared/db/kv-state.js';
import { easternDayKey, easternHour, isEasternWeekend } from '../../../shared/eastern-day.js';

export interface GitHubSyncConfig {
  poller?: Partial<PollerConfig>;
  processor?: Partial<ProcessorConfig>;
  poster?: Partial<PosterConfig>;
  autoStart?: boolean;
}

const DEFAULT_CONFIG: GitHubSyncConfig = {
  autoStart: true,
};

function pluralS(count: number): string {
  if (count > 1) {
    return 's';
  }
  return '';
}

function overflowLabel(count: number, threshold: number): string {
  if (count > threshold) {
    return ` +${count - threshold} more`;
  }
  return '';
}

/**
 * GitHub Sync Service
 * Orchestrates the full GitHub-Discord sync pipeline
 */
// Max events per poll cycle before triggering digest mode
// Raised to 5 - only trigger digest when there's truly a lot of activity
const MAX_EVENTS_BEFORE_DIGEST = 5;

// How long shutdown waits for the final batch posts: leaves most of PM2's 12 s kill_timeout
// for the scribe sweep and the rest of teardown.
const SHUTDOWN_FLUSH_TIMEOUT_MS = 4000;

const DRAFT_DIGEST_TICK_MS = 5 * 60 * 1000;
const DRAFT_DIGEST_DAY_KEY = 'draft_digest_last_day';

export class GitHubSyncService {
  private client: Client;
  private poller: GitHubPollerService | null = null;
  private processor: GitHubEventProcessor | null = null;
  private poster: GitHubDiscordPoster | null = null;
  private config: GitHubSyncConfig;
  private isInitialized = false;
  private pollCycleEventCount = 0;
  private pollCycleEvents: GitHubSyncEvent[] = [];
  private draftQueue: GitHubSyncEvent[] = [];
  private draftDigestTimer: NodeJS.Timeout | null = null;

  constructor(client: Client, config: GitHubSyncConfig = {}) {
    this.client = client;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize all services and wire them together
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('GitHub sync service already initialized');
      return;
    }

    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
      logger.warn('GITHUB_TOKEN not set, GitHub sync disabled');
      return;
    }

    try {
      // Ensure database tables exist
      initializeDb();

      // Initialize components
      this.poller = initializeGitHubPoller(githubToken, this.config.poller);
      this.processor = initializeEventProcessor(this.config.processor);
      this.poster = initializeDiscordPoster(this.client, this.config.poster);

      // Wire up event flow
      this.poller.on('github-event', (event: GitHubSyncEvent) => {
        this.handleEvent(event).catch((err) => {
          logger.error('Error handling GitHub event:', err);
        });
      });

      // Handle end of poll cycle for digest mode
      this.poller.on('poll-cycle-end', () => {
        this.endPollCycle().catch((err) => {
          logger.error('Error ending poll cycle:', err);
        });
      });

      // Load watches from guild configs
      await this.loadGuildConfigWatches();

      this.isInitialized = true;
      logger.info('GitHub sync service initialized');

      // Auto-start if configured
      if (this.config.autoStart) {
        this.start();
      }
    } catch (error) {
      logger.error('Failed to initialize GitHub sync service:', error);
      throw error;
    }
  }

  /**
   * Start the sync service
   */
  start(): void {
    if (!this.isInitialized) {
      logger.error('Cannot start: GitHub sync service not initialized');
      return;
    }

    this.poller?.start();

    // Schedule daily draft digest at 9 AM ET
    this.scheduleDraftDigest();

    logger.info('GitHub sync service started');
  }

  /**
   * Schedule daily draft PR digest
   */
  private scheduleDraftDigest(): void {
    // A short tick plus a durable day key, like the studio digest (2026-10-31). The old hourly
    // interval was anchored to boot time and only posted if a tick happened to land in
    // 14:00-14:02 UTC, so after the 10-16 deploy it never fired again.
    this.draftDigestTimer = setInterval(() => {
      this.checkAndPostDraftDigest().catch((err) => logger.error('Draft digest error:', err));
    }, DRAFT_DIGEST_TICK_MS);

    // Also do an initial check for any existing open drafts
    setTimeout(() => this.collectOpenDrafts(), 30 * 1000);
  }

  /** Post the draft digest once per ET weekday, in the 9 AM hour. */
  async checkAndPostDraftDigest(now: Date = new Date()): Promise<void> {
    // Weekdays only: it's a work digest, and weekends are Artie's off days (EJ, 2026-10-31).
    if (isEasternWeekend(now)) {
      return;
    }
    const today = easternDayKey(now);
    if (easternHour(now) !== 9 || readState(DRAFT_DIGEST_DAY_KEY) === today) {
      return;
    }
    // Marked before posting: a crash mid-post skips a day rather than posting twice.
    writeState(DRAFT_DIGEST_DAY_KEY, today);
    await this.postDraftDigest();
  }

  /**
   * Collect currently open draft PRs from all watched repos
   */
  private async collectOpenDrafts(): Promise<void> {
    if (!this.poller) return;

    try {
      const db = getDb();
      const watches = await db.select().from(githubRepoWatches).where(eq(githubRepoWatches.isActive, true));

      for (const watch of watches) {
        const [owner, repo] = watch.repo.split('/');
        if (!owner || !repo) continue;

        const { Octokit } = await import('@octokit/rest');
        const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN, log: octokitLog });

        const { data: prs } = await octokit.pulls.list({
          owner, repo, state: 'open', per_page: 20,
        });

        for (const pr of prs) {
          if (!pr.draft) continue;

          // Add to draft queue if not already there
          const alreadyQueued = this.draftQueue.some(
            (e) => e.data.prNumber === pr.number && e.repo === watch.repo
          );
          if (!alreadyQueued) {
            this.draftQueue.push({
              type: 'pr_draft',
              repo: watch.repo,
              channelId: watch.channelId,
              guildId: watch.guildId,
              data: {
                prNumber: pr.number,
                prTitle: pr.title,
                prUrl: pr.html_url,
                prAuthor: pr.user?.login,
                prDraft: true,
              },
              timestamp: pr.created_at,
            });
          }
        }
      }

      if (this.draftQueue.length > 0) {
        console.log(`📝 Collected ${this.draftQueue.length} open draft PRs for daily digest`);
      }
    } catch (error) {
      logger.error('Failed to collect open drafts:', error);
    }
  }

  /**
   * Post the daily draft PR digest
   */
  private async postDraftDigest(): Promise<void> {
    if (this.draftQueue.length === 0) return;

    // Group by channel
    const byChannel = new Map<string, GitHubSyncEvent[]>();
    for (const event of this.draftQueue) {
      const existing = byChannel.get(event.channelId) || [];
      existing.push(event);
      byChannel.set(event.channelId, existing);
    }

    const { EmbedBuilder } = await import('discord.js');

    for (const [channelId, drafts] of byChannel) {
      const channel = this.client.channels.cache.get(channelId);
      if (!channel || !channel.isTextBased()) continue;

      // Dedupe by PR number
      const seen = new Set<number>();
      const uniqueDrafts = drafts.filter((d) => {
        if (seen.has(d.data.prNumber!)) return false;
        seen.add(d.data.prNumber!);
        return true;
      });

      const draftList = uniqueDrafts
        .map((d) => `• [#${d.data.prNumber}](${d.data.prUrl}) **${d.data.prTitle}** — ${d.data.prAuthor}`)
        .join('\n');

      const draftPluralS = pluralS(uniqueDrafts.length);
      const embed = new EmbedBuilder()
        .setColor(0x6e7681)
        .setTitle(`📝 ${uniqueDrafts.length} Draft PR${draftPluralS} In Progress`)
        .setDescription(draftList)
        .setFooter({ text: 'Daily draft digest — these PRs are being worked on' })
        .setTimestamp();

      try {
        await (channel as any).send({ embeds: [embed] });
        console.log(`📝 Posted draft digest: ${uniqueDrafts.length} drafts`);
      } catch (error) {
        logger.error('Failed to post draft digest:', error);
      }
    }

    // Refresh the queue (don't clear — re-collect tomorrow)
    this.draftQueue = [];
    // Re-collect open drafts for tomorrow's digest
    await this.collectOpenDrafts();
  }

  /**
   * Stop the sync service
   */
  async stop(timeoutMs = SHUTDOWN_FLUSH_TIMEOUT_MS): Promise<void> {
    this.poller?.stop();
    // Never cleared before (2026-10-31): a re-init left the old instance's digest timer running.
    if (this.draftDigestTimer) {
      clearInterval(this.draftDigestTimer);
      this.draftDigestTimer = null;
    }

    // Post what's still sitting in a batch window, and wait for the sends (2026-10-31). Nothing
    // called this on shutdown, and the cursors had already moved past these events, so every
    // deploy silently lost up to 15 minutes of feed. Capped so a stuck send can't hold up
    // PM2's 12 s kill_timeout.
    if (this.processor && this.poster) {
      const posts: Promise<void>[] = [];
      this.processor.flushAll((batch) => {
        posts.push(this.handleBatch(batch));
      });
      if (posts.length > 0) {
        let timer: NodeJS.Timeout | undefined;
        const cap = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            logger.warn(`GitHub shutdown flush hit its ${timeoutMs}ms cap; some batches may not have posted`);
            resolve();
          }, timeoutMs);
        });
        await Promise.race([Promise.allSettled(posts), cap]);
        clearTimeout(timer);
      }
    }

    logger.info('GitHub sync service stopped');
  }

  /**
   * Handle a single GitHub event
   */
  private async handleEvent(event: GitHubSyncEvent): Promise<void> {
    if (!this.processor || !this.poster) {
      logger.error('Processor or poster not initialized');
      return;
    }

    // IMPORTANT: Always filter events first, even in digest mode
    // This ensures bots, drafts, CI success, etc. are never shown
    const processed = await this.processor.processEvent(event);

    if (!processed.shouldPost) {
      // Queue draft PRs for daily digest instead of dropping them
      if (processed.skipReason === 'draft_digest') {
        this.draftQueue.push(event);
        console.log(`📝 Draft PR queued for digest: #${event.data.prNumber} ${event.data.prTitle}`);
      } else {
        logger.debug(`Event filtered: ${processed.skipReason}`);
      }
      return;
    }

    // Track FILTERED events in this poll cycle for digest mode
    this.pollCycleEventCount++;

    // If we've exceeded the threshold, we'll handle as digest at end of cycle. Only the overflow
    // goes in the digest (2026-10-31): events 1-5 already went to the batcher and post on their
    // own, and listing them in the digest too posted each of them twice.
    if (this.pollCycleEventCount > MAX_EVENTS_BEFORE_DIGEST) {
      this.pollCycleEvents.push(event);
      logger.debug(
        `Event ${this.pollCycleEventCount} queued for digest (threshold: ${MAX_EVENTS_BEFORE_DIGEST})`
      );
      return; // Don't process individually, will be digested
    }

    // Add to batch (will call handleBatch when ready)
    await this.processor.addToBatch(processed, (batch) => this.handleBatch(batch));
  }

  /**
   * Called at end of poll cycle - creates digest if too many events
   */
  async endPollCycle(): Promise<void> {
    if (this.pollCycleEventCount > MAX_EVENTS_BEFORE_DIGEST && this.pollCycleEvents.length > 0) {
      logger.info(`Poll cycle had ${this.pollCycleEventCount} events - creating digest summary`);
      await this.postDigest(this.pollCycleEvents);
    }

    // Reset counters
    this.pollCycleEventCount = 0;
    this.pollCycleEvents = [];
  }

  /**
   * Post a digest summary instead of individual events
   */
  private async postDigest(events: GitHubSyncEvent[]): Promise<void> {
    if (!this.poster || events.length === 0) return;

    // Group by repo
    const byRepo = new Map<string, GitHubSyncEvent[]>();
    for (const event of events) {
      const existing = byRepo.get(event.repo) || [];
      existing.push(event);
      byRepo.set(event.repo, existing);
    }

    // Create digest for each repo/channel
    for (const [repo, repoEvents] of byRepo) {
      const channelId = repoEvents[0].channelId;
      const channel = this.client.channels.cache.get(channelId);
      if (!channel || !channel.isTextBased()) continue;

      // Group events by type and collect links
      const byType = new Map<string, GitHubSyncEvent[]>();
      for (const e of repoEvents) {
        const existing = byType.get(e.type) || [];
        existing.push(e);
        byType.set(e.type, existing);
      }

      // Build summary with links
      const summaryParts: string[] = [];
      for (const [type, typeEvents] of byType) {
        const count = typeEvents.length;
        // Proper pluralization: "pr merged" → "PRs merged", "pr review" → "PR reviews"
        const typeLabel = this.formatEventTypeLabel(type, count);

        // Collect unique PR links for this type (dedupe by PR number)
        const prLinks = new Map<number, { url: string; title?: string }>();
        for (const e of typeEvents) {
          if (e.data.prNumber && e.data.prUrl) {
            prLinks.set(e.data.prNumber, {
              url: e.data.prUrl,
              title: e.data.prTitle,
            });
          }
        }

        if (prLinks.size > 0) {
          // Format with links: "2 pr reviews: #123, #124"
          const links = Array.from(prLinks.entries())
            .slice(0, 5) // Limit to 5 links to avoid spam
            .map(([prNum, { url }]) => `[#${prNum}](${url})`)
            .join(', ');
          const overflow = overflowLabel(prLinks.size, 5);
          summaryParts.push(`• ${count} ${typeLabel}: ${links}${overflow}`);
        } else {
          // No links available (e.g., CI events)
          summaryParts.push(`• ${count} ${typeLabel}`);
        }
      }

      const summary = summaryParts.join('\n');

      const { EmbedBuilder } = await import('discord.js');
      const embed = new EmbedBuilder()
        .setColor(0x6e7681)
        .setTitle(`📊 GitHub Activity Digest`)
        .setDescription(
          `**[${repo}](https://github.com/${repo})** had ${repoEvents.length} updates:\n\n${summary}`
        )
        .setFooter({ text: 'Digest mode - too many events to post individually' })
        .setTimestamp();

      try {
        await (channel as any).send({ embeds: [embed] });
        logger.info(`Posted digest for ${repo} with ${repoEvents.length} events`);
      } catch (error) {
        logger.error(`Failed to post digest for ${repo}:`, error);
      }
    }
  }

  /**
   * Handle a batch of events ready for posting
   */
  private handleBatch(batch: BatchedEvents): Promise<void> {
    if (!this.poster) {
      logger.error('Poster not initialized');
      return Promise.resolve();
    }

    // Returned so the shutdown flush can wait for it; normal callers still fire and forget.
    return this.poster.postBatch(batch).catch((err) => {
      logger.error('Error posting batch:', err);
    });
  }

  /**
   * Load watches from guild configuration (static config)
   */
  private async loadGuildConfigWatches(): Promise<void> {
    for (const [name, config] of Object.entries(GUILD_CONFIGS)) {
      if (!config.githubSync?.enabled || !config.githubSync.repos) {
        continue;
      }

      for (const repoConfig of config.githubSync.repos) {
        try {
          // Check if watch already exists
          const existing = await getDb()
            .select()
            .from(githubRepoWatches)
            .where(eq(githubRepoWatches.repo, repoConfig.repo))
            .limit(1);

          if (existing.length === 0) {
            await this.poller?.addWatch(
              repoConfig.repo,
              config.id,
              repoConfig.channelId,
              repoConfig.events || ['all'],
              'config'
            );
            logger.info(`Added watch from config: ${repoConfig.repo} for ${name}`);
          }
        } catch (error) {
          logger.error(`Failed to add watch from config for ${repoConfig.repo}:`, error);
        }
      }
    }
  }

  /**
   * Get service status
   */
  getStatus(): {
    initialized: boolean;
    running: boolean;
    watchCount: number;
  } {
    return {
      initialized: this.isInitialized,
      running: this.poller !== null,
      watchCount: 0, // Would need to query DB
    };
  }

  /**
   * Format event type label with proper pluralization
   */
  private formatEventTypeLabel(type: string, count: number): string {
    // Map event types to human-readable labels
    const labels: Record<string, { singular: string; plural: string }> = {
      pr_opened: { singular: 'new PR', plural: 'new PRs' },
      pr_ready_for_review: { singular: 'PR ready for review', plural: 'PRs ready for review' },
      pr_merged: { singular: 'PR merged', plural: 'PRs merged' },
      pr_closed: { singular: 'PR closed', plural: 'PRs closed' },
      pr_approved: { singular: 'approval', plural: 'approvals' },
      pr_changes_requested: { singular: 'changes requested', plural: 'changes requested' },
      pr_comment: { singular: 'comment', plural: 'comments' },
      pr_review: { singular: 'review', plural: 'reviews' },
      ci_success: { singular: 'CI passed', plural: 'CI passed' },
      ci_failure: { singular: 'CI failed', plural: 'CI failed' },
    };

    const label = labels[type];
    if (label) {
      if (count === 1) {
        return label.singular;
      }
      return label.plural;
    }

    // Fallback: just replace underscores with spaces
    return type.split('_').join(' ');
  }
}

// Singleton instance
let syncService: GitHubSyncService | null = null;

/**
 * Initialize the GitHub sync service
 */
export async function initializeGitHubSync(
  client: Client,
  config?: GitHubSyncConfig
): Promise<GitHubSyncService> {
  if (syncService) {
    logger.warn('GitHub sync service already exists, stopping old instance');
    await syncService.stop();
  }

  syncService = new GitHubSyncService(client, config);
  await syncService.initialize();
  return syncService;
}

/**
 * Get the GitHub sync service instance
 */
export function getGitHubSync(): GitHubSyncService {
  if (!syncService) {
    throw new Error('GitHub sync service not initialized');
  }
  return syncService;
}

/**
 * Stop the service if it ever started (shutdown path). Init is fire-and-forget at boot, so a
 * SIGTERM can arrive before there is anything to stop.
 */
export async function stopGitHubSync(): Promise<void> {
  if (!syncService) {
    return;
  }
  await syncService.stop();
}

/**
 * Check if GitHub sync is available
 */
export function isGitHubSyncAvailable(): boolean {
  return !!process.env.GITHUB_TOKEN;
}
