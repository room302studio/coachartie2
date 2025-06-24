import { createQueue, QUEUES, IncomingMessage, logger } from '@coachartie/shared';

const messageQueue = createQueue<IncomingMessage>(QUEUES.INCOMING_MESSAGES);

export async function publishMessage(
  userId: string,
  message: string,
  channelId: string,
  userTag: string
): Promise<void> {
  const queueMessage: IncomingMessage = {
    id: `discord-${Date.now()}-${Math.random()}`,
    timestamp: new Date(),
    retryCount: 0,
    source: 'discord',
    userId,
    message,
    context: {
      userTag,
      platform: 'discord'
    },
    respondTo: {
      type: 'discord',
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