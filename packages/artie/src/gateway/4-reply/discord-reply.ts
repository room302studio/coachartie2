/**
 * Discord reply: the per-message delivery hooks stream-reply drives (respond = message.reply
 * then extra chunks, edit, delete, typing, reactions, threads, embeds, files), plus the warden
 * powers those hooks expose (timeouts, the Wheel of Fate). Moved verbatim out of
 * on-message.ts (wave 5): the closures used to live inline in handleMessageAsIntent.
 */

import { Message, EmbedBuilder, AttachmentBuilder, GuildMember } from 'discord.js';
import { delay } from '../../shared/async.js';
import { logger } from '../../shared/logger.js';
import { chunkMessage } from './chunks.js';
import { telemetry } from '../telemetry.js';
import { checkOutbound, isProtectedTimeoutTarget, SUBWAY_BUILDER_GUILD_ID } from './outbound-gate.js';
import { recordWheelVictim } from '../games/casino.js';

const CHUNK_RATE_LIMIT_DELAY = 200; // 200ms delay between message chunks

// Per-user cooldown for the warden timeout power (one mute per user / 5 min).
const timeoutCooldownCache = new Map<string, number>();

/** A mention-proxy reply (on-message's mention-proxy step) carries its rule and prefix. */
export interface ProxyOptions {
  isProxyResponse: boolean;
  proxyRule: any;
  proxyContext: string;
  proxyPrefix: string;
}

// WARDEN TIMEOUT helper: one set of guardrails for every path that times someone out
// (LLM [TIMEOUT] marker, antibody auto-timeout). The permission invariants (SB guild
// only, never bots/staff/protected users) live in the outbound gate; only the per-user
// cooldown stays here — that's rate-limiting, not permission.
const WARDEN_TIMEOUT_COOLDOWN_MS = 2 * 60 * 1000;
async function timeoutMember(
  member: GuildMember,
  seconds: number,
  reason: string,
  shortId: string
): Promise<boolean> {
  try {
    if (isProtectedTimeoutTarget(member)) {
      logger.warn(`🚧 Timeout refused: ${member.user.tag} is protected [${shortId}]`);
      return false;
    }
    const last = timeoutCooldownCache.get(member.id) || 0;
    if (Date.now() - last < WARDEN_TIMEOUT_COOLDOWN_MS) {
      logger.info(`Timeout skipped - per-user cooldown ${member.user.tag} [${shortId}]`);
      return false;
    }
    const ms = Math.min(300, Math.max(5, Math.floor(seconds || 30))) * 1000;
    await member.timeout(ms, reason || 'Coach Artie warden discipline');
    timeoutCooldownCache.set(member.id, Date.now());
    // warn, not info: prod console level is warn, and the vitals monitor counts this line
    logger.warn(`Timed out ${member.user.tag} for ${ms / 1000}s: ${reason} [${shortId}]`);
    return true;
  } catch (error) {
    logger.warn(`Failed to time out ${member.user.tag} [${shortId}]:`, error);
    return false;
  }
}

export async function wardenTimeout(
  message: Message,
  seconds: number,
  reason: string,
  shortId: string
): Promise<boolean> {
  if (!checkOutbound('timeout', message).allowed) return false; // gate logs the denial
  if (!message.member) return false; // gate guarantees this; kept for the type narrowing
  return timeoutMember(message.member, seconds, reason, shortId);
}

// WHEEL OF FATE — third-party roulette. Picks a victim from humans recently active in
// this channel (random, or fuzzy-matched by name), rolls 1-100, and on >50 boxes them
// for real. Victims didn't ante, so stakes are capped tighter than self-spins (120s)
// and every candidate is vetted through the same protection list as warden timeouts.
const WHEEL_ACTIVE_WINDOW_MS = 45 * 60 * 1000;
const WHEEL_MAX_STAKE_S = 120;
async function spinWheelOfFate(
  message: Message,
  seconds: number,
  targetName: string | undefined,
  shortId: string
): Promise<{ target: string | null; roll: number; boxed: boolean; landed: boolean; stake: number }> {
  const stake = Math.min(WHEEL_MAX_STAKE_S, Math.max(5, Math.floor(seconds || 60)));
  const miss = { target: null, roll: 0, boxed: false, landed: false, stake };
  try {
    // The wheel spins only where the reply gate already let Artie speak, and only in SB.
    if (message.guildId !== SUBWAY_BUILDER_GUILD_ID || !('messages' in message.channel)) {
      return miss;
    }
    const recent = await (message.channel as any).messages.fetch({ limit: 50 });
    const now = Date.now();
    const candidates = new Map<string, GuildMember>();
    for (const m of recent.values()) {
      if (!m.member || m.author.bot) continue;
      if (now - m.createdTimestamp > WHEEL_ACTIVE_WINDOW_MS) continue;
      if (isProtectedTimeoutTarget(m.member)) continue;
      candidates.set(m.author.id, m.member);
    }
    let target: GuildMember | undefined;
    if (targetName) {
      const q = targetName.toLowerCase().replace(/^@/, '').trim();
      target = [...candidates.values()].find(
        (mem) =>
          mem.user.username.toLowerCase().includes(q) ||
          (mem.displayName || '').toLowerCase().includes(q)
      );
    } else {
      const pool = [...candidates.values()];
      target = pool[Math.floor(Math.random() * pool.length)];
    }
    if (!target) return miss;

    const roll = Math.floor(Math.random() * 100) + 1;
    const boxed = roll > 50;
    let landed = false;
    if (boxed) {
      landed = await timeoutMember(
        target,
        stake,
        `Wheel of Fate — rolled ${roll}, ${stake}s`,
        shortId
      );
      if (landed) recordWheelVictim(target.id, target.user.username, stake);
    }
    return { target: target.displayName || target.user.username, roll, boxed, landed, stake };
  } catch (error) {
    logger.warn(`🎡 Wheel of Fate failed [${shortId}]:`, error);
    return miss;
  }
}

/**
 * The delivery hooks for one incoming message. `streamingMessage` is the first reply Artie
 * posted, shared by edit/delete and the feedback-correlation lookup.
 */
export function createDiscordReplyHandlers(
  message: Message,
  correlationId: string,
  shortId: string,
  proxyOptions?: ProxyOptions
) {
  let streamingMessage: Message | null = null;

  return {
    // Response handlers
    respond: async (content: string): Promise<void> => {
      // Check if LLM chose to stay silent — a leading [SILENT] counts even if
      // chatter follows, so a proxy prefix can never resurrect a silent reply
      const trimmedContent = content.trim();
      if (!trimmedContent || /^\[SILENT\]/i.test(trimmedContent)) {
        logger.info(`🤫 DISCORD: LLM chose to stay silent [${shortId}]`);
        return;
      }

      logger.info(`📨 DISCORD RESPOND [${shortId}]:`, {
        correlationId,
        contentLength: content.length,
        contentPreview: content.substring(0, 100),
        messageId: message.id,
        channelId: message.channelId,
        isProxy: proxyOptions?.isProxyResponse,
      });

      // Add proxy prefix if this is a proxy response
      const fullContent = proxyOptions?.proxyPrefix
        ? `${proxyOptions.proxyPrefix}${content}`
        : content;

      const chunks = chunkMessage(fullContent);
      if (!chunks) {
        // Previously this logged "Sending 0 chunks" and then threw on chunks[0].length.
        logger.warn(`🔇 DISCORD: Nothing to send — empty response [${shortId}]`);
        return;
      }
      logger.info(`📨 DISCORD: Sending ${chunks.length} chunks [${shortId}]`);

      const responseMessage = await message.reply(chunks[0]);
      logger.info(`✅ DISCORD: Sent first chunk (reply) [${shortId}]`, {
        responseMessageId: responseMessage.id,
        chunkLength: chunks[0].length,
      });

      // Store reference for potential editing
      if (!streamingMessage) {
        streamingMessage = responseMessage;
      }

      // Send additional chunks
      for (let i = 1; i < chunks.length; i++) {
        if ('send' in message.channel) {
          logger.info(`📨 DISCORD: Sending chunk ${i + 1}/${chunks.length} [${shortId}]`);
          await (message.channel as any).send(chunks[i]);
          await delay(CHUNK_RATE_LIMIT_DELAY);
        }
      }

      telemetry.incrementResponsesDelivered(message.author.id, chunks.length);
      logger.info(`✅ DISCORD: All ${chunks.length} chunks delivered [${shortId}]`);
    },

    // ENHANCED: Edit response capability for cleaner streaming
    editResponse: async (content: string) => {
      logger.info(`✏️ DISCORD EDIT RESPONSE [${shortId}]:`, {
        correlationId,
        contentLength: content.length,
        contentPreview: content.substring(0, 100),
        hasStreamingMessage: !!streamingMessage,
        streamingMessageId: streamingMessage?.id,
      });

      if (!streamingMessage) {
        logger.warn(`No streaming message to edit [${shortId}]`);
        return;
      }

      try {
        // Discord has 2000 char limit for edits too
        const truncatedContent =
          content.length > 2000 ? content.slice(0, 1997) + '...' : content;

        logger.info(`✏️ DISCORD: Editing message ${streamingMessage.id} [${shortId}]`);
        await streamingMessage.edit(truncatedContent);
        logger.info(`✅ DISCORD: Message edited successfully [${shortId}]`);

        telemetry.logEvent(
          'message_edited',
          {
            contentLength: content.length,
            truncated: content.length > 2000,
          },
          correlationId,
          message.author.id
        );
      } catch (error) {
        logger.error(`❌ DISCORD: Failed to edit message [${shortId}]:`, error);
        throw error;
      }
    },

    // Pull back a partially-streamed message whose final content got suppressed
    // ([SILENT], slur floor, empty generation) — otherwise the fragment stays up.
    deleteResponse: async () => {
      if (!streamingMessage) return;
      try {
        await streamingMessage.delete();
        logger.info(`🗑️ DISCORD: Deleted suppressed streaming message [${shortId}]`);
        streamingMessage = null;
      } catch (error) {
        logger.warn(`Failed to delete streaming message [${shortId}]:`, error);
      }
    },

    updateProgress: undefined,

    sendTyping:
      'sendTyping' in message.channel
        ? async () => {
            await (message.channel as any).sendTyping();
            telemetry.incrementTypingIndicators();
          }
        : undefined,

    // ENHANCED: Discord-native reaction support
    addReaction: async (emoji: string) => {
      try {
        await message.react(emoji);
        telemetry.logEvent('reaction_added', { emoji }, correlationId, message.author.id);
      } catch (error) {
        logger.warn(`Failed to add reaction ${emoji} [${shortId}]:`, error);
      }
    },

    removeReaction: async (emoji: string) => {
      try {
        const reaction = message.reactions.cache.get(emoji);
        if (reaction) {
          await reaction.users.remove(message.client.user!.id);
          telemetry.logEvent('reaction_removed', { emoji }, correlationId, message.author.id);
        }
      } catch (error) {
        logger.warn(`Failed to remove reaction ${emoji} [${shortId}]:`, error);
      }
    },

    // WARDEN POWER: time out the message author (the person being replied to) for <=300s.
    // Guardrails (SB guild only, never staff/protected, per-user cooldown) live in wardenTimeout.
    // Returns whether the timeout actually landed (roulette needs an honest verdict).
    timeoutAuthor: async (seconds: number, reason: string) =>
      wardenTimeout(message, seconds, reason, shortId),

    // WHEEL OF FATE: third-party roulette on anyone recently active in this channel.
    spinChannelWheel: async (seconds: number, targetName?: string) =>
      spinWheelOfFate(message, seconds, targetName, shortId),

    // ENHANCED: Thread creation for complex conversations
    createThread: async (threadName: string) => {
      try {
        if (message.channel.type === 0 && 'threads' in message.channel) {
          // Guild text channel
          const thread = await message.startThread({
            name: threadName,
            autoArchiveDuration: 60, // Auto-archive after 1 hour of inactivity
            reason: 'Complex conversation - keeping channel organized',
          });

          // Add thread reaction to original message
          await message.react('🧵');

          telemetry.logEvent(
            'thread_created',
            {
              threadName,
              threadId: thread.id,
            },
            correlationId,
            message.author.id
          );

          logger.info(`Created thread "${threadName}" [${shortId}]`);
          return thread;
        }
      } catch (error) {
        logger.warn(`Failed to create thread "${threadName}" [${shortId}]:`, error);
      }
      return null;
    },

    // ENHANCED: Rich embed support
    sendEmbed: async (embedData: any) => {
      try {
        const embed = new EmbedBuilder(embedData);
        await message.reply({ embeds: [embed] });
        telemetry.logEvent(
          'embed_sent',
          {
            title: embedData.title,
            fieldCount: embedData.fields?.length || 0,
          },
          correlationId,
          message.author.id
        );
      } catch (error) {
        logger.warn(`Failed to send embed [${shortId}]:`, error);
      }
    },

    // Send file attachment
    sendFile: async (fileData: { buffer: Buffer; filename: string; content?: string }) => {
      try {
        const attachment = new AttachmentBuilder(fileData.buffer, { name: fileData.filename });
        await message.reply({
          content: fileData.content || `📎 Here's your file: ${fileData.filename}`,
          files: [attachment],
        });
        telemetry.logEvent(
          'file_sent',
          {
            filename: fileData.filename,
            size: fileData.buffer.length,
          },
          correlationId,
          message.author.id
        );
        logger.info(
          `📎 Sent file ${fileData.filename} (${fileData.buffer.length} bytes) [${shortId}]`
        );
      } catch (error) {
        logger.warn(`Failed to send file [${shortId}]:`, error);
      }
    },

    updateProgressEmbed: undefined,

    // Context Alchemy: Get the Discord message ID for the response (for feedback correlation)
    getResponseMessageId: () => streamingMessage?.id,
  };
}
