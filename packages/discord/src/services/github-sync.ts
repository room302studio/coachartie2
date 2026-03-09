/**
 * GitHub Sync Orchestrator
 *
 * Wires together the GitHub poller, event processor, and Discord poster.
 * This is the main entry point for the GitHub-Discord sync feature.
 */

import { Client } from 'discord.js';
import { logger, getDb, initializeDb, githubRepoWatches, eq } from '@coachartie/shared';
import {
  GitHubPollerService,
  initializeGitHubPoller,
  getGitHubPoller,
  type GitHubSyncEvent,
  type PollerConfig,
} from './github-poller.js';
import {
  GitHubEventProcessor,
  initializeEventProcessor,
  getEventProcessor,
  type ProcessorConfig,
  type BatchedEvents,
} from './github-event-processor.js';
import {
  GitHubDiscordPoster,
  initializeDiscordPoster,
  getDiscordPoster,
  type PosterConfig,
} from './github-discord-poster.js';
import { GUILD_CONFIGS } from '../config/guild-whitelist.js';

export interface GitHubSyncConfig {
  poller?: Partial<PollerConfig>;
  processor?: Partial<ProcessorConfig>;
  poster?: Partial<PosterConfig>;
  autoStart?: boolean;
}

const DEFAULT_CONFIG: GitHubSyncConfig = {
  autoStart: true,
};

/**
 * GitHub Sync Service
 * Orchestrates the full GitHub-Discord sync pipeline
 */
// Max events per poll cycle before triggering digest mode
// Raised to 5 - only trigger digest when there's truly a lot of activity
const MAX_EVENTS_BEFORE_DIGEST = 5;

export class GitHubSyncService {
  private client: Client;
  private poller: GitHubPollerService | null = null;
  private processor: GitHubEventProcessor | null = null;
  private poster: GitHubDiscordPoster | null = null;
  private config: GitHubSyncConfig;
  private isInitialized = false;
  private pollCycleEventCount = 0;
  private pollCycleEvents: GitHubSyncEvent[] = [];

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
    logger.info('GitHub sync service started');
  }

  /**
   * Stop the sync service
   */
  stop(): void {
    // Flush any pending batches
    if (this.processor && this.poster) {
      this.processor.flushAll((batch) => this.handleBatch(batch));
    }

    this.poller?.stop();
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
      logger.debug(`Event filtered: ${processed.skipReason}`);
      return;
    }

    // Track FILTERED events in this poll cycle for digest mode
    this.pollCycleEventCount++;
    this.pollCycleEvents.push(event);

    // If we've exceeded the threshold, we'll handle as digest at end of cycle
    if (this.pollCycleEventCount > MAX_EVENTS_BEFORE_DIGEST) {
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
          const overflow = prLinks.size > 5 ? ` +${prLinks.size - 5} more` : '';
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
  private handleBatch(batch: BatchedEvents): void {
    if (!this.poster) {
      logger.error('Poster not initialized');
      return;
    }

    this.poster.postBatch(batch).catch((err) => {
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
      pr_stale: { singular: 'stale PR', plural: 'stale PRs' },
    };

    const label = labels[type];
    if (label) {
      return count === 1 ? label.singular : label.plural;
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
    syncService.stop();
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
 * Check if GitHub sync is available
 */
export function isGitHubSyncAvailable(): boolean {
  return !!process.env.GITHUB_TOKEN;
}
