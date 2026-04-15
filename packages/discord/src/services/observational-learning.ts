import { logger, getSyncDb } from '@coachartie/shared';
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
  private readonly MESSAGES_PER_FETCH = parseInt(
    process.env.OBSERVATION_MESSAGES_PER_FETCH || '50'
  );
  private readonly PROCESS_INTERVAL_MS = parseInt(process.env.OBSERVATION_INTERVAL_MS || '1500000'); // 25 minutes
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
    // - 'working' guilds with observationChannels explicitly configured
    const learningGuilds = Object.values(GUILD_CONFIGS).filter(
      (g) =>
        g.type === 'watching' ||
        (g.type === 'working' && (g.proactiveAnswering || g.observationChannels !== undefined))
    );

    if (learningGuilds.length > 0) {
      logger.info('👁️ Observational learning initialized', {
        learningGuilds: learningGuilds.map((g) => g.name),
        messagesPerFetch: this.MESSAGES_PER_FETCH,
        intervalMs: this.PROCESS_INTERVAL_MS,
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
      (g) =>
        g.type === 'watching' ||
        (g.type === 'working' && (g.proactiveAnswering || g.observationChannels !== undefined))
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
          (channel) => channel.type === 0 && channel.viewable
        ) as Collection<string, TextChannel>;

        // Filter to only observation channels if configured
        const observationChannels = guildConfig.observationChannels || [];

        for (const [channelId, channel] of textChannels) {
          // If observationChannels is configured, only process those channels
          if (observationChannels.length > 0) {
            const isWhitelisted = observationChannels.some((c) =>
              channel.name.toLowerCase().includes(c.toLowerCase())
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
        limit: this.MESSAGES_PER_FETCH,
      };

      // If we've processed this channel before, fetch only new messages
      if (processed?.lastMessageId) {
        // Fetch messages after the last processed one
        const messages = await channel.messages.fetch({
          limit: this.MESSAGES_PER_FETCH,
          after: processed.lastMessageId,
        });

        if (messages.size === 0) {
          logger.debug(`👁️ No new messages in ${guildName} #${channel.name}`);
          return;
        }

        await this.summarizeAndStore(messages, guildId, guildName, channel.id, channel.name);

        // Update user profiles for anyone who spoke in this batch
        await this.updateUserProfiles(messages, guildId, guildName);

        // Update last processed message
        const newestMessage = messages.first();
        if (newestMessage) {
          this.processedChannels.set(channelKey, {
            guildId,
            channelId: channel.id,
            lastMessageId: newestMessage.id,
            lastProcessedAt: new Date(),
          });
        }
      } else {
        // First time processing this channel after boot - seed the cursor without summarizing
        // This prevents duplicate observations when PM2 restarts
        const messages = await channel.messages.fetch({ limit: 1 });

        if (messages.size === 0) {
          logger.debug(`👁️ No messages in ${guildName} #${channel.name}`);
          return;
        }

        const newestMessage = messages.first();
        if (newestMessage) {
          this.processedChannels.set(channelKey, {
            guildId,
            channelId: channel.id,
            lastMessageId: newestMessage.id,
            lastProcessedAt: new Date(),
          });
          logger.info(`👁️ Seeded cursor for ${guildName} #${channel.name} (will observe new messages from here)`);
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
      .filter((m) => !m.author.bot)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    if (humanMessages.size === 0) {
      logger.debug(`👁️ No human messages to process in ${guildName} #${channelName}`);
      return;
    }

    logger.info(`👁️ Processing ${humanMessages.size} messages from ${guildName} #${channelName}`);

    // Create conversation text
    const conversationText = humanMessages
      .map((m) => `${m.author.username}: ${m.content.substring(0, 500)}`)
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
            end: humanMessages.first()?.createdAt.toISOString(),
          },
        }),
      });

      if (response.ok) {
        const result = (await response.json()) as { summary: string; cost: number };
        logger.info(
          `👁️ Observation summary created (cost: $${result.cost?.toFixed(4)}): ${result.summary?.substring(0, 100)}...`
        );

        // Store as observational memory
        await this.storeObservationalMemory(
          guildId,
          guildName,
          channelId,
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
    guildId: string,
    guildName: string,
    channelId: string,
    channelName: string,
    summary: string,
    messageCount: number
  ): Promise<void> {
    try {
      // Call memory capability to store observation
      const memoryResponse = await fetch(
        `${this.CAPABILITIES_URL}/capabilities/registry/memory/execute`,
        {
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
                guildName.toLowerCase().split(' ').join('-'),
                channelName.toLowerCase().split(' ').join('-'),
              ],
              // Store guild/channel scope directly on the memory
              guildId,
              channelId,
            },
          }),
        }
      );

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
   * Update user profiles for everyone who spoke in a batch of messages.
   * Profiles are stored as memories with tag 'user-profile' — one per user per guild.
   */
  private async updateUserProfiles(
    messages: Collection<string, Message>,
    guildId: string,
    guildName: string
  ): Promise<void> {
    // Extract unique human users from this batch
    const users = new Map<string, { id: string; username: string; displayName: string }>();
    for (const [, msg] of messages) {
      if (!msg.author.bot && !users.has(msg.author.id)) {
        users.set(msg.author.id, {
          id: msg.author.id,
          username: msg.author.username,
          displayName: msg.author.displayName || msg.author.username,
        });
      }
    }

    if (users.size === 0) return;

    const db = getSyncDb();

    for (const [userId, user] of users) {
      try {
        // Get existing profile
        const existingProfile = db.get(
          `SELECT id, content FROM memories
           WHERE user_id = ? AND guild_id = ? AND tags LIKE '%user-profile%'
           ORDER BY updated_at DESC LIMIT 1`,
          [userId, guildId]
        ) as { id: number; content: string } | undefined;

        // Get recent memories about this user (last 10)
        // Search across all guilds — interaction memories often have no guild_id
        const recentMemories = db.all(
          `SELECT content FROM memories
           WHERE (user_id = ? OR content LIKE ?)
           AND tags NOT LIKE '%user-profile%'
           ORDER BY created_at DESC LIMIT 10`,
          [userId, `%${user.username}%`]
        ) as Array<{ content: string }>;

        // Get recent messages from this user in the current batch
        const userMessages = messages
          .filter((m) => m.author.id === userId)
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
          .map((m) => m.content.substring(0, 200));

        if (recentMemories.length === 0 && userMessages.length === 0) continue;

        // Build context for profile synthesis
        const memorySnippets = recentMemories
          .map((m) => m.content.substring(0, 200))
          .join('\n');

        const currentProfile = existingProfile?.content || '(no existing profile)';

        const profilePrompt = `You are Artie, a Discord bot. You keep a short mental note about each person you encounter — not a resume, more like what a bartender knows about a regular. The point is knowing how to act around them.

@${user.username} (display: ${user.displayName}) in ${guildName}

YOUR CURRENT NOTE:
${currentProfile}

MEMORIES INVOLVING THEM:
${memorySnippets || '(none)'}

THEIR RECENT MESSAGES:
${userMessages.join('\n') || '(none in this batch)'}

Update your note about this person. Write 2-4 lines, plain text, no bullets or formatting. Focus on:

WHO THEY ARE to this community (not their job title — their actual role: are they a leader? a helper? a lurker? someone who shows up with problems? someone who answers other people's questions?)

HOW TO ACT AROUND THEM. This is the important part. Have they ever told you to shut up, back off, or stop giving unsolicited input? Do they ask you questions directly? Do they seem to like having you around, or merely tolerate you? If you don't know, say so — don't default to "neutral."

WHAT THEY CARE ABOUT right now — not generic interests, but what they're actually working on or struggling with lately.

Rules:
- No preamble ("Here's the updated profile"). Just write the note.
- If the current note is still accurate and nothing meaningful changed, return UNCHANGED (literally that word, nothing else).
- Never invent details. "I don't know how they feel about me" is better than "neutral."
- Keep it under 400 characters.`;

        const response = await fetch(`${this.CAPABILITIES_URL}/api/observe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: profilePrompt,
            guildId,
            channelId: 'profile-synthesis',
            messageCount: userMessages.length,
          }),
        });

        if (!response.ok) continue;

        const result = (await response.json()) as { summary: string; cost: number };
        if (!result.summary) continue;

        // Skip if LLM says nothing changed
        if (result.summary.trim().toUpperCase() === 'UNCHANGED') {
          logger.debug(`👤 Profile unchanged for @${user.username} in ${guildName}`);
          continue;
        }

        const profileContent = `@${user.username} in ${guildName}: ${result.summary}`;

        if (existingProfile) {
          // Update existing profile
          db.run(
            `UPDATE memories SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [profileContent, existingProfile.id]
          );
          logger.info(`👤 Updated profile for @${user.username} in ${guildName}`);
        } else {
          // Create new profile
          db.run(
            `INSERT INTO memories (user_id, content, tags, context, timestamp, importance, guild_id, metadata)
             VALUES (?, ?, ?, ?, datetime('now'), 8, ?, ?)`,
            [
              userId,
              profileContent,
              JSON.stringify(['user-profile', guildName.toLowerCase().replace(/\s+/g, '-')]),
              `Profile for @${user.username} in ${guildName}`,
              guildId,
              JSON.stringify({ username: user.username, displayName: user.displayName, profileVersion: 1 }),
            ]
          );
          logger.info(`👤 Created profile for @${user.username} in ${guildName}`);
        }
      } catch (error) {
        logger.warn(`👤 Failed to update profile for @${user.username}:`, error);
        // Non-fatal — continue with other users
      }
    }
  }

  /**
   * Get a user's profile for a given guild (used by proactive judgment)
   */
  static getUserProfile(userId: string, guildId: string): string | null {
    try {
      const db = getSyncDb();
      const profile = db.get(
        `SELECT content FROM memories
         WHERE user_id = ? AND guild_id = ? AND tags LIKE '%user-profile%'
         ORDER BY updated_at DESC LIMIT 1`,
        [userId, guildId]
      ) as { content: string } | undefined;
      return profile?.content || null;
    } catch {
      return null;
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
      (g) =>
        g.type === 'watching' ||
        (g.type === 'working' && (g.proactiveAnswering || g.observationChannels !== undefined))
    );

    const lastProcessedTimes = Array.from(this.processedChannels.values()).map((p) => {
      const guildConfig = getGuildConfig(p.guildId);
      const channel = this.client?.channels.cache.get(p.channelId);
      return {
        guild: guildConfig?.name || p.guildId,
        channel: (channel && 'name' in channel ? channel.name : null) || p.channelId,
        lastProcessed: p.lastProcessedAt,
      };
    });

    return {
      processedChannels: this.processedChannels.size,
      learningGuilds: learningGuilds.length,
      lastProcessedTimes,
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
