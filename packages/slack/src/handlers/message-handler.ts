/**
 * Slack Message Handler - Core message processing and streaming system
 *
 * Features:
 * - Smart response detection (mentions, DMs, specific channels)
 * - Real-time streaming with duplicate prevention
 * - Job tracking with persistent monitoring
 * - Message chunking for Slack's 40k character limit
 * - Comprehensive telemetry and correlation tracking
 *
 * Architecture: Mirrors Discord message-handler.ts patterns
 */

import type { App, MessageEvent, SayFn } from '@slack/bolt';
import { logger } from '@coachartie/shared';
import { publishMessage } from '../queues/publisher.js';
import { telemetry } from '../services/telemetry.js';
import {
  CorrelationContext,
  generateCorrelationId,
  getShortCorrelationId,
} from '../utils/correlation.js';
import { processUserIntent } from '../services/user-intent-processor.js';
import Chance from 'chance';

const chance = new Chance();

// =============================================================================
// CONSTANTS & CONFIGURATION
// =============================================================================

// Message deduplication cache to prevent duplicate processing
const messageCache = new Map<string, number>();
const MESSAGE_CACHE_TTL = 10000; // 10 seconds TTL

// Slack API limits and timeouts
const TYPING_REFRESH_INTERVAL = 3000; // Refresh typing every 3s (Slack shows typing for ~3s)
const CHUNK_RATE_LIMIT_DELAY = 200; // 200ms delay between message chunks
const MAX_JOB_ATTEMPTS = 60; // 5 minute max job timeout (60 * 3s checks)
const SLACK_MESSAGE_LIMIT = 40000; // Slack's maximum message length (40k chars)

// UI and status constants
const STATUS_UPDATE_INTERVAL = 5; // Update status every 5 progress callbacks
const CONTEXT_CLEANUP_PROBABILITY = 0.01; // 1% chance to cleanup correlation context
const ID_SLICE_LENGTH = -8; // Last 8 characters for job short IDs

// Channel history fetching constants
const MIN_CHANNEL_HISTORY = 10; // Minimum messages to fetch
const MAX_CHANNEL_HISTORY = 25; // Maximum messages to fetch

// Status emojis
const STATUS_EMOJI_PROCESSING = ':arrows_counterclockwise:';
const STATUS_EMOJI_THINKING = ':thinking_face:';
const STREAM_EMOJI = ':satellite:';

// =============================================================================
// MESSAGE CHUNKING UTILITIES
// =============================================================================

/**
 * Type guard: Check if message has a user property
 */
function hasUser(message: MessageEvent): message is MessageEvent & { user: string } {
  return 'user' in message && typeof message.user === 'string';
}

/**
 * Type guard: Check if message has text property
 */
function hasText(message: MessageEvent): message is MessageEvent & { text: string } {
  return 'text' in message && typeof message.text === 'string';
}

/**
 * Helper: Check if message is in a thread
 */
function isThreadMessage(message: MessageEvent): boolean {
  return 'thread_ts' in message && !!message.thread_ts;
}

/**
 * Helper: Safely get thread_ts from message
 */
function getThreadTs(message: MessageEvent): string | undefined {
  return 'thread_ts' in message ? message.thread_ts : undefined;
}

/**
 * Helper: Safely get user from message
 */
function getUser(message: MessageEvent): string {
  return hasUser(message) ? message.user : 'unknown';
}

/**
 * Split long messages into Slack-compatible chunks
 * First splits on intentional breaks (double line breaks), then handles Slack's 40k char limit
 *
 * @param text - The text to chunk
 * @param maxLength - Maximum chunk size (default: 40000)
 * @returns Array of message chunks
 */
function chunkMessage(text: string, maxLength: number = SLACK_MESSAGE_LIMIT): string[] {
  // First, split on intentional message breaks (double line breaks)
  // This allows the LLM to control message chunking naturally
  const segments = text.split(/\n\n+/);

  const chunks: string[] = [];

  // Process each segment
  for (const segment of segments) {
    const trimmedSegment = segment.trim();
    if (!trimmedSegment) continue;

    // If segment fits in Slack limit, use it as-is
    if (trimmedSegment.length <= maxLength) {
      chunks.push(trimmedSegment);
      continue;
    }

    // Segment is too long - split it further by lines, then words if needed
    let currentChunk = '';
    const lines = trimmedSegment.split('\n');

    for (const line of lines) {
      // If adding this line would exceed the limit, start a new chunk
      if (currentChunk.length + line.length + 1 > maxLength) {
        if (currentChunk.trim()) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }

        // If a single line is too long, split it by words
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
  }

  return chunks.length > 0 ? chunks : [text];
}

/**
 * Check if we should stream this partial response
 */
function shouldStreamPartialResponse(
  status: any,
  lastSentContent: string
): boolean {
  return !!(
    status.partialResponse &&
    status.partialResponse !== lastSentContent
  );
}

/**
 * Send message chunks with rate limiting
 */
async function sendMessageChunks(
  content: string,
  say: SayFn,
  thread_ts?: string,
  currentChunkCount: number = 0
): Promise<number> {
  const chunks = chunkMessage(content);
  let chunksAdded = 0;

  for (const chunk of chunks) {
    await say({
      text: chunk,
      thread_ts, // Maintain thread context
    });
    chunksAdded++;

    // Rate limiting: prevent Slack API abuse
    if (currentChunkCount + chunksAdded > 1) {
      await new Promise((resolve) => setTimeout(resolve, CHUNK_RATE_LIMIT_DELAY));
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
  return currentStatus !== lastStatus || updateCount % STATUS_UPDATE_INTERVAL === 0;
}

/**
 * Send complete response in chunks
 */
async function sendCompleteResponse(
  say: SayFn,
  result: string,
  thread_ts?: string
): Promise<number> {
  const chunks = chunkMessage(result);
  await say({
    text: chunks[0],
    thread_ts,
  });

  for (let i = 1; i < chunks.length; i++) {
    await say({
      text: chunks[i],
      thread_ts,
    });
    await new Promise((resolve) => setTimeout(resolve, CHUNK_RATE_LIMIT_DELAY));
  }

  return chunks.length;
}

// =============================================================================
// MAIN MESSAGE HANDLER SETUP
// =============================================================================

/**
 * Initialize Slack message handler with smart response detection
 *
 * Handles:
 * - Message deduplication
 * - Response condition detection (mentions, DMs, specific channels)
 * - Active response vs passive observation
 * - Error handling and telemetry
 *
 * @param app - Slack Bolt app instance
 */
export function setupMessageHandler(app: App) {
  app.message(async ({ message, say, client }) => {
    // Filter out non-message events and bot messages
    if (message.subtype || !('text' in message) || !('user' in message)) {
      return;
    }

    // Type assertion: we've checked text and user exist above
    const msgEvent = message as MessageEvent & { user: string; text: string };

    // -------------------------------------------------------------------------
    // CORRELATION & LOGGING SETUP
    // -------------------------------------------------------------------------

    const correlationId = CorrelationContext.getForMessage(msgEvent.ts);
    const shortId = getShortCorrelationId(correlationId);

    // Structured logging with correlation ID
    logger.info(`📨 Message received [${shortId}]`, {
      correlationId,
      userId: msgEvent.user,
      channelId: msgEvent.channel,
      messageTs: msgEvent.ts,
      contentLength: msgEvent.text?.length || 0,
      isThread: isThreadMessage(msgEvent),
      threadTs: getThreadTs(msgEvent),
    });

    // Track message received
    telemetry.incrementMessagesReceived(msgEvent.user);
    telemetry.logEvent(
      'message_received',
      {
        channelId: msgEvent.channel,
        contentLength: msgEvent.text?.length || 0,
        isThread: isThreadMessage(msgEvent),
      },
      correlationId,
      msgEvent.user
    );

    // -------------------------------------------------------------------------
    // RESPONSE CONDITION DETECTION
    // -------------------------------------------------------------------------

    // Get bot user ID for mention detection
    const authResponse = await client.auth.test();
    const botUserId = authResponse.user_id;

    // Check if bot was mentioned
    const botMentioned = msgEvent.text?.includes(`<@${botUserId}>`) || false;

    // Check if this is a DM
    const isDM = msgEvent.channel_type === 'im';

    // TODO: Add channel whitelist logic similar to Discord's guild whitelist
    // TODO: Add "robot channel" detection (channels with bot emoji or "bot" in name)

    // Determine response mode: active response vs passive observation
    const shouldRespond = botMentioned || isDM;

    try {
      // -------------------------------------------------------------------------
      // MESSAGE PROCESSING & DEDUPLICATION
      // -------------------------------------------------------------------------

      const fullMessage = msgEvent.text || '';
      const cleanMessage = fullMessage
        .replace(`<@${botUserId}>`, '') // Remove @bot mentions
        .trim();

      // Deduplication: prevent processing identical messages within TTL window
      const messageKey = `${msgEvent.user}-${fullMessage}-${msgEvent.channel}`;
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
        telemetry.logEvent('message_duplicate', { messageKey }, correlationId, msgEvent.user);
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
          userId: msgEvent.user,
          cleanMessage: cleanMessage.substring(0, 100) + (cleanMessage.length > 100 ? '...' : ''),
        });

        telemetry.logEvent(
          'message_will_respond',
          {
            messageLength: cleanMessage.length,
            triggerType: botMentioned ? 'mention' : isDM ? 'dm' : 'other',
          },
          correlationId,
          msgEvent.user
        );

        // Process with unified intent processor
        await handleMessageAsIntent(message as MessageEvent, cleanMessage, correlationId, say, client);
      } else {
        // PASSIVE OBSERVATION: Just process for learning, no response
        logger.info(`👁️ Passive observation [${shortId}]`, {
          correlationId,
          userId: msgEvent.user,
          channel: msgEvent.channel,
        });

        telemetry.logEvent(
          'message_observed',
          {
            channel: msgEvent.channel,
            messageLength: fullMessage.length,
          },
          correlationId,
          msgEvent.user
        );

        // Still process for passive observation using queue system
        await publishMessage(
          msgEvent.user,
          fullMessage,
          msgEvent.channel,
          msgEvent.user, // Slack doesn't have display names in message events
          false // Don't respond, just observe
        );
      }
    } catch (error) {
      logger.error(`❌ Error handling Slack message [${shortId}]:`, {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        userId: msgEvent.user,
        messageTs: msgEvent.ts,
      });

      telemetry.incrementMessagesFailed(
        msgEvent.user,
        error instanceof Error ? error.message : String(error)
      );
      telemetry.logEvent(
        'message_error',
        {
          error: error instanceof Error ? error.message : String(error),
        },
        correlationId,
        msgEvent.user,
        undefined,
        false
      );

      // ENHANCED: User-friendly error with transparency
      const errorMsg =
        error instanceof Error && error.message.length < 100
          ? `Sorry, I encountered an error: ${error.message}`
          : 'Sorry, I encountered an error processing your message. The issue has been logged.';

      await say({
        text: `❌ ${errorMsg}`,
        thread_ts: getThreadTs(msgEvent),
      });
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
 * Fetch recent channel history for context
 * Randomly fetches 10-25 messages to give Artie conversational context
 */
async function fetchChannelHistory(
  message: MessageEvent,
  client: any
): Promise<
  Array<{
    author: string;
    content: string;
    timestamp: string;
    isBot: boolean;
  }>
> {
  try {
    // Randomize how many messages to fetch (10-25)
    const limit = chance.integer({ min: MIN_CHANNEL_HISTORY, max: MAX_CHANNEL_HISTORY });

    // Fetch messages before the current one
    const result = await client.conversations.history({
      channel: message.channel,
      latest: message.ts,
      limit,
      inclusive: false,
    });

    if (!result.ok || !result.messages) {
      logger.warn('Failed to fetch channel history');
      return [];
    }

    // Convert to simple format for context
    return result.messages.reverse().map((msg: any) => ({
      author: msg.user || 'unknown',
      content: msg.text || '',
      timestamp: new Date(parseFloat(msg.ts) * 1000).toISOString(),
      isBot: msg.bot_id !== undefined,
    }));
  } catch (error) {
    logger.error('Failed to fetch channel history:', error);
    return [];
  }
}

/**
 * Simple adapter: Convert Slack message to UserIntent and delegate to unified processor
 * Mirrors Discord's handleMessageAsIntent architecture
 */
async function handleMessageAsIntent(
  message: MessageEvent,
  cleanMessage: string,
  correlationId: string,
  say: SayFn,
  client: any
): Promise<void> {
  const shortId = getShortCorrelationId(correlationId);
  let streamingMessageTs: string | null = null;

  // Type guard: Only handle messages with user and text
  if (!hasUser(message) || !hasText(message)) {
    logger.warn(`Skipping message without user or text [${shortId}]`);
    return;
  }

  try {
    // MINIMAL: No status messages - just start working like a human

    // ENHANCED: Fetch recent channel history for conversational context
    const channelHistory = await fetchChannelHistory(message, client);
    logger.info(`📜 Fetched ${channelHistory.length} recent messages for context [${shortId}]`);

    // ENHANCED: Gather Slack context for Context Alchemy
    const channelInfo = {
      channelId: message.channel,
      channelType: message.channel_type,
    };

    const userInfo = {
      userId: message.user,
      username: message.user, // Slack uses user IDs, not usernames in events
    };

    // ENHANCED: Thread-specific metadata
    const threadInfo = isThreadMessage(message)
      ? {
          isThread: true,
          threadTs: getThreadTs(message),
        }
      : null;

    const slackContext = {
      platform: 'slack',
      ...channelInfo,
      ...userInfo,
      ...threadInfo,
      messageTs: message.ts,
      timestamp: new Date(parseFloat(message.ts) * 1000).toISOString(),
    };

    // Create unified intent and delegate to shared processor
    await processUserIntent(
      {
        content: cleanMessage,
        userId: message.user,
        username: message.user,
        source: 'message',
        context: slackContext, // Pass rich Slack context
        metadata: {
          messageTs: message.ts,
          channelId: message.channel,
          threadTs: getThreadTs(message),
          correlationId,
        },

        // Response handlers
        respond: async (content: string): Promise<void> => {
          logger.info(`📨 SLACK RESPOND [${shortId}]:`, {
            correlationId,
            contentLength: content.length,
            contentPreview: content.substring(0, 100),
            messageTs: message.ts,
            channelId: message.channel,
          });

          const chunks = chunkMessage(content);
          logger.info(`📨 SLACK: Sending ${chunks.length} chunks [${shortId}]`);

          const responseMessage = await say({
            text: chunks[0],
            thread_ts: getThreadTs(message),
          });

          // Store reference for potential editing
          if (responseMessage && 'ts' in responseMessage) {
            streamingMessageTs = responseMessage.ts as string;
          }

          logger.info(`✅ SLACK: Sent first chunk [${shortId}]`, {
            responseMessageTs: streamingMessageTs,
            chunkLength: chunks[0].length,
          });

          // Send additional chunks
          for (let i = 1; i < chunks.length; i++) {
            logger.info(`📨 SLACK: Sending chunk ${i + 1}/${chunks.length} [${shortId}]`);
            await say({
              text: chunks[i],
              thread_ts: getThreadTs(message),
            });
            await new Promise((resolve) => setTimeout(resolve, CHUNK_RATE_LIMIT_DELAY));
          }

          telemetry.incrementResponsesDelivered(message.user, chunks.length);
          logger.info(`✅ SLACK: All ${chunks.length} chunks delivered [${shortId}]`);
        },

        // ENHANCED: Edit response capability for cleaner streaming
        editResponse: async (content: string) => {
          logger.info(`✏️ SLACK EDIT RESPONSE [${shortId}]:`, {
            correlationId,
            contentLength: content.length,
            contentPreview: content.substring(0, 100),
            hasStreamingMessage: !!streamingMessageTs,
            streamingMessageTs,
          });

          if (!streamingMessageTs) {
            logger.warn(`No streaming message to edit [${shortId}]`);
            return;
          }

          try {
            // Slack has 40k char limit for edits
            const truncatedContent =
              content.length > SLACK_MESSAGE_LIMIT
                ? content.slice(0, SLACK_MESSAGE_LIMIT - 3) + '...'
                : content;

            logger.info(`✏️ SLACK: Editing message ${streamingMessageTs} [${shortId}]`);
            await client.chat.update({
              channel: message.channel,
              ts: streamingMessageTs,
              text: truncatedContent,
            });
            logger.info(`✅ SLACK: Message edited successfully [${shortId}]`);

            telemetry.logEvent(
              'message_edited',
              {
                contentLength: content.length,
                truncated: content.length > SLACK_MESSAGE_LIMIT,
              },
              correlationId,
              'user' in message ? message.user : 'unknown'
            );
          } catch (error) {
            logger.error(`❌ SLACK: Failed to edit message [${shortId}]:`, error);
            throw error;
          }
        },

        // Slack doesn't have a typing indicator like Discord
        sendTyping: undefined,

        // ENHANCED: Slack-native reaction support
        addReaction: async (emoji: string) => {
          try {
            await client.reactions.add({
              channel: message.channel,
              timestamp: message.ts,
              name: emoji.replace(/:/g, ''), // Remove colons from emoji name
            });
            telemetry.logEvent(
              'reaction_added',
              { emoji },
              correlationId,
              'user' in message ? message.user : 'unknown'
            );
          } catch (error) {
            logger.warn(`Failed to add reaction ${emoji} [${shortId}]:`, error);
          }
        },

        removeReaction: async (emoji: string) => {
          try {
            await client.reactions.remove({
              channel: message.channel,
              timestamp: message.ts,
              name: emoji.replace(/:/g, ''),
            });
            telemetry.logEvent(
              'reaction_removed',
              { emoji },
              correlationId,
              'user' in message ? message.user : 'unknown'
            );
          } catch (error) {
            logger.warn(`Failed to remove reaction ${emoji} [${shortId}]:`, error);
          }
        },
      },
      {
        enableStreaming: true, // Enable streaming for messages
        enableTyping: false, // Slack doesn't have typing indicators
        enableReactions: false, // MINIMAL: No emoji reactions
        enableEditing: true, // Enable message editing for cleaner streaming
        enableThreading: false, // MINIMAL: No auto-threading
        maxAttempts: MAX_JOB_ATTEMPTS,
        statusUpdateInterval: STATUS_UPDATE_INTERVAL,
      }
    );

    // MINIMAL: No final status updates
  } catch (error) {
    logger.error(`Message intent processing failed [${shortId}]:`, error);

    // Fallback error handling
    try {
      await say({
        text: `❌ Sorry, I couldn't process your message`,
        thread_ts: 'thread_ts' in message ? message.thread_ts : undefined,
      });
    } catch (replyError) {
      logger.error(`Failed to send error reply [${shortId}]:`, replyError);
    }
  }
}
