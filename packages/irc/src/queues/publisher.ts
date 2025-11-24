import { createQueue, QUEUES, IncomingMessage, logger } from '@coachartie/shared';

const messageQueue = createQueue<IncomingMessage>(QUEUES.INCOMING_MESSAGES);

interface PublishMessageOptions {
  userId: string;
  message: string;
  context?: Record<string, any>;
  respondTo: {
    type: any; // Will be 'irc' once we update types
    channelId?: string;
    threadId?: string;
  };
}

export async function publishMessage(options: PublishMessageOptions): Promise<void> {
  const queueMessage: IncomingMessage = {
    id: `irc-${Date.now()}-${Math.random()}`,
    timestamp: new Date(),
    retryCount: 0,
    source: 'irc' as any, // Will be properly typed once we update shared types
    userId: options.userId,
    message: options.message,
    context: {
      platform: 'irc',
      ...options.context,
    },
    respondTo: options.respondTo,
  };

  try {
    await messageQueue.add('process', queueMessage);
    logger.info(`IRC message queued for processing: ${queueMessage.id}`, {
      userId: options.userId,
      target: options.respondTo.channelId,
      preview: options.message.substring(0, 50) + (options.message.length > 50 ? '...' : ''),
    });
  } catch (error) {
    logger.error('Failed to queue IRC message:', error);
    throw error;
  }
}
