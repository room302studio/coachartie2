import { createQueue, QUEUES, IncomingMessage, logger, isRedisAvailable } from '@coachartie/shared';
import type { Queue } from 'bullmq';

let messageQueue: Queue<IncomingMessage> | null = null;
let queueInitialized = false;

function getMessageQueue(): Queue<IncomingMessage> | null {
  if (!queueInitialized) {
    try {
      messageQueue = createQueue<IncomingMessage>(QUEUES.INCOMING_MESSAGES);
      queueInitialized = true;
    } catch (error) {
      logger.warn('Failed to create message queue - Redis may be unavailable');
      return null;
    }
  }
  return messageQueue;
}

export async function publishMessage(
  userId: string,
  message: string,
  channelId: string,
  userTag: string,
  shouldRespond: boolean = true
): Promise<void> {
  const queue = getMessageQueue();

  if (!queue) {
    logger.warn(`Message from ${userTag} not queued - Redis unavailable`);
    return;
  }

  const queueMessage: IncomingMessage = {
    id: `discord-${Date.now()}-${Math.random()}`,
    timestamp: new Date(),
    retryCount: 0,
    source: 'discord',
    userId,
    message,
    context: {
      userTag,
      platform: 'discord',
      shouldRespond,
    },
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
    // Don't throw - just log the error
  }
}
