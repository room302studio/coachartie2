import { createQueue } from './redis.js';
import { QUEUES } from './names.js';
import { IncomingMessage } from './types.js';
import { logger } from '../logger.js';
import type { Queue } from 'bullmq';

/**
 * The one INCOMING_MESSAGES producer. Wave 6 folded discord-publisher.ts (the gateway's
 * copy) into this file. The two copies differed, so the differences are options now:
 *   - the queue is created lazily on first publish (the gateway copy's behavior; the engine
 *     copy created it at module load), and a failed create is retried on the next publish;
 *   - guildId is optional (only the gateway passes it);
 *   - rethrow: false (the default, the gateway's behavior) logs a failed enqueue and returns;
 *     rethrow: true (the GitHub webhook handlers) throws, as the engine copy did.
 */

let messageQueue: Queue<IncomingMessage> | null = null;
let queueInitialized = false;

function getMessageQueue(): Queue<IncomingMessage> | null {
  if (!queueInitialized) {
    try {
      messageQueue = createQueue<IncomingMessage>(QUEUES.INCOMING_MESSAGES);
      queueInitialized = true;
    } catch {
      logger.warn('Failed to create message queue - Redis may be unavailable');
      return null;
    }
  }
  return messageQueue;
}

export interface PublishOptions {
  /** Throw on a failed enqueue instead of logging and returning (default false). */
  rethrow?: boolean;
}

export async function publishMessage(
  userId: string,
  message: string,
  channelId: string,
  userTag: string,
  shouldRespond: boolean = true,
  guildId?: string,
  options: PublishOptions = {}
): Promise<void> {
  const queue = getMessageQueue();

  if (!queue) {
    logger.warn(`Message from ${userTag} not queued - Redis unavailable`);
    if (options.rethrow) {
      throw new Error('Message queue unavailable - Redis may be unavailable');
    }
    return;
  }

  const context: Record<string, unknown> = {
    userTag,
    platform: 'discord',
    shouldRespond,
  };
  if (guildId) {
    context.guildId = guildId;
  }

  const queueMessage: IncomingMessage = {
    id: `discord-${Date.now()}-${Math.random()}`,
    timestamp: new Date(),
    retryCount: 0,
    source: 'discord',
    userId,
    message,
    context,
    respondTo: {
      type: 'discord',
      channelId,
    },
  };

  try {
    await queue.add('process', queueMessage);
    logger.info(`Message queued for processing: ${queueMessage.id}`);
  } catch (error) {
    logger.error('Failed to queue message:', error);
    if (options.rethrow) {
      throw error;
    }
    // Don't throw - just log the error
  }
}
