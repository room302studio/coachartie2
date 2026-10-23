/**
 * Discord/Slack channel & environment context source builders extracted verbatim
 * from ContextAlchemy. These depend only on their arguments plus dynamically-imported
 * modules (database, capability registry) — no instance state — so they live here as
 * plain functions. Behavior is byte-for-byte identical to the original private
 * methods; do not change wording, queries, priorities, or token weights.
 */

import { logger } from '../../../shared/logger.js';
import { estimateTokens } from '../../../shared/text.js';
import type { IncomingMessage } from '../../../shared/queue/types.js';
import type { ContextSource } from './types.js';
import { DEBUG } from './types.js';

/**
 * Add recent messages from guild (Discord server)
 */
export async function addRecentGuildMessages(
  message: IncomingMessage,
  sources: ContextSource[]
): Promise<void> {
  try {
    // Only process if we have Discord context with guildId
    if (!message.context?.guildId) {
      return;
    }

    const guildId = message.context.guildId;
    if (DEBUG) {
      logger.info(`📨 Fetching recent guild messages for guild: ${guildId}`);
    }

    // Import database dynamically
    const { database } = await import('../../memory/sync-db.js');

    // Fetch recent messages from this guild (deduplicated)
    const recentGuildMessages = await database.all(
      `
        SELECT value, user_id, created_at
        FROM messages
        WHERE guild_id = ?
          AND user_id != ?
        ORDER BY created_at DESC
        LIMIT 5
      `,
      [guildId, message.userId]
    );

    if (recentGuildMessages && recentGuildMessages.length > 0) {
      const content = `Recent guild activity:\n${recentGuildMessages
        .map((m: any) => `[${m.user_id}]: ${m.value.substring(0, 200)}`)
        .join('\n')}`;

      sources.push({
        name: 'guild_context',
        priority: 60, // Lower than direct memories but still relevant
        tokenWeight: estimateTokens(content),
        content,
        category: 'memory',
      });

      if (DEBUG) {
        logger.info(`│ ✅ Found ${recentGuildMessages.length} recent guild messages`);
      }
    }
  } catch (error) {
    logger.warn('Failed to add recent guild messages:', error);
    // Graceful degradation - continue without guild context
  }
}

/**
 * Add channel vibes - the social context of the room
 * Helps the LLM understand channel activity, type, and adjust response style
 * Works for both Discord and Slack
 */
export async function addChannelVibes(
  message: IncomingMessage,
  sources: ContextSource[]
): Promise<void> {
  try {
    // Only for Discord or Slack messages with context
    const messageContext = message.context;
    if (
      !messageContext ||
      (message.source !== 'discord' &&
        message.source !== 'slack' &&
        messageContext.platform !== 'slack')
    ) {
      return;
    }

    // Import database for recent activity check
    const { database } = await import('../../memory/sync-db.js');

    const channelId = messageContext.channelId;
    const channelName = messageContext.channelName || messageContext.channelId || 'unknown';
    const channelType = messageContext.channelType || 'text';
    const platform =
      message.source === 'slack' || messageContext.platform === 'slack' ? 'Slack' : 'Discord';

    // Get recent activity in this channel (last 10 minutes)
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const recentActivity = await database.all(
      `SELECT COUNT(*) as count FROM messages
         WHERE channel_id = ? AND created_at > ?`,
      [channelId, tenMinutesAgo]
    );

    // Get Artie's recent usage in this channel (last hour)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const artieUsage = await database.all(
      `SELECT COUNT(*) as count FROM messages
         WHERE channel_id = ? AND created_at > ? AND user_id = 'artie'`,
      [channelId, oneHourAgo]
    );

    const messageCount = recentActivity[0]?.count || 0;
    const artieCount = artieUsage[0]?.count || 0;

    // Determine channel activity level
    let activityLevel = 'quiet';
    if (messageCount > 20) activityLevel = 'very busy';
    else if (messageCount > 10) activityLevel = 'busy';
    else if (messageCount > 3) activityLevel = 'moderate';

    // Build vibes context (ONLY dynamic channel-specific info)
    // Static delivery instructions belong in PROMPT_SYSTEM database prompt
    const vibes = [
      `CHANNEL CONTEXT:`,
      `- Platform: ${platform}`,
      `- Name: ${channelName}`,
      `- Type: ${channelType}`,
      `- Activity: ${activityLevel} (${messageCount} msgs in last 10 min)`,
      `- Your recent usage: ${artieCount} responses in last hour`,
    ];

    const content = vibes.join('\n');

    sources.push({
      name: 'channel_vibes',
      priority: 95, // High priority - affects response style
      tokenWeight: estimateTokens(content),
      content,
      category: 'user_state',
    });

    if (DEBUG) {
      logger.info(
        `│ ✅ Channel vibes (${platform}): ${channelName} (${activityLevel}, ${messageCount} recent msgs)`
      );
    }
  } catch (error) {
    logger.warn('Failed to add channel vibes:', error);
    // Graceful degradation - continue without vibes
  }
}

/** Digests older than this are history, not "what's going on" — leave them out. */
const DIGEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Add the channel's rolling digest (shared/services/channel-digest-store.ts): the cheap
 * summary of what's been happening here between the times Artie is addressed. Read
 * directly by channel id, never through memory recall.
 */
export async function addChannelDigest(
  message: IncomingMessage,
  sources: ContextSource[]
): Promise<void> {
  try {
    const channelId = message.context?.channelId;
    if (!channelId || message.source !== 'discord') return;

    const { getChannelDigest, digestAge } = await import('../../../shared/db/channel-digest-store.js');
    const d = getChannelDigest(channelId);
    if (!d || !d.digest.trim()) return;
    if (Date.now() - new Date(d.updatedAt).getTime() > DIGEST_MAX_AGE_MS) return;

    const content =
      `WHAT'S BEEN GOING ON IN #${d.channelName} (your notes from ${digestAge(d.updatedAt)}; ` +
      `the live transcript below is newer and wins):\n${d.digest}`;

    sources.push({
      name: 'channel_digest',
      priority: 90, // above recalled memories (70): this is the room's current picture
      tokenWeight: estimateTokens(content),
      content,
      category: 'user_state',
    });
  } catch (error) {
    logger.warn('Failed to add channel digest:', error);
  }
}

/**
 * Add recent messages from channel
 */
export async function addRecentChannelMessages(
  message: IncomingMessage,
  sources: ContextSource[]
): Promise<void> {
  try {
    // Only process if we have Discord context with channelId
    const channelId = message.context?.channelId || message.respondTo?.channelId;
    if (!channelId) {
      return;
    }

    if (DEBUG) {
      logger.info(`📨 Fetching recent channel messages for channel: ${channelId}`);
    }

    // Import database dynamically
    const { database } = await import('../../memory/sync-db.js');

    // Fetch recent messages from this channel (deduplicated)
    const recentChannelMessages = await database.all(
      `
        SELECT value, user_id, created_at
        FROM messages
        WHERE channel_id = ?
          AND user_id != ?
        ORDER BY created_at DESC
        LIMIT 10
      `,
      [channelId, message.userId]
    );

    if (recentChannelMessages && recentChannelMessages.length > 0) {
      const content = `Recent channel conversation:\n${recentChannelMessages
        .map((m: any) => `[${m.user_id}]: ${m.value.substring(0, 300)}`)
        .join('\n')}`;

      sources.push({
        name: 'channel_context',
        priority: 80, // Higher priority as it's more immediate context
        tokenWeight: estimateTokens(content),
        content,
        category: 'memory',
      });

      if (DEBUG) {
        logger.info(`│ ✅ Found ${recentChannelMessages.length} recent channel messages`);
      }
    }
  } catch (error) {
    logger.warn('Failed to add recent channel messages:', error);
    // Graceful degradation - continue without channel context
  }
}

/**
 * Add capability manifest to message context (COMPRESSED format - saves ~800 tokens!)
 */
export async function addCapabilityManifest(sources: ContextSource[]): Promise<void> {
  try {
    // Use COMPRESSED format: saves ~800 tokens vs full instructions
    // Lists capabilities concisely with format shown once
    const { capabilityRegistry } = await import('../../5-tool-loop/registry.js');
    const content = capabilityRegistry.generateCompressedInstructions();

    sources.push({
      name: 'capability_context',
      // High priority, despite reading like optional context. This source's content is
      // concatenated into the FIRST system message, which is the prompt-cache breakpoint.
      // At priority 30 a budget squeeze could drop it, which both removes the capability
      // roster AND changes the cached prefix's bytes — a budget-dependent value inside a
      // byte-exact prefix. Keep it in, or caching silently stops paying off under load.
      priority: 96,
      tokenWeight: estimateTokens(content),
      content,
      category: 'capabilities',
    });

    const capCount = capabilityRegistry.size();
    if (DEBUG) {
      logger.info(
        `│ ✅ Added COMPRESSED capability instructions (${capCount} capabilities, ${content.length} chars, saved ~800 tokens)`
      );
    }
  } catch (error) {
    logger.warn('Failed to add capability manifest:', error);
    // Graceful fallback to minimal instructions - use SIMPLE syntax
    const content = `Simple shortcuts: <read>path</read>, <recall>query</recall>, <websearch>query</websearch>, <calc>2+2</calc>`;
    sources.push({
      name: 'capability_context',
      priority: 30,
      tokenWeight: estimateTokens(content),
      content,
      category: 'capabilities',
    });
  }
}

/**
 * Add Discord environment context - available servers and their IDs
 * This helps Coach Artie understand what Discord servers it's connected to
 */
export async function addDiscordEnvironment(sources: ContextSource[]): Promise<void> {
  try {
    // Fetch Discord health info from the health server
    // Use DISCORD_HEALTH_URL env var, fallback to localhost for local dev, docker hostname for containers
    const discordHealthUrl =
      process.env.DISCORD_HEALTH_URL ||
      (process.env.DOCKER_ENV ? 'http://discord:47321/health' : 'http://localhost:47321/health');
    const response = await fetch(discordHealthUrl);
    if (!response.ok) {
      if (DEBUG) {
        logger.info('│ ⚠️  Discord health endpoint not available');
      }
      return;
    }

    const health = (await response.json()) as any; // Type as any for flexible health response
    if (!health?.discord?.guildDetails || health.discord.guildDetails.length === 0) {
      if (DEBUG) {
        logger.info('│ ⚠️  No Discord guild details available');
      }
      return;
    }

    // Format guild info for token efficiency: Name (ID: xxx)
    const guildInfo = health.discord.guildDetails
      .map((g: any) => `${g.name} (ID: ${g.id})`)
      .join(', ');

    const content = `Connected Discord servers: ${guildInfo}`;

    sources.push({
      name: 'discord_environment',
      priority: 50, // Between capabilities and memories
      tokenWeight: estimateTokens(content),
      content,
      category: 'user_state',
    });

    if (DEBUG) {
      logger.info(
        `│ ✅ Added Discord environment: ${health.discord.guildDetails.length} servers`
      );
    }
  } catch (error) {
    logger.warn('Failed to add Discord environment:', error);
    // Graceful degradation - continue without Discord environment
  }
}
