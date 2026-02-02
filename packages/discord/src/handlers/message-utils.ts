/**
 * Message Utilities - Chunking, constants, and helper functions
 *
 * Pure utility functions for Discord message handling with no side effects.
 */

import { Message, ChannelType } from 'discord.js';
import { logger } from '@coachartie/shared';

// =============================================================================
// CONSTANTS & CONFIGURATION
// =============================================================================

/** Message deduplication cache TTL in milliseconds */
export const MESSAGE_CACHE_TTL = 10000; // 10 seconds

/** Refresh typing indicator every 8s (Discord typing lasts 10s) */
export const TYPING_REFRESH_INTERVAL = 8000;

/** Delay between message chunks to avoid rate limiting */
export const CHUNK_RATE_LIMIT_DELAY = 200; // 200ms

/** Maximum job polling attempts (~5 minute timeout with 3s checks) */
export const MAX_JOB_ATTEMPTS = 100;

/** Discord's maximum message length */
export const DISCORD_MESSAGE_LIMIT = 2000;

/** Update status every N progress callbacks */
export const STATUS_UPDATE_INTERVAL = 5;

/** Probability of running correlation context cleanup */
export const CONTEXT_CLEANUP_PROBABILITY = 0.01; // 1%

/** Characters to slice for short IDs */
export const ID_SLICE_LENGTH = -8;

/** Discord guild text channel type */
export const GUILD_CHANNEL_TYPE = 0;

/** Minimum messages to fetch for channel history */
export const MIN_CHANNEL_HISTORY = 10;

/** Maximum messages to fetch for channel history */
export const MAX_CHANNEL_HISTORY = 25;

// Status emojis
export const STATUS_EMOJI_PROCESSING = '🔄';
export const STATUS_EMOJI_THINKING = '🤔';
export const STREAM_EMOJI = '📡';

// =============================================================================
// CHANNEL TYPE DETECTION
// =============================================================================

/**
 * Check if channel name indicates robot interaction
 */
export function isRobotChannelName(channel: Message['channel']): boolean {
  return (
    (channel.type === GUILD_CHANNEL_TYPE &&
      'name' in channel &&
      (channel.name?.includes('🤖') || channel.name?.includes('robot'))) ||
    false
  );
}

/**
 * Check if message is in a forum thread (Discord Discussions)
 */
export async function isForumThread(message: Message): Promise<boolean> {
  if (
    message.channel.type !== ChannelType.PublicThread &&
    message.channel.type !== ChannelType.PrivateThread
  ) {
    return false;
  }

  // Get the parent channel to check if it's a forum
  const parent = message.channel.parent;
  return parent?.type === ChannelType.GuildForum;
}

// =============================================================================
// MESSAGE CHUNKING
// =============================================================================

/**
 * Split long messages into Discord-compatible chunks with smart code block handling
 *
 * Features:
 * - NEVER splits inside code blocks (``` ... ```)
 * - Prefers splitting at paragraph boundaries (\n\n)
 * - Falls back to line boundaries, then word boundaries
 * - Keeps the 2000 char limit for Discord
 * - Handles edge cases like oversized code blocks
 *
 * @param text - The text to chunk
 * @param maxLength - Maximum chunk size (default: 2000)
 * @returns Array of message chunks
 */
export function chunkMessage(text: string, maxLength: number = DISCORD_MESSAGE_LIMIT): string[] {
  if (!text || text.length === 0) return [];
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];

  // Step 1: Identify all code blocks and their positions
  interface CodeBlock {
    start: number;
    end: number;
    content: string;
    language?: string;
  }

  const codeBlocks: CodeBlock[] = [];
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    codeBlocks.push({
      start: match.index,
      end: match.index + match[0].length,
      content: match[0],
      language: match[1],
    });
  }

  // Step 2: Split text into segments (code blocks and text between them)
  interface Segment {
    content: string;
    isCodeBlock: boolean;
    start: number;
    end: number;
  }

  const segments: Segment[] = [];
  let lastIndex = 0;

  for (const block of codeBlocks) {
    // Add text before code block
    if (block.start > lastIndex) {
      segments.push({
        content: text.slice(lastIndex, block.start),
        isCodeBlock: false,
        start: lastIndex,
        end: block.start,
      });
    }

    // Add code block
    segments.push({
      content: block.content,
      isCodeBlock: true,
      start: block.start,
      end: block.end,
    });

    lastIndex = block.end;
  }

  // Add remaining text after last code block
  if (lastIndex < text.length) {
    segments.push({
      content: text.slice(lastIndex),
      isCodeBlock: false,
      start: lastIndex,
      end: text.length,
    });
  }

  // Step 3: Build chunks respecting code block boundaries
  let currentChunk = '';

  for (const segment of segments) {
    if (segment.isCodeBlock) {
      // Code block - must be kept intact
      const segmentLength = segment.content.length;

      // If adding this code block would exceed limit, flush current chunk first
      if (currentChunk.length > 0 && currentChunk.length + segmentLength + 1 > maxLength) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }

      // If code block itself is too large, handle specially
      if (segmentLength > maxLength) {
        // Flush any pending content first
        if (currentChunk.trim()) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }

        // Split large code block while maintaining syntax
        // Extract language and content
        const codeMatch = segment.content.match(/```(\w+)?\n([\s\S]*?)```/);
        if (codeMatch) {
          const language = codeMatch[1] || '';
          const codeContent = codeMatch[2];
          const codeLines = codeContent.split('\n');

          let codeChunk = '';
          const opener = `\`\`\`${language}\n`;
          const closer = '\n```';
          const overhead = opener.length + closer.length;

          for (const line of codeLines) {
            const testChunk = codeChunk + (codeChunk ? '\n' : '') + line;

            if (testChunk.length + overhead > maxLength) {
              // Flush current code chunk
              if (codeChunk) {
                chunks.push(opener + codeChunk + closer);
                codeChunk = '';
              }

              // If single line is too long, split it (rare but possible)
              if (line.length + overhead > maxLength) {
                // Split line into smaller pieces
                const safeLength = maxLength - overhead;
                for (let i = 0; i < line.length; i += safeLength) {
                  const piece = line.slice(i, i + safeLength);
                  chunks.push(opener + piece + closer);
                }
              } else {
                codeChunk = line;
              }
            } else {
              codeChunk = testChunk;
            }
          }

          // Flush remaining code
          if (codeChunk) {
            chunks.push(opener + codeChunk + closer);
          }
        } else {
          // Fallback: just truncate with warning
          chunks.push(segment.content.slice(0, maxLength - 20) + '\n... (truncated)');
        }

        continue;
      }

      // Normal-sized code block - add to current chunk
      currentChunk += (currentChunk ? '\n' : '') + segment.content;
    } else {
      // Regular text - preserve newlines while respecting Discord's char limit
      // This is CRITICAL for markdown formatting (headers, lists, paragraphs)
      const textContent = segment.content;

      // Split on double newlines to find paragraphs, but keep the delimiters
      const paragraphParts = textContent.split(/(\n\n+)/);

      for (const part of paragraphParts) {
        // Check if this is a paragraph delimiter (double+ newlines)
        const isDelimiter = /^\n\n+$/.test(part);

        if (isDelimiter) {
          // Preserve paragraph breaks - normalize to double newline
          if (currentChunk.length + 2 <= maxLength) {
            currentChunk += '\n\n';
          } else {
            // Flush and start fresh with the delimiter
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

              // If single word is too long, split it (rare but possible)
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
    }
  }

  // Flush any remaining content
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks.length > 0 ? chunks : [text];
}

// =============================================================================
// STREAMING & STATUS UTILITIES
// =============================================================================

/**
 * Check if we should stream this partial response
 */
export function shouldStreamPartialResponse(
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
export async function sendMessageChunks(
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
      await new Promise((resolve) => setTimeout(resolve, CHUNK_RATE_LIMIT_DELAY));
    }
  }

  return chunksAdded;
}

/**
 * Check if status message should be updated
 */
export function shouldUpdateStatus(
  currentStatus: string,
  lastStatus: string,
  updateCount: number
): boolean {
  return currentStatus !== lastStatus || updateCount % STATUS_UPDATE_INTERVAL === 0;
}

/**
 * Update the status message with current progress
 */
export async function updateStatusMessage(
  statusMessage: Message,
  status: any,
  streamedChunks: number,
  shortId: string,
  jobShortId: string
): Promise<void> {
  const statusEmoji =
    status.status === 'processing' ? STATUS_EMOJI_PROCESSING : STATUS_EMOJI_THINKING;
  const streamEmoji = streamedChunks > 0 ? ` ${STREAM_EMOJI}` : '';

  // Human-friendly status messages without technical clutter
  let statusText = status.status === 'processing' ? 'Processing' : 'Working on it';
  const statusContent = `${statusEmoji}${streamEmoji} ${statusText}...`;

  await statusMessage.edit(statusContent);
}

/**
 * Send complete response in chunks
 */
export async function sendCompleteResponse(message: Message, result: string): Promise<number> {
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
// MESSAGE DEDUPLICATION
// =============================================================================

/** Message deduplication cache */
export const messageCache = new Map<string, number>();

/** Proactive answering cooldown cache (guildId -> lastProactiveAnswerTimestamp) */
export const proactiveCooldownCache = new Map<string, number>();

/**
 * Check if message is a duplicate (seen within TTL window)
 * Also cleans up expired entries
 */
export function isDuplicateMessage(
  authorId: string,
  content: string,
  channelId: string
): boolean {
  const messageKey = `${authorId}-${content}-${channelId}`;
  const now = Date.now();

  // Cleanup expired cache entries
  for (const [key, timestamp] of messageCache.entries()) {
    if (now - timestamp > MESSAGE_CACHE_TTL) {
      messageCache.delete(key);
    }
  }

  // Check for duplicate
  if (messageCache.has(messageKey)) {
    return true;
  }

  // Cache this message
  messageCache.set(messageKey, now);
  return false;
}

/**
 * Check if proactive answering is on cooldown for a guild
 */
export function isProactiveOnCooldown(guildId: string, cooldownSeconds: number): boolean {
  const lastProactive = proactiveCooldownCache.get(guildId) || 0;
  const timeSinceLast = (Date.now() - lastProactive) / 1000;
  return timeSinceLast < cooldownSeconds;
}

/**
 * Get remaining cooldown time in seconds
 */
export function getProactiveCooldownRemaining(guildId: string, cooldownSeconds: number): number {
  const lastProactive = proactiveCooldownCache.get(guildId) || 0;
  const timeSinceLast = (Date.now() - lastProactive) / 1000;
  return Math.max(0, Math.round(cooldownSeconds - timeSinceLast));
}

/**
 * Update proactive cooldown timestamp
 */
export function updateProactiveCooldown(guildId: string): void {
  proactiveCooldownCache.set(guildId, Date.now());
}
