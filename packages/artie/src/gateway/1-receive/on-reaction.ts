/**
 * Discord Reaction Handler - Two-way reaction system
 *
 * Features:
 * - Regenerate responses with 🔄 emoji
 * - Collect feedback with 👍/👎 emojis
 * - Comprehensive telemetry tracking
 */

import {
  Client,
  Events,
  MessageReaction,
  User,
  PartialMessageReaction,
  PartialUser,
} from 'discord.js';
import { delay } from '../../shared/async.js';
import { logger } from '../../shared/logger.js';
import { getErrorMessage, getErrorStackOrUndefined } from '../../shared/errors.js';
import { chunkMessage } from '../4-reply/chunks.js';
import { isBlockedUser } from '../../shared/blocklist.js';
import { telemetry } from '../telemetry.js';
import { generateCorrelationId, getShortCorrelationId } from '../correlation.js';
import { processUserIntent } from '../4-reply/stream-reply.js';
import { recordReaction, clearLoggedReactions, emojiKey } from './reaction-log.js';
import type { ReactorRole } from '../../shared/db/reaction-store.js';

// Import capabilities client for trace feedback correlation
import { engineClient } from '../3-ask-engine/engine-client.js';
import * as engine from '../../engine/api.js';

function getGuildInfo(guild: any): any {
  if (guild) {
    return {
      guildId: guild.id,
      guildName: guild.name,
      memberCount: guild.memberCount,
    };
  }
  return null;
}

function getChannelNameValue(channel: any): string {
  if ('name' in channel) {
    return channel.name;
  }
  return 'DM';
}

function getSendTypingFunction(channel: any): any {
  if ('sendTyping' in channel) {
    return async () => {
      await (channel as any).sendTyping();
    };
  }
  return undefined;
}

/**
 * Was the reactor the person this reply answered? Only the first chunk of a reply is a Discord
 * reply (message.reply), so later chunks and plain sends come back unknown.
 */
function reactorRoleOf(message: any, reactorId: string): ReactorRole | undefined {
  const answeredId = message?.mentions?.repliedUser?.id;
  if (!answeredId) return undefined;
  if (answeredId === reactorId) return 'asker';
  return 'other';
}

function buildFeedbackNote(sentiment: string, emoji: string, guildName: string, channelName: string, messageSnippet: string): string {
  if (sentiment === 'positive') {
    return `community feedback: ${emoji} reaction to my response in ${guildName} #${channelName}. response was: "${messageSnippet}..." - this response style works well here`;
  }
  return `community feedback: ${emoji} reaction (negative) to my response in ${guildName} #${channelName}. response was: "${messageSnippet}..." - should avoid this response style`;
}
import { replaceMention } from '../../shared/mentions.js';

// Reaction trigger emojis
const REGENERATE_EMOJI = '🔄';
const THUMBS_UP_EMOJI = '👍';
const THUMBS_DOWN_EMOJI = '👎';

// Reaction deduplication cache
const reactionCache = new Map<string, number>();

/**
 * Drop the 60s add-dedupe entries for a bulk-cleared message (every emoji, or one), so a re-add
 * right after the clear is recorded instead of swallowed (Codex).
 * Keys: `${msg}-${user}-${emojiKey}` (emojiKey = unicode emoji or custom:<id>); pass the key.
 */
export function forgetDedupe(messageId: string, emoji?: string): void {
  for (const key of [...reactionCache.keys()]) {
    if (!key.startsWith(`${messageId}-`)) continue;
    if (emoji !== undefined && !key.endsWith(`-${emoji}`)) continue;
    reactionCache.delete(key);
  }
}

/** Test hook. */
export function dedupeKeysForTest(): string[] {
  return [...reactionCache.keys()];
}

/** Test hook. */
export function markDedupeForTest(key: string): void {
  reactionCache.set(key, Date.now());
}
const REACTION_CACHE_TTL = 60000; // 60 seconds TTL

// Emoji sentiment categories - based on REAL observed reactions (no regex - simple lookup)
// Only track emojis with clear sentiment - ambiguous ones like 😂 🤔 are skipped
const POSITIVE_EMOJIS = [
  // Clear approval/love (observed: 👍 ❤️ 🔥)
  '👍',
  '❤️',
  '🔥',
  // Other likely positives
  '💯',
  '⭐',
  '✨',
  '🎉',
  '👏',
  '🙌',
  '✅',
  '💪',
  '🏆',
  // Hearts
  '💕',
  '💖',
  '💗',
  '💝',
  '💜',
  '💙',
  '💚',
  '🧡',
  '💛',
];

const NEGATIVE_EMOJIS = [
  // Clear disapproval
  '👎',
  '❌',
  '😡',
  '🤬',
  '💩',
  // Frustration/disappointment
  '😤',
  '😠',
  '🙄',
  '😞',
  '😒',
  // Facepalm (often means "wtf artie")
  '🤦',
  '🤦‍♂️',
  '🤦‍♀️',
];

/**
 * Categorize emoji sentiment (no regex - simple lookup)
 */
function categorizeSentiment(emoji: string): 'positive' | 'negative' | null {
  if (POSITIVE_EMOJIS.includes(emoji)) return 'positive';
  if (NEGATIVE_EMOJIS.includes(emoji)) return 'negative';
  return null; // Neutral or unknown - don't track
}

/**
 * Setup reaction handler for Discord client
 */
export function setupReactionHandler(client: Client) {
  client.on(
    Events.MessageReactionAdd,
    async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
      const correlationId = generateCorrelationId();
      const shortId = getShortCorrelationId(correlationId);

      try {
        // Fetch partial data if needed
        if (reaction.partial) {
          try {
            await reaction.fetch();
          } catch (error) {
            logger.error(`Failed to fetch partial reaction [${shortId}]:`, error);
            return;
          }
        }

        if (user.partial) {
          try {
            await user.fetch();
          } catch (error) {
            logger.error(`Failed to fetch partial user [${shortId}]:`, error);
            return;
          }
        }

        // Ignore bot reactions
        if (user.bot) {
          logger.debug(`Ignoring bot reaction [${shortId}]`);
          return;
        }

        // Blocked users can't trigger anything — a 🔄 regenerate is an LLM call,
        // which is exactly the credit burn that got them banned.
        if (isBlockedUser(user.id)) {
          logger.debug(`Ignoring reaction from blocked user [${shortId}]`);
          return;
        }

        // Ignore reactions on non-bot messages (we only care about reactions to our messages)
        if (!reaction.message.author?.bot || reaction.message.author.id !== client.user?.id) {
          logger.debug(`Ignoring reaction on non-bot message [${shortId}]`);
          return;
        }

        const emoji = reaction.emoji.name;
        if (!emoji) {
          logger.debug(`Ignoring reaction with no emoji name [${shortId}]`);
          return;
        }

        logger.info(`Reaction received [${shortId}]:`, {
          correlationId,
          emoji,
          userId: user.id,
          username: user.username,
          messageId: reaction.message.id,
          channelId: reaction.message.channelId,
          guildId: reaction.message.guildId,
        });

        telemetry.logEvent(
          'reaction_received',
          {
            emoji,
            messageId: reaction.message.id,
            channelId: reaction.message.channelId,
            guildId: reaction.message.guildId,
          },
          correlationId,
          user.id
        );

        // Deduplication: prevent processing same reaction multiple times
        // Keyed by emoji identity (a custom emoji's id), so two custom emojis that share a name
        // aren't deduped into one (Codex).
        const reactionKey = `${reaction.message.id}-${user.id}-${emojiKey(emoji, reaction.emoji.id)}`;
        const now = Date.now();

        // Cleanup expired cache entries
        for (const [key, timestamp] of reactionCache.entries()) {
          if (now - timestamp > REACTION_CACHE_TTL) {
            reactionCache.delete(key);
          }
        }

        // Skip if we've seen this exact reaction recently
        if (reactionCache.has(reactionKey)) {
          logger.debug(`Duplicate reaction detected [${shortId}]`, { reactionKey });
          return;
        }

        // Cache this reaction
        reactionCache.set(reactionKey, now);

        // Real-time reaction log (part 3): record EVERY emoji here, not just the ones
        // the switch below tracks for sentiment/regenerate — "I want to see it then" means
        // all of them, surfaced compactly in context (see reaction-log.ts).
        recordReaction({
          messageId: reaction.message.id,
          channelId: reaction.message.channelId,
          emoji,
          emojiId: reaction.emoji.id,
          userLabel: user.displayName || user.username || user.id,
          messageExcerpt: reaction.message.content?.slice(0, 120) || undefined,
          guildId: reaction.message.guildId ?? null,
          userId: user.id,
          reactorRole: reactorRoleOf(reaction.message, user.id),
          at: now,
        });

        // Handle different reaction types
        // At this point, reaction has been fetched and is no longer partial
        const fetchedReaction = reaction as MessageReaction;
        const fetchedUser = user as User;

        switch (emoji) {
          case REGENERATE_EMOJI:
            await handleRegenerateReaction(fetchedReaction, fetchedUser, correlationId);
            break;

          case THUMBS_UP_EMOJI:
            await handleFeedbackReaction(
              fetchedReaction,
              fetchedUser,
              'positive',
              emoji,
              correlationId
            );
            break;

          case THUMBS_DOWN_EMOJI:
            await handleFeedbackReaction(
              fetchedReaction,
              fetchedUser,
              'negative',
              emoji,
              correlationId
            );
            break;

          default: {
            // Track ALL emoji reactions for community sentiment learning
            const sentiment = categorizeSentiment(emoji);
            if (sentiment) {
              await handleFeedbackReaction(
                fetchedReaction,
                fetchedUser,
                sentiment,
                emoji,
                correlationId
              );
            } else {
              logger.debug(`Untracked reaction emoji: ${emoji} [${shortId}]`);
            }
            return;
          }
        }
      } catch (error) {
        logger.error(`Error handling reaction [${shortId}]:`, {
          correlationId,
          error: getErrorMessage(error),
          stack: getErrorStackOrUndefined(error),
        });

        telemetry.logEvent(
          'reaction_error',
          {
            error: getErrorMessage(error),
          },
          correlationId,
          user.id,
          undefined,
          false
        );
      }
    }
  );

  // Removals only update the persisted log (so "who reacted" stays true); no feedback or
  // regenerate side effects.
  client.on(
    Events.MessageReactionRemove,
    async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
      try {
        if (reaction.partial) await reaction.fetch();
        if (user.partial) await user.fetch();
        if (user.bot) return;
        if (!reaction.message.author?.bot || reaction.message.author.id !== client.user?.id) return;
        // A custom emoji's removal can arrive with an id but no name; the id is its identity.
        const emoji = reaction.emoji.name || '?';
        if (!reaction.emoji.name && !reaction.emoji.id) return;
        // A re-add right after a removal must not be swallowed by the 60s dedupe.
        reactionCache.delete(`${reaction.message.id}-${user.id}-${emojiKey(emoji, reaction.emoji.id)}`);
        recordReaction({
          messageId: reaction.message.id,
          channelId: reaction.message.channelId,
          emoji,
          emojiId: reaction.emoji.id,
          userLabel: user.displayName || user.username || user.id,
          messageExcerpt: reaction.message.content?.slice(0, 120) || undefined,
          guildId: reaction.message.guildId ?? null,
          userId: user.id,
          reactorRole: reactorRoleOf(reaction.message, user.id),
          action: 'removed',
          at: Date.now(),
        });
      } catch (error) {
        logger.debug('Failed to log reaction removal:', error);
      }
    }
  );

  // Bulk removals (a mod clears every reaction, or one emoji entirely) send no per-user remove
  // events, so the logged adds are dropped here (Codex).
  client.on(Events.MessageReactionRemoveAll, async (message: any) => {
    try {
      forgetDedupe(message.id);
      clearLoggedReactions(message.channelId, message.id);
    } catch (error) {
      logger.debug('Failed to clear logged reactions:', error);
    }
  });
  client.on(Events.MessageReactionRemoveEmoji, async (reaction: any) => {
    try {
      // A custom emoji can arrive with an id but no name; the id alone is its identity.
      if (!reaction.emoji?.name && !reaction.emoji?.id) return;
      const name = reaction.emoji.name || '?';
      forgetDedupe(reaction.message.id, emojiKey(name, reaction.emoji.id));
      clearLoggedReactions(reaction.message.channelId, reaction.message.id, name, reaction.emoji.id);
    } catch (error) {
      logger.debug('Failed to clear logged emoji reactions:', error);
    }
  });

  logger.info('Reaction handler setup complete');
}

/**
 * Handle regenerate reaction (🔄)
 * Finds the original user message and reprocesses it
 */
async function handleRegenerateReaction(
  reaction: MessageReaction,
  user: User,
  correlationId: string
): Promise<void> {
  const shortId = getShortCorrelationId(correlationId);

  logger.info(`Regenerate reaction triggered [${shortId}]:`, {
    correlationId,
    userId: user.id,
    messageId: reaction.message.id,
  });

  telemetry.logEvent(
    'reaction_regenerate',
    {
      messageId: reaction.message.id,
      channelId: reaction.message.channelId,
    },
    correlationId,
    user.id
  );

  try {
    // Find the original user message by looking at the message this bot message replied to
    const botMessage = reaction.message;
    let originalMessage = null;

    // Check if this is a reply
    if (botMessage.reference?.messageId) {
      try {
        originalMessage = await botMessage.channel.messages.fetch(botMessage.reference.messageId);
      } catch (error) {
        logger.warn(`Failed to fetch referenced message [${shortId}]:`, error);
      }
    }

    // If not a reply, look for the most recent message from the user in this channel
    if (!originalMessage) {
      try {
        const recentMessages = await botMessage.channel.messages.fetch({
          limit: 20,
          before: botMessage.id,
        });
        originalMessage = recentMessages.find((msg) => msg.author.id === user.id);
      } catch (error) {
        logger.warn(`Failed to fetch recent messages [${shortId}]:`, error);
      }
    }

    if (!originalMessage) {
      logger.warn(`Could not find original user message to regenerate [${shortId}]`);
      await botMessage.react('❌');
      telemetry.logEvent(
        'reaction_regenerate_failed',
        { reason: 'original_message_not_found' },
        correlationId,
        user.id,
        undefined,
        false
      );
      return;
    }

    logger.info(`Found original message to regenerate [${shortId}]:`, {
      correlationId,
      originalMessageId: originalMessage.id,
      originalContent: originalMessage.content.substring(0, 100),
    });

    // Acknowledge the regeneration request
    await botMessage.react('✅');

    // Extract the clean message content (remove mentions)
    // Strip the bot's own mention only (cleanContent would leave "@Coach Artie" in).
    const cleanMessage = replaceMention(originalMessage.content, reaction.message.client.user?.id, '').trim();

    // Gather Discord context
    const guildInfo = getGuildInfo(botMessage.guild);

    const channelNameValue = getChannelNameValue(botMessage.channel);
    const channelInfo = {
      channelId: botMessage.channelId,
      channelType: botMessage.channel.type,
      channelName: channelNameValue,
    };

    const userInfo = {
      userId: user.id,
      username: user.username,
      displayName: user.displayName || user.username,
      userTag: user.tag,
      isBot: user.bot,
    };

    const discordContext = {
      platform: 'discord',
      ...guildInfo,
      ...channelInfo,
      ...userInfo,
      messageId: originalMessage.id,
      timestamp: new Date().toISOString(),
      isRegenerateRequest: true,
      originalBotMessageId: botMessage.id,
    };

    // Reprocess the original message using the unified intent processor
    await processUserIntent(
      {
        content: cleanMessage,
        userId: user.id,
        username: user.username,
        source: 'message',
        context: discordContext,
        metadata: {
          messageId: originalMessage.id,
          channelId: botMessage.channelId,
          guildId: botMessage.guildId,
          correlationId,
          isRegenerate: true,
        },

        // Response handlers - reply to the bot message this time
        respond: async (content: string) => {
          const chunks = chunkMessage(content);
          if (!chunks) {
            // Previously chunks[0] was undefined here and reply() threw.
            logger.warn(`🔇 Reaction response empty for ${user.id} — nothing sent.`);
            return;
          }
          await botMessage.reply(chunks[0]);

          // Send additional chunks
          for (let i = 1; i < chunks.length; i++) {
            if ('send' in botMessage.channel) {
              await (botMessage.channel as any).send(chunks[i]);
              await delay(200);
            }
          }

          telemetry.incrementResponsesDelivered(user.id, chunks.length);
        },

        sendTyping: getSendTypingFunction(botMessage.channel),

        addReaction: async (emoji: string) => {
          try {
            await originalMessage.react(emoji);
          } catch (error) {
            logger.warn(`Failed to add reaction ${emoji} [${shortId}]:`, error);
          }
        },

        removeReaction: async (emoji: string) => {
          try {
            const reactionToRemove = originalMessage.reactions.cache.get(emoji);
            if (reactionToRemove) {
              await reactionToRemove.users.remove(botMessage.client.user!.id);
            }
          } catch (error) {
            logger.warn(`Failed to remove reaction ${emoji} [${shortId}]:`, error);
          }
        },
      },
      {
        enableStreaming: true,
        enableTyping: true,
        enableReactions: false,
        enableEditing: false, // Don't edit for regenerate - use fresh message
        enableThreading: false,
      }
    );

    telemetry.logEvent(
      'reaction_regenerate_success',
      {
        originalMessageId: originalMessage.id,
      },
      correlationId,
      user.id,
      undefined,
      true
    );
  } catch (error) {
    logger.error(`Failed to handle regenerate reaction [${shortId}]:`, error);

    try {
      await reaction.message.react('❌');
    } catch (reactError) {
      logger.warn(`Failed to add error reaction [${shortId}]:`, reactError);
    }

    telemetry.logEvent(
      'reaction_regenerate_failed',
      {
        error: getErrorMessage(error),
      },
      correlationId,
      user.id,
      undefined,
      false
    );
  }
}

/**
 * Handle feedback reaction (any emoji with sentiment)
 * Logs user feedback to telemetry AND stores memory for learning
 */
async function handleFeedbackReaction(
  reaction: MessageReaction,
  user: User,
  sentiment: 'positive' | 'negative',
  emoji: string,
  correlationId: string
): Promise<void> {
  const shortId = getShortCorrelationId(correlationId);

  logger.info(`Feedback reaction received [${shortId}]:`, {
    correlationId,
    sentiment,
    emoji,
    userId: user.id,
    messageId: reaction.message.id,
  });

  telemetry.logEvent(
    'reaction_feedback',
    {
      sentiment,
      emoji,
      messageId: reaction.message.id,
      channelId: reaction.message.channelId,
      guildId: reaction.message.guildId,
      messageContent: reaction.message.content?.substring(0, 100) || '',
    },
    correlationId,
    user.id,
    undefined,
    true
  );

  // Context Alchemy: Record feedback in trace for observability
  try {
    await engineClient.recordTraceFeedback(reaction.message.id, sentiment, emoji);
  } catch (error) {
    // Non-critical - trace feedback is for observability only
    logger.debug(`Failed to record trace feedback [${shortId}]:`, error);
  }

  // Store memory about this feedback for learning
  try {
    const messageSnippet = reaction.message.content?.substring(0, 150) || 'unknown message';
    let channelName: string | null;
    if ('name' in reaction.message.channel) {
      channelName = reaction.message.channel.name;
    } else {
      channelName = null;
    }
    channelName = channelName || 'DM';
    const guildName = reaction.message.guild?.name || 'unknown';
    const guildId = reaction.message.guildId;

    // Build a more actionable reflection note
    const feedbackNote = buildFeedbackNote(sentiment, emoji, guildName, channelName, messageSnippet);

    // Use direct memory endpoint for proper storage with guild scope (wave 9: in-process,
    // was POST :47324/capabilities/registry/memory/execute; same handler)
    let importance: number;
    if (sentiment === 'negative') {
      importance = 5; // Negative feedback is more important to learn from
    } else {
      importance = 3;
    }
    const response = await engine.executeCapability('memory', {
      action: 'remember',
      params: {
        content: feedbackNote,
        userId: 'reaction-feedback-system',
        scope: 'here', // feedback from this server: stays in its guild
        importance,
        tags: ['community', 'feedback', sentiment, 'response-style', channelName.toLowerCase()],
        guildId: guildId, // Store with guild scope so it's recalled in that guild
      },
    });

    if (engine.isOk(response)) {
      logger.info(`Stored ${sentiment} feedback memory for guild ${guildId} [${shortId}]`);
    }
  } catch (error) {
    logger.warn(`Failed to store feedback memory [${shortId}]:`, error);
  }

  // Acknowledge the feedback with a subtle reaction
  try {
    await reaction.message.react('✨');

    // Remove the acknowledgment after 3 seconds to keep it clean
    setTimeout(async () => {
      try {
        const ackReaction = reaction.message.reactions.cache.get('✨');
        if (ackReaction) {
          await ackReaction.users.remove(reaction.message.client.user!.id);
        }
      } catch {
        // Silent cleanup
      }
    }, 3000);
  } catch (error) {
    logger.warn(`Failed to acknowledge feedback [${shortId}]:`, error);
  }

  logger.info(`Feedback logged successfully [${shortId}]`);
}

