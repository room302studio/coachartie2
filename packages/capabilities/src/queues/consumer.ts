import { 
  createWorker, 
  createQueue, 
  QUEUES, 
  IncomingMessage, 
  OutgoingMessage,
  logger 
} from '@coachartie/shared';
import { processMessage } from '../handlers/process-message.js';

export async function startMessageConsumer() {
  const worker = createWorker<IncomingMessage, void>(
    QUEUES.INCOMING_MESSAGES,
    async (job) => {
      const message = job.data;
      logger.info(`Processing message ${message.id} from ${message.source}`);

      try {
        // Process the message and get response
        const response = await processMessage(message);

        // Handle API responses differently - just log them
        if (message.respondTo.type === 'api') {
          logger.info(`API Response for ${message.id}: ${response}`);
          logger.info(`API message processed successfully: ${(message.respondTo as any).apiResponseId}`);
        } else {
          // Determine which outgoing queue to use for other types
          const outgoingQueueName = getOutgoingQueueName(message.respondTo.type);
          const outgoingQueue = createQueue<OutgoingMessage>(outgoingQueueName);

          // Send response to appropriate queue
          const outgoingMessage: OutgoingMessage = {
            id: `response-${Date.now()}-${Math.random()}`,
            timestamp: new Date(),
            retryCount: 0,
            source: 'capabilities',
            userId: message.userId,
            message: response,
            inReplyTo: message.id,
            metadata: {
              processedAt: new Date(),
              responseType: message.respondTo.type,
              channelId: message.respondTo.channelId,
              phoneNumber: message.respondTo.phoneNumber,
              emailAddress: message.respondTo.emailAddress
            }
          };

          await outgoingQueue.add('send-response', outgoingMessage);
          logger.info(`Response queued for ${message.respondTo.type} (${message.id})`);
        }

      } catch (error) {
        logger.error(`Error processing message ${message.id}:`, error);
        throw error; // Let BullMQ handle retries
      }
    }
  );

  // Event handlers
  worker.on('completed', (job) => {
    logger.info(`Message ${job.data.id} processed successfully`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`Message ${job?.data?.id} failed:`, err);
    // Could send to dead letter queue here
  });

  worker.on('error', (err) => {
    logger.error('Worker error:', err);
  });

  return worker;
}

function getOutgoingQueueName(type: 'discord' | 'sms' | 'email' | 'api'): string {
  switch (type) {
    case 'discord':
      return QUEUES.OUTGOING_DISCORD;
    case 'sms':
      return QUEUES.OUTGOING_SMS;
    case 'email':
      return QUEUES.OUTGOING_EMAIL;
    default:
      throw new Error(`Unknown response type: ${type}`);
  }
}