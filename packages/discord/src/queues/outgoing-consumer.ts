import { Worker } from 'bullmq';
import { testRedisConnection, logger } from '@coachartie/shared';
import { client } from '../index.js';

let worker: Worker | null = null;

// Initialize worker only if Redis is available
async function initWorker() {
  const redisOk = await testRedisConnection();
  if (!redisOk) {
    logger.warn('⚠️ Discord outgoing consumer: Redis unavailable - disabled');
    return;
  }

  const { createRedisConnection } = await import('@coachartie/shared');
  const connection = createRedisConnection();

  worker = new Worker(
    'coachartie-discord-outgoing',
    async (job) => {
      const { userId, content, source, channelId } = job.data;

      try {
        // Chunk the message to preserve formatting and respect Discord limits
        const chunks = chunkMessage(content);

        if (channelId) {
          // Send to channel
          const channel = await client.channels.fetch(channelId);
          if (channel?.isTextBased() && 'send' in channel) {
            for (const chunk of chunks) {
              await channel.send(chunk);
            }
          }
        } else {
          // Send DM to user
          const user = await client.users.fetch(userId);
          for (const chunk of chunks) {
            await user.send(chunk);
          }
        }

        logger.info(`✅ Sent ${source} message to ${userId || channelId} (${chunks.length} chunks)`);
      } catch (error) {
        logger.error(`❌ Failed to send message:`, error);
        throw error; // Retry via Bull
      }
    },
    { connection }
  );

  // Suppress connection errors (rate-limited in shared package)
  worker.on('error', () => {});
}

// Initialize asynchronously
initWorker().catch(() => {});

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

export default worker;
