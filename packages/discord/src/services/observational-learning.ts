import { logger } from '@coachartie/shared';
import { Client, TextChannel, Message, Collection } from 'discord.js';
import fetch from 'node-fetch';
import { getGuildConfig, GUILD_CONFIGS, GuildType } from '../config/guild-whitelist.js';

/**
 * Observational Learning Service
 * Fetches recent messages from "watching" guilds and summarizes them to form passive memories
 * Uses Discord API to fetch message history instead of real-time batching
 */

interface ProcessedChannel {
  guildId: string;
  channelId: string;
  lastMessageId?: string;
  lastProcessedAt: Date;
}

export class ObservationalLearning {
  private static instance: ObservationalLearning;
  private client: Client | null = null;
  private processedChannels: Map<string, ProcessedChannel> = new Map();
  private processingTimer: NodeJS.Timeout | null = null;

  // Configuration
  private readonly MESSAGES_PER_FETCH = parseInt(process.env.OBSERVATION_MESSAGES_PER_FETCH || '50');
  private readonly PROCESS_INTERVAL_MS = parseInt(process.env.OBSERVATION_INTERVAL_MS || '300000'); // 5 minutes
  private readonly CAPABILITIES_URL = process.env.CAPABILITIES_URL || 'http://localhost:47324';

  private constructor() {
    // Constructor is private for singleton
  }

  static getInstance(): ObservationalLearning {
    if (!ObservationalLearning.instance) {
      ObservationalLearning.instance = new ObservationalLearning();
    }
    return ObservationalLearning.instance;
  }

  /**
   * Initialize with Discord client and start processing
   */
  initialize(client: Client): void {
    this.client = client;

    // Check for guilds that should be observed:
    // - All 'watching' type guilds
    // - 'working' guilds with proactiveAnswering enabled (learn from communities we help)
    const learningGuilds = Object.values(GUILD_CONFIGS).filter(
      g => g.type === 'watching' || (g.type === 'working' && g.proactiveAnswering)
    );

    if (learningGuilds.length > 0) {
      logger.info('👁️ Observational learning initialized', {
        learningGuilds: learningGuilds.map(g => g.name),
        messagesPerFetch: this.MESSAGES_PER_FETCH,
        intervalMs: this.PROCESS_INTERVAL_MS
      });

      // Start processing timer
      this.startProcessingTimer();

      // Do initial processing after a short delay
      setTimeout(() => this.processLearningGuilds(), 10000);
    } else {
      logger.info('👁️ No learning guilds configured, observational learning disabled');
    }
  }

  /**
   * Start the timer for periodic processing
   */
  private startProcessingTimer(): void {
    if (this.processingTimer) {
      clearInterval(this.processingTimer);
    }

    this.processingTimer = setInterval(async () => {
      await this.processLearningGuilds();
    }, this.PROCESS_INTERVAL_MS);
  }

  /**
   * Process all learning guilds (watching + working with proactiveAnswering)
   */
  private async processLearningGuilds(): Promise<void> {
    if (!this.client) {
      logger.warn('👁️ Cannot process learning guilds: Discord client not initialized');
      return;
    }

    const learningGuilds = Object.values(GUILD_CONFIGS).filter(
      g => g.type === 'watching' || (g.type === 'working' && g.proactiveAnswering)
    );

    for (const guildConfig of learningGuilds) {
      try {
        const guild = this.client.guilds.cache.get(guildConfig.id);
        if (!guild) {
          logger.debug(`👁️ Guild ${guildConfig.name} not in cache`);
          continue;
        }

        // Process text channels in the guild
        const textChannels = guild.channels.cache.filter(
          channel => channel.type === 0 && channel.viewable
        ) as Collection<string, TextChannel>;

        // Filter to only observation channels if configured
        const observationChannels = guildConfig.observationChannels || [];

        for (const [channelId, channel] of textChannels) {
          // If observationChannels is configured, only process those channels
          if (observationChannels.length > 0) {
            const isWhitelisted = observationChannels.some(
              c => channel.name.toLowerCase().includes(c.toLowerCase())
            );
            if (!isWhitelisted) {
              logger.debug(`👁️ Skipping #${channel.name} (not in observationChannels whitelist)`);
              continue;
            }
          }
          await this.processChannel(guild.id, guild.name, channel);
        }
      } catch (error) {
        logger.error(`👁️ Error processing guild ${guildConfig.name}:`, error);
      }
    }
  }

  /**
   * Process a single channel - fetch recent messages and summarize
   */
  private async processChannel(
    guildId: string,
    guildName: string,
    channel: TextChannel
  ): Promise<void> {
    const channelKey = `${guildId}-${channel.id}`;
    const processed = this.processedChannels.get(channelKey);

    try {
      // Fetch messages from Discord API
      const fetchOptions: { limit: number; before?: string } = {
        limit: this.MESSAGES_PER_FETCH
      };

      // If we've processed this channel before, fetch only new messages
      if (processed?.lastMessageId) {
        // Fetch messages after the last processed one
        const messages = await channel.messages.fetch({
          limit: this.MESSAGES_PER_FETCH,
          after: processed.lastMessageId
        });

        if (messages.size === 0) {
          logger.debug(`👁️ No new messages in ${guildName} #${channel.name}`);
          return;
        }

        await this.summarizeAndStore(
          messages,
          guildId,
          guildName,
          channel.id,
          channel.name
        );

        // Update last processed message
        const newestMessage = messages.first();
        if (newestMessage) {
          this.processedChannels.set(channelKey, {
            guildId,
            channelId: channel.id,
            lastMessageId: newestMessage.id,
            lastProcessedAt: new Date()
          });
        }
      } else {
        // First time processing this channel - fetch recent messages
        const messages = await channel.messages.fetch(fetchOptions);

        if (messages.size === 0) {
          logger.debug(`👁️ No messages in ${guildName} #${channel.name}`);
          return;
        }

        await this.summarizeAndStore(
          messages,
          guildId,
          guildName,
          channel.id,
          channel.name
        );

        // Store the newest message ID for next time
        const newestMessage = messages.first();
        if (newestMessage) {
          this.processedChannels.set(channelKey, {
            guildId,
            channelId: channel.id,
            lastMessageId: newestMessage.id,
            lastProcessedAt: new Date()
          });
        }
      }
    } catch (error) {
      logger.error(`👁️ Error processing channel ${channel.name}:`, error);
    }
  }

  /**
   * Summarize messages and store as observational memory
   */
  private async summarizeAndStore(
    messages: Collection<string, Message>,
    guildId: string,
    guildName: string,
    channelId: string,
    channelName: string
  ): Promise<void> {
    // Filter out bot messages and sort chronologically
    const humanMessages = messages
      .filter(m => !m.author.bot)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    if (humanMessages.size === 0) {
      logger.debug(`👁️ No human messages to process in ${guildName} #${channelName}`);
      return;
    }

    logger.info(`👁️ Processing ${humanMessages.size} messages from ${guildName} #${channelName}`);

    // Create conversation text
    const conversationText = humanMessages
      .map(m => `${m.author.username}: ${m.content.substring(0, 500)}`)
      .join('\n');

    // Create summary prompt
    const summaryPrompt = `Observe this Discord conversation from ${guildName} #${channelName} and extract key patterns:

Messages (${humanMessages.size} total):
${conversationText}

Summarize in 2-3 sentences:
1. Main topics or themes discussed
2. Any recurring questions or interests
3. Notable user behaviors or preferences

Focus on patterns that would help understand this community's needs and interests.`;

    try {
      // Call capabilities service to generate summary using FAST_MODEL
      const response = await fetch(`${this.CAPABILITIES_URL}/api/observe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: summaryPrompt,
          guildId,
          channelId,
          messageCount: humanMessages.size,
          timeRange: {
            start: humanMessages.last()?.createdAt.toISOString(),
            end: humanMessages.first()?.createdAt.toISOString()
          }
        })
      });

      if (response.ok) {
        const result = await response.json() as { summary: string; cost: number };
        logger.info(`👁️ Observation summary created (cost: $${result.cost?.toFixed(4)}): ${result.summary?.substring(0, 100)}...`);

        // Store as observational memory
        await this.storeObservationalMemory(
          guildName,
          channelName,
          result.summary,
          humanMessages.size
        );
      } else {
        logger.warn(`👁️ Failed to generate observation summary: ${response.statusText}`);
      }
    } catch (error) {
      logger.error('👁️ Error generating observation summary:', error);
    }
  }

  /**
   * Store the observation as a memory
   */
  private async storeObservationalMemory(
    guildName: string,
    channelName: string,
    summary: string,
    messageCount: number
  ): Promise<void> {
    try {
      // Call memory capability to store observation
      const memoryResponse = await fetch(`${this.CAPABILITIES_URL}/capabilities/registry/memory/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'remember',
          params: {
            content: `[Observation from ${guildName} #${channelName} (${messageCount} messages)] ${summary}`,
            userId: 'observational-system',
            importance: 2,
            tags: [
              'observation',
              'passive-learning',
              guildName.toLowerCase().replace(/\s+/g, '-'),
              channelName.toLowerCase().replace(/\s+/g, '-')
            ]
          }
        })
      });

      if (memoryResponse.ok) {
        logger.info(`👁️ Stored observational memory for ${guildName} #${channelName}`);
      } else {
        logger.warn(`👁️ Failed to store observational memory: ${memoryResponse.statusText}`);
      }
    } catch (error) {
      logger.error('👁️ Failed to store observational memory:', error);
    }
  }

  /**
   * Get statistics about current observations
   */
  getStats(): {
    processedChannels: number;
    learningGuilds: number;
    lastProcessedTimes: Array<{
      guild: string;
      channel: string;
      lastProcessed: Date;
    }>;
  } {
    const learningGuilds = Object.values(GUILD_CONFIGS).filter(
      g => g.type === 'watching' || (g.type === 'working' && g.proactiveAnswering)
    );

    const lastProcessedTimes = Array.from(this.processedChannels.values()).map(p => {
      const guildConfig = getGuildConfig(p.guildId);
      const channel = this.client?.channels.cache.get(p.channelId);
      return {
        guild: guildConfig?.name || p.guildId,
        channel: (channel && 'name' in channel ? channel.name : null) || p.channelId,
        lastProcessed: p.lastProcessedAt
      };
    });

    return {
      processedChannels: this.processedChannels.size,
      learningGuilds: learningGuilds.length,
      lastProcessedTimes
    };
  }

  /**
   * Cleanup and shutdown
   */
  shutdown(): void {
    if (this.processingTimer) {
      clearInterval(this.processingTimer);
      this.processingTimer = null;
    }
    logger.info('👁️ Observational learning shutdown complete');
  }
}

export const observationalLearning = ObservationalLearning.getInstance();