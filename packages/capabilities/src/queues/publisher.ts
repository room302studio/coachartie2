import { createQueue, QUEUES, IncomingMessage, logger } from '@coachartie/shared';

// Create queue instances for different message types
const incomingQueue = createQueue<IncomingMessage>(QUEUES.INCOMING_MESSAGES);
const discordOutgoingQueue = createQueue<any>(QUEUES.OUTGOING_DISCORD);
const smsOutgoingQueue = createQueue<any>(QUEUES.OUTGOING_SMS);
const emailOutgoingQueue = createQueue<any>(QUEUES.OUTGOING_EMAIL);

export async function publishMessage(
  queueName: keyof typeof QUEUES,
  messageData: any
): Promise<void> {
  try {
    switch (queueName) {
      case 'INCOMING_MESSAGES':
        await incomingQueue.add('process', messageData);
        break;
      case 'OUTGOING_DISCORD':
        await discordOutgoingQueue.add('send', messageData);
        break;
      case 'OUTGOING_SMS':
        await smsOutgoingQueue.add('send', messageData);
        break;
      case 'OUTGOING_EMAIL':
        await emailOutgoingQueue.add('send', messageData);
        break;
      default:
        throw new Error(`Unknown queue: ${queueName}`);
    }

    logger.info(`Message published to ${queueName}`, { 
      messageId: messageData.id || 'unknown',
      source: messageData.source || 'unknown'
    });

  } catch (error) {
    logger.error(`Failed to publish message to ${queueName}:`, error);
    throw error;
  }
}

export async function publishIncomingMessage(
  userId: string,
  message: string,
  source: string = 'system',
  metadata?: any
): Promise<void> {
  const queueMessage: IncomingMessage = {
    id: `${source}-${Date.now()}-${Math.random()}`,
    timestamp: new Date(),
    retryCount: 0,
    source,
    userId,
    message,
    context: {
      platform: source,
      shouldRespond: true,
      ...metadata
    }
  };

  await publishMessage('INCOMING_MESSAGES', queueMessage);
}

export async function publishDiscordMessage(
  message: string,
  userId: string,
  source: string = 'system',
  metadata?: any
): Promise<void> {
  const discordMessage = {
    message,
    userId,
    source,
    timestamp: new Date().toISOString(),
    metadata
  };

  await publishMessage('OUTGOING_DISCORD', discordMessage);
}