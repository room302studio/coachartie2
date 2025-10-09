/**
 * Discord Message Handler - Core message processing and streaming system
 * 
 * Features:
 * - Smart response detection (mentions, DMs, robot channels)
 * - Real-time streaming with duplicate prevention
 * - Job tracking with persistent monitoring
 * - Message chunking for Discord's 2000 character limit
 * - Comprehensive telemetry and correlation tracking
 */

import { Client, Events, Message, EmbedBuilder } from 'discord.js';
import { logger } from '@coachartie/shared';
import { publishMessage } from '../queues/publisher.js';
import { telemetry } from '../services/telemetry.js';
import { CorrelationContext, generateCorrelationId, getShortCorrelationId } from '../utils/correlation.js';
import { processUserIntent } from '../services/user-intent-processor.js';
import { isGuildWhitelisted } from '../config/guild-whitelist.js';

// =============================================================================
// CONSTANTS & CONFIGURATION
// =============================================================================

// Message deduplication cache to prevent duplicate processing
const messageCache = new Map<string, number>();
const MESSAGE_CACHE_TTL = 10000; // 10 seconds TTL

// Discord API limits and timeouts
const TYPING_REFRESH_INTERVAL = 8000; // Refresh typing every 8s (Discord typing lasts 10s)
const CHUNK_RATE_LIMIT_DELAY = 200;   // 200ms delay between message chunks
const MAX_JOB_ATTEMPTS = 60;          // 5 minute max job timeout (60 * 3s checks)
const DISCORD_MESSAGE_LIMIT = 2000;   // Discord's maximum message length

// UI and status constants
const STATUS_UPDATE_INTERVAL = 5;     // Update status every 5 progress callbacks
const CONTEXT_CLEANUP_PROBABILITY = 0.01; // 1% chance to cleanup correlation context
const ID_SLICE_LENGTH = -8;           // Last 8 characters for job short IDs

// Channel detection constants
const GUILD_CHANNEL_TYPE = 0;         // Discord guild text channel type

// Status emojis
const STATUS_EMOJI_PROCESSING = '🔄';
const STATUS_EMOJI_THINKING = '🤔';
const STREAM_EMOJI = '📡';

// =============================================================================
// MESSAGE CHUNKING UTILITIES
// =============================================================================

/**
 * Helper: Check if channel name indicates robot interaction
 */
function isRobotChannelName(channel: Message['channel']): boolean {
  return channel.type === GUILD_CHANNEL_TYPE && 
         'name' in channel && 
         (channel.name?.includes('🤖') || channel.name?.includes('robot')) || false;
}

/**
 * Split long messages into Discord-compatible chunks
 * Preserves formatting by splitting on lines first, then words if needed
 * 
 * @param text - The text to chunk
 * @param maxLength - Maximum chunk size (default: 2000)
 * @returns Array of message chunks
 */
function chunkMessage(text: string, maxLength: number = DISCORD_MESSAGE_LIMIT): string[] {
  if (text.length <= maxLength) return [text];
  
  const chunks: string[] = [];
  let currentChunk = '';
  
  // Split by lines first to preserve formatting
  const lines = text.split('\n');
  
  for (const line of lines) {
    // If adding this line would exceed the limit, start a new chunk
    if (currentChunk.length + line.length + 1 > maxLength) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      
      // If a single line is too long, split it further
      if (line.length > maxLength) {
        const words = line.split(' ');
        for (const word of words) {
          if (currentChunk.length + word.length + 1 > maxLength) {
            if (currentChunk.trim()) {
              chunks.push(currentChunk.trim());
              currentChunk = '';
            }
          }
          currentChunk += (currentChunk ? ' ' : '') + word;
        }
      } else {
        currentChunk += (currentChunk ? '\n' : '') + line;
      }
    } else {
      currentChunk += (currentChunk ? '\n' : '') + line;
    }
  }
  
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

/**
 * Check if we should stream this partial response
 */
function shouldStreamPartialResponse(
  status: any, 
  lastSentContent: string, 
  channel: Message['channel']
): boolean {
  return !!(
    status.partialResponse && 
    status.partialResponse !== lastSentContent && 
    'send' in channel && 
    typeof channel.send === 'function'
  );
}

/**
 * Send message chunks with rate limiting
 */
async function sendMessageChunks(
  content: string, 
  channel: Message['channel'], 
  currentChunkCount: number
): Promise<number> {
  const chunks = chunkMessage(content);
  let chunksAdded = 0;
  
  for (const chunk of chunks) {
    await (channel as any).send(chunk);
    chunksAdded++;
    
    // Rate limiting: prevent Discord API abuse
    if (currentChunkCount + chunksAdded > 1) {
      await new Promise(resolve => setTimeout(resolve, CHUNK_RATE_LIMIT_DELAY));
    }
  }
  
  return chunksAdded;
}

/**
 * Check if status message should be updated
 */
function shouldUpdateStatus(
  currentStatus: string, 
  lastStatus: string, 
  updateCount: number
): boolean {
  return currentStatus !== lastStatus || (updateCount % STATUS_UPDATE_INTERVAL === 0);
}

/**
 * Update the status message with current progress
 */
async function updateStatusMessage(
  statusMessage: Message, 
  status: any, 
  streamedChunks: number, 
  shortId: string, 
  jobShortId: string
): Promise<void> {
  const statusEmoji = status.status === 'processing' ? STATUS_EMOJI_PROCESSING : STATUS_EMOJI_THINKING;
  const streamEmoji = streamedChunks > 0 ? ` ${STREAM_EMOJI}` : '';
  
  // Human-friendly status messages without technical clutter
  let statusText = status.status === 'processing' ? 'Processing' : 'Working on it';
  const statusContent = `${statusEmoji}${streamEmoji} ${statusText}...`;
  
  await statusMessage.edit(statusContent);
}

/**
 * Send complete response in chunks
 */
async function sendCompleteResponse(message: Message, result: string): Promise<number> {
  const chunks = chunkMessage(result);
  await message.reply(chunks[0]);
  
  for (let i = 1; i < chunks.length; i++) {
    if ('send' in message.channel) {
      await (message.channel as any).send(chunks[i]);
    }
  }
  
  return chunks.length;
}

// =============================================================================
// MAIN MESSAGE HANDLER SETUP
// =============================================================================

/**
 * Initialize Discord message handler with smart response detection
 * 
 * Handles:
 * - Message deduplication
 * - Response condition detection (mentions, DMs, robot channels)
 * - Active response vs passive observation
 * - Error handling and telemetry
 * 
 * @param client - Discord.js client instance
 */
export function setupMessageHandler(client: Client) {
  client.on(Events.MessageCreate, async (message: Message) => {
    // -------------------------------------------------------------------------
    // CORRELATION & LOGGING SETUP
    // -------------------------------------------------------------------------
    
    const correlationId = CorrelationContext.getForMessage(message.id);
    const shortId = getShortCorrelationId(correlationId);
    
    // Structured logging with correlation ID
    logger.info(`📨 Message received [${shortId}]`, {
      correlationId,
      author: message.author.tag,
      userId: message.author.id,
      channelType: message.channel.type,
      channelId: message.channelId,
      messageId: message.id,
      contentLength: message.content.length,
      guildId: message.guildId || 'DM'
    });
    
    // Track message received
    telemetry.incrementMessagesReceived(message.author.id);
    telemetry.logEvent('message_received', {
      channelType: message.channel.type,
      guildId: message.guildId,
      contentLength: message.content.length
    }, correlationId, message.author.id);
    
    // -------------------------------------------------------------------------
    // RESPONSE CONDITION DETECTION
    // -------------------------------------------------------------------------
    
    // Ignore our own messages to prevent loops
    if (message.author.id === client.user!.id) return;

    // Check guild whitelist - only process messages from whitelisted guilds
    if (message.guildId && !isGuildWhitelisted(message.guildId)) {
      logger.debug(`🚫 Ignoring message from non-whitelisted guild: ${message.guildId} [${shortId}]`);
      return;
    }

    // Check various response triggers
    const responseConditions = {
      botMentioned: message.mentions.has(client.user!.id),
      isDM: message.channel.isDMBased(),
      isRobotChannel: isRobotChannelName(message.channel)
    };
    
    // Determine response mode: active response vs passive observation
    const shouldRespond = responseConditions.botMentioned || 
                         responseConditions.isDM || 
                         responseConditions.isRobotChannel;

    try {
      // -------------------------------------------------------------------------
      // MESSAGE PROCESSING & DEDUPLICATION
      // -------------------------------------------------------------------------
      
      const fullMessage = message.content;
      const cleanMessage = message.content
        .replace(`<@${client.user!.id}>`, '')    // Remove @bot mentions
        .replace(`<@!${client.user!.id}>`, '')   // Remove @bot nickname mentions
        .trim();

      // Deduplication: prevent processing identical messages within TTL window
      const messageKey = `${message.author.id}-${fullMessage}-${message.channelId}`;
      const now = Date.now();
      
      // Cleanup expired cache entries
      for (const [key, timestamp] of messageCache.entries()) {
        if (now - timestamp > MESSAGE_CACHE_TTL) {
          messageCache.delete(key);
        }
      }
      
      // Skip if we've seen this exact message recently
      if (messageCache.has(messageKey)) {
        logger.info(`🚫 Duplicate message detected [${shortId}]`, { correlationId, messageKey });
        telemetry.logEvent('message_duplicate', { messageKey }, correlationId, message.author.id);
        return;
      }
      
      // Cache this message to prevent future duplicates
      messageCache.set(messageKey, now);

      // -------------------------------------------------------------------------
      // RESPONSE ROUTING
      // -------------------------------------------------------------------------
      
      if (shouldRespond) {
        // ACTIVE RESPONSE: Bot will generate and send a response
        logger.info(`🤖 Will respond to message [${shortId}]`, {
          correlationId,
          author: message.author.tag,
          cleanMessage: cleanMessage.substring(0, 100) + (cleanMessage.length > 100 ? '...' : '')
        });
        
        telemetry.logEvent('message_will_respond', {
          messageLength: cleanMessage.length,
          triggerType: responseConditions.botMentioned ? 'mention' : responseConditions.isDM ? 'dm' : 'robot_channel'
        }, correlationId, message.author.id);
        
        // Process with unified intent processor
        await handleMessageAsIntent(message, cleanMessage, correlationId);
        
      } else {
        // PASSIVE OBSERVATION: Just process for learning, no response
        const channelName = message.channel.type === GUILD_CHANNEL_TYPE && 'name' in message.channel ? message.channel.name : 'DM';
        logger.info(`👁️ Passive observation [${shortId}]`, {
          correlationId,
          author: message.author.tag,
          channel: channelName
        });
        
        telemetry.logEvent('message_observed', {
          channelName,
          messageLength: fullMessage.length
        }, correlationId, message.author.id);
        
        // Still process for passive observation using queue system
        await publishMessage(
          message.author.id,
          fullMessage,
          message.channelId,
          message.author.tag,
          false // Don't respond, just observe
        );
      }

    } catch (error) {
      logger.error(`❌ Error handling Discord message [${shortId}]:`, {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        author: message.author.tag,
        messageId: message.id
      });
      
      telemetry.incrementMessagesFailed(message.author.id, error instanceof Error ? error.message : String(error));
      telemetry.logEvent('message_error', {
        error: error instanceof Error ? error.message : String(error)
      }, correlationId, message.author.id, undefined, false);
      
      // ENHANCED: User-friendly error with transparency
      const errorMsg = error instanceof Error && error.message.length < 100
        ? `Sorry, I encountered an error: ${error.message}`
        : 'Sorry, I encountered an error processing your message. The issue has been logged.';

      await message.reply(`❌ ${errorMsg}`);
    }
    
    // Clean up correlation context periodically
    if (Math.random() < CONTEXT_CLEANUP_PROBABILITY) {
      CorrelationContext.cleanup();
    }
  });
}

// =============================================================================
// MESSAGE ADAPTER - SIMPLE BRIDGE TO UNIFIED PROCESSOR
// =============================================================================

/**
 * Simple adapter: Convert Discord message to UserIntent and delegate to unified processor
 * Replaces ~400 lines of duplicate logic with ~30 lines of adapter code
 */
async function handleMessageAsIntent(
  message: Message,
  cleanMessage: string,
  correlationId: string
): Promise<void> {
  const shortId = getShortCorrelationId(correlationId);
  let statusMessage: Message | null = null;
  let streamingMessage: Message | null = null;
  
  try {
    // MINIMAL: No status messages - just start working like a human

    // ENHANCED: Gather Discord context for Context Alchemy
    const guildInfo = message.guild ? {
      guildId: message.guild.id,
      guildName: message.guild.name,
      memberCount: message.guild.memberCount
    } : null;

    const channelInfo = {
      channelId: message.channelId,
      channelType: message.channel.type,
      channelName: 'name' in message.channel ? message.channel.name : 'DM'
    };

    const userInfo = {
      userId: message.author.id,
      username: message.author.username,
      displayName: message.author.displayName,
      userTag: message.author.tag,
      isBot: message.author.bot
    };

    const discordContext = {
      platform: 'discord',
      ...guildInfo,
      ...channelInfo,
      ...userInfo,
      messageId: message.id,
      timestamp: message.createdAt.toISOString(),
      hasAttachments: message.attachments.size > 0,
      mentionedUsers: message.mentions.users.size,
      replyingTo: message.reference?.messageId || null
    };

    // Create unified intent and delegate to shared processor
    await processUserIntent({
      content: cleanMessage,
      userId: message.author.id,
      username: message.author.username,
      source: 'message',
      context: discordContext, // Pass rich Discord context
      metadata: {
        messageId: message.id,
        channelId: message.channelId,
        guildId: message.guildId,
        correlationId
      },
      
      // Response handlers
      respond: async (content: string): Promise<void> => {
        const chunks = chunkMessage(content);
        const responseMessage = await message.reply(chunks[0]);

        // Store reference for potential editing
        if (!streamingMessage) {
          streamingMessage = responseMessage;
        }

        // Send additional chunks
        for (let i = 1; i < chunks.length; i++) {
          if ('send' in message.channel) {
            await (message.channel as any).send(chunks[i]);
            await new Promise(resolve => setTimeout(resolve, CHUNK_RATE_LIMIT_DELAY));
          }
        }

        telemetry.incrementResponsesDelivered(message.author.id, chunks.length);
      },

      // ENHANCED: Edit response capability for cleaner streaming
      editResponse: async (content: string) => {
        if (!streamingMessage) {
          logger.warn(`No streaming message to edit [${shortId}]`);
          return;
        }

        try {
          // Discord has 2000 char limit for edits too
          const truncatedContent = content.length > 2000
            ? content.slice(0, 1997) + '...'
            : content;

          await streamingMessage.edit(truncatedContent);
          telemetry.logEvent('message_edited', {
            contentLength: content.length,
            truncated: content.length > 2000
          }, correlationId, message.author.id);
        } catch (error) {
          logger.warn(`Failed to edit message [${shortId}]:`, error);
          throw error;
        }
      },
      
      updateProgress: statusMessage ? async (status: string) => {
        const msg = statusMessage as Message;
        await msg.edit(status);
      } : undefined,
      
      sendTyping: 'sendTyping' in message.channel ? async () => {
        await (message.channel as any).sendTyping();
        telemetry.incrementTypingIndicators();
      } : undefined,

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

      // ENHANCED: Thread creation for complex conversations
      createThread: async (threadName: string) => {
        try {
          if (message.channel.type === 0 && 'threads' in message.channel) { // Guild text channel
            const thread = await message.startThread({
              name: threadName,
              autoArchiveDuration: 60, // Auto-archive after 1 hour of inactivity
              reason: 'Complex conversation - keeping channel organized'
            });

            // Add thread reaction to original message
            await message.react('🧵');

            telemetry.logEvent('thread_created', {
              threadName,
              threadId: thread.id
            }, correlationId, message.author.id);

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
          telemetry.logEvent('embed_sent', {
            title: embedData.title,
            fieldCount: embedData.fields?.length || 0
          }, correlationId, message.author.id);
        } catch (error) {
          logger.warn(`Failed to send embed [${shortId}]:`, error);
        }
      },

      updateProgressEmbed: statusMessage ? async (embedData: any) => {
        try {
          const msg = statusMessage as Message;
          const embed = new EmbedBuilder(embedData);
          await msg.edit({ embeds: [embed] });
          telemetry.logEvent('embed_updated', {
            title: embedData.title
          }, correlationId, message.author.id);
        } catch (error) {
          logger.warn(`Failed to update progress embed [${shortId}]:`, error);
        }
      } : undefined
      
    }, {
      enableStreaming: true,  // Enable streaming for messages
      enableTyping: true,     // Enable typing indicators for messages
      enableReactions: false, // MINIMAL: No emoji reactions
      enableEditing: true,    // Enable message editing for cleaner streaming
      enableThreading: false, // MINIMAL: No auto-threading
      maxAttempts: MAX_JOB_ATTEMPTS,
      statusUpdateInterval: STATUS_UPDATE_INTERVAL
    });

    // MINIMAL: No final status updates

  } catch (error) {
    logger.error(`Message intent processing failed [${shortId}]:`, error);
    
    // Fallback error handling
    try {
      // statusMessage is always null in current implementation
      await message.reply(`❌ Sorry, I couldn't process your message`);
    } catch (replyError) {
      logger.error(`Failed to send error reply [${shortId}]:`, replyError);
    }
  }
}