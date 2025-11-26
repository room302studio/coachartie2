import { createQueue, QUEUES, IncomingMessage, logger } from '@coachartie/shared';
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
  userName: string,
  shouldRespond: boolean = true
): Promise<void> {
  const queue = getMessageQueue();

  if (!queue) {
    logger.warn(`Message from ${userName} not queued - Redis unavailable`);
    return;
  }

  const queueMessage: IncomingMessage = {
    id: `slack-${Date.now()}-${Math.random()}`,
    timestamp: new Date(),
    retryCount: 0,
    source: 'slack',
    userId,
    message,
    context: {
      userName,
      platform: 'slack',
      shouldRespond,
    },
    respondTo: {
      type: 'slack',
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
