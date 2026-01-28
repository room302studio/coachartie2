/**
 * GitHub Sync Orchestrator
 *
 * Wires together the GitHub poller, event processor, and Discord poster.
 * This is the main entry point for the GitHub-Discord sync feature.
 */

import { Client } from 'discord.js';
import { logger, db } from '@coachartie/shared';
import { githubRepoWatches } from '@coachartie/shared/db/schema';
import { eq } from 'drizzle-orm';
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
export class GitHubSyncService {
  private client: Client;
  private poller: GitHubPollerService | null = null;
  private processor: GitHubEventProcessor | null = null;
  private poster: GitHubDiscordPoster | null = null;
  private config: GitHubSyncConfig;
  private isInitialized = false;

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

    // Process the event (filter, enrich, determine mentions)
    const processed = await this.processor.processEvent(event);

    if (!processed.shouldPost) {
      logger.debug(`Event filtered: ${processed.skipReason}`);
      return;
    }

    // Add to batch (will call handleBatch when ready)
    await this.processor.addToBatch(processed, (batch) => this.handleBatch(batch));
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
          const existing = await db
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
