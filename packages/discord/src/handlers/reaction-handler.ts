/**
 * Discord Reaction Handler - Two-way reaction system
 *
 * Features:
 * - Regenerate responses with 🔄 emoji
 * - Collect feedback with 👍/👎 emojis
 * - Comprehensive telemetry tracking
 */

import { Client, Events, MessageReaction, User, PartialMessageReaction, PartialUser } from 'discord.js';
import { logger } from '@coachartie/shared';
import { telemetry } from '../services/telemetry.js';
import { generateCorrelationId, getShortCorrelationId } from '../utils/correlation.js';
import { processUserIntent } from '../services/user-intent-processor.js';

// Reaction trigger emojis
const REGENERATE_EMOJI = '🔄';
const THUMBS_UP_EMOJI = '👍';
const THUMBS_DOWN_EMOJI = '👎';

// Reaction deduplication cache
const reactionCache = new Map<string, number>();
const REACTION_CACHE_TTL = 60000; // 60 seconds TTL

/**
 * Setup reaction handler for Discord client
 */
export function setupReactionHandler(client: Client) {
  client.on(Events.MessageReactionAdd, async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
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
      const reactionKey = `${reaction.message.id}-${user.id}-${emoji}`;
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

      // Handle different reaction types
      // At this point, reaction has been fetched and is no longer partial
      const fetchedReaction = reaction as MessageReaction;
      const fetchedUser = user as User;

      switch (emoji) {
        case REGENERATE_EMOJI:
          await handleRegenerateReaction(fetchedReaction, fetchedUser, correlationId);
          break;

        case THUMBS_UP_EMOJI:
          await handleFeedbackReaction(fetchedReaction, fetchedUser, 'positive', correlationId);
          break;

        case THUMBS_DOWN_EMOJI:
          await handleFeedbackReaction(fetchedReaction, fetchedUser, 'negative', correlationId);
          break;

        default:
          logger.debug(`Unhandled reaction emoji: ${emoji} [${shortId}]`);
          return;
      }
    } catch (error) {
      logger.error(`Error handling reaction [${shortId}]:`, {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      telemetry.logEvent(
        'reaction_error',
        {
          error: error instanceof Error ? error.message : String(error),
        },
        correlationId,
        user.id,
        undefined,
        false
      );
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
        const recentMessages = await botMessage.channel.messages.fetch({ limit: 20, before: botMessage.id });
        originalMessage = recentMessages.find(msg => msg.author.id === user.id);
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
    const cleanMessage = originalMessage.content
      .replace(new RegExp(`<@!?${reaction.message.client.user?.id}>`, 'g'), '')
      .trim();

    // Gather Discord context
    const guildInfo = botMessage.guild
      ? {
          guildId: botMessage.guild.id,
          guildName: botMessage.guild.name,
          memberCount: botMessage.guild.memberCount,
        }
      : null;

    const channelInfo = {
      channelId: botMessage.channelId,
      channelType: botMessage.channel.type,
      channelName: 'name' in botMessage.channel ? botMessage.channel.name : 'DM',
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
          await botMessage.reply(chunks[0]);

          // Send additional chunks
          for (let i = 1; i < chunks.length; i++) {
            if ('send' in botMessage.channel) {
              await (botMessage.channel as any).send(chunks[i]);
              await new Promise(resolve => setTimeout(resolve, 200));
            }
          }

          telemetry.incrementResponsesDelivered(user.id, chunks.length);
        },

        sendTyping: 'sendTyping' in botMessage.channel
          ? async () => {
              await (botMessage.channel as any).sendTyping();
            }
          : undefined,

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
        error: error instanceof Error ? error.message : String(error),
      },
      correlationId,
      user.id,
      undefined,
      false
    );
  }
}

/**
 * Handle feedback reaction (👍/👎)
 * Logs user feedback to telemetry
 */
async function handleFeedbackReaction(
  reaction: MessageReaction,
  user: User,
  sentiment: 'positive' | 'negative',
  correlationId: string
): Promise<void> {
  const shortId = getShortCorrelationId(correlationId);

  logger.info(`Feedback reaction received [${shortId}]:`, {
    correlationId,
    sentiment,
    userId: user.id,
    messageId: reaction.message.id,
  });

  telemetry.logEvent(
    'reaction_feedback',
    {
      sentiment,
      messageId: reaction.message.id,
      channelId: reaction.message.channelId,
      guildId: reaction.message.guildId,
      messageContent: reaction.message.content?.substring(0, 100) || '', // Log snippet for context
    },
    correlationId,
    user.id,
    undefined,
    true
  );

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
      } catch (error) {
        // Silent cleanup
      }
    }, 3000);
  } catch (error) {
    logger.warn(`Failed to acknowledge feedback [${shortId}]:`, error);
  }

  logger.info(`Feedback logged successfully [${shortId}]`);
}

/**
 * Split long messages into Discord-compatible chunks
 * Preserves newlines and markdown formatting
 */
function chunkMessage(text: string, maxLength: number = 2000): string[] {
  if (!text || text.length === 0) return [];
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let currentChunk = '';

  // Split on double newlines to find paragraphs, but keep the delimiters
  const paragraphParts = text.split(/(\n\n+)/);

  for (const part of paragraphParts) {
    // Check if this is a paragraph delimiter (double+ newlines)
    const isDelimiter = /^\n\n+$/.test(part);

    if (isDelimiter) {
      // Preserve paragraph breaks - normalize to double newline
      if (currentChunk.length + 2 <= maxLength) {
        currentChunk += '\n\n';
      } else {
        // Flush and start fresh
        if (currentChunk.trim()) {
          chunks.push(currentChunk.trimEnd());
          currentChunk = '';
        }
      }
      continue;
    }

    // Regular paragraph content - preserve single newlines within it
    const lines = part.split('\n');

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      // Don't trim - preserve leading whitespace for indentation

      // Calculate what we need to add
      const needsNewline = currentChunk.length > 0 && lineIdx > 0;
      const addition = (needsNewline ? '\n' : '') + line;

      // If adding this line fits, add it
      if (currentChunk.length + addition.length <= maxLength) {
        currentChunk += addition;
        continue;
      }

      // Line won't fit - flush current chunk first
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trimEnd());
        currentChunk = '';
      }

      // If line itself fits, use it
      if (line.length <= maxLength) {
        currentChunk = line;
        continue;
      }

      // Line is too long - must split by words
      const words = line.split(' ');

      for (const word of words) {
        if (currentChunk.length + word.length + 1 > maxLength) {
          if (currentChunk.trim()) {
            chunks.push(currentChunk.trimEnd());
            currentChunk = '';
          }

          // If single word is too long, split it
          if (word.length > maxLength) {
            for (let i = 0; i < word.length; i += maxLength) {
              chunks.push(word.slice(i, i + maxLength));
            }
          } else {
            currentChunk = word;
          }
        } else {
          currentChunk += (currentChunk ? ' ' : '') + word;
        }
      }
    }
  }

  // Flush any remaining content
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trimEnd());
  }

  return chunks.length > 0 ? chunks : [text];
}
