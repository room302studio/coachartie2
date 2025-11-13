import { createQueue, QUEUES, IncomingMessage, logger } from '@coachartie/shared';

const messageQueue = createQueue<IncomingMessage>(QUEUES.INCOMING_MESSAGES);

export async function publishMessage(
  userId: string,
  message: string,
  channelId: string,
  userName: string,
  shouldRespond: boolean = true
): Promise<void> {
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
    await messageQueue.add('process', queueMessage);
    logger.info(`Message queued for processing: ${queueMessage.id}`);
  } catch (error) {
    logger.error('Failed to queue message:', error);
    throw error;
  }
}
