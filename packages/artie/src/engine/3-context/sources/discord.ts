/**
 * Discord/Slack channel & environment context source builders extracted verbatim
 * from ContextAlchemy. These depend only on their arguments plus dynamically-imported
 * modules (database) — no instance state — so they live here as
 * plain functions. Behavior is byte-for-byte identical to the original private
 * methods; do not change wording, queries, priorities, or token weights.
 */

import { logger } from '../../../shared/logger.js';
import { estimateTokens } from '../../../shared/async.js';
import type { IncomingMessage } from '../../../shared/queue/types.js';
import type { ContextSource } from './types.js';
import { DEBUG } from './types.js';
import * as gateway from '../../../gateway/api.js';

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
 * Where this turn is, as ids Artie can hand to his Discord tools (his ask, 2026-11-23: "I don't
 * know where I am": he couldn't react to, link or read around the message he was answering).
 * A deliberate addition to the otherwise verbatim channel block.
 */
export function whereLines(ctx: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const id = (value: unknown) => typeof value === 'string' && /^\d{15,22}$/.test(value);
  if (id(ctx.channelId)) {
    lines.push(`- Channel id: ${ctx.channelId} (the default for channel tools)`);
  }
  // Forum first: a forum post is also a thread whose parent is the forum.
  if (id(ctx.forumId)) {
    lines.push(`- This is a forum post in ${String(ctx.forumName || 'a forum')} (forum id ${ctx.forumId})`);
  } else if (id(ctx.parentChannelId)) {
    lines.push(`- This is a thread off #${String(ctx.parentChannelName || ctx.parentChannelId)} (id ${ctx.parentChannelId})`);
  }
  if (id(ctx.messageId)) {
    lines.push(`- The message you're answering: id ${ctx.messageId}`);
  }
  if (id(ctx.replyingTo)) {
    lines.push(`- It replies to message id ${ctx.replyingTo}`);
  }
  return lines;
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
    let platform: string;
    if (message.source === 'slack' || messageContext.platform === 'slack') {
      platform = 'Slack';
    } else {
      platform = 'Discord';
    }

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
      ...whereLines(messageContext),
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
 * Add Discord environment context - available servers and their IDs
 * This helps Coach Artie understand what Discord servers it's connected to
 */
export async function addDiscordEnvironment(sources: ContextSource[]): Promise<void> {
  try {
    // Fetch Discord health info from the health server. This always asked :47321/health,
    // which the gateway never served (its health server is :47319; DISCORD_HEALTH_URL is not
    // set in prod), so it returned early on a 404 every time and this source never reached a
    // prompt. Wave 9 keeps that exactly (gateway.unservedRoute) — wiring it to the real
    // health body would add a block to every prompt, a prompt change for its own wave.
    const response = await gateway.unservedRoute('GET', '/health');
    if (!gateway.isOk(response)) {
      if (DEBUG) {
        logger.info('│ ⚠️  Discord health endpoint not available');
      }
      return;
    }

    const health = response.body as any; // Type as any for flexible health response
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
