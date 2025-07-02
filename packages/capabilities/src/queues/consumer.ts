import { 
  createWorker, 
  createQueue, 
  QUEUES, 
  IncomingMessage, 
  OutgoingMessage,
  logger,
  queueLogger,
  performanceLogger
} from '@coachartie/shared';
import { processMessage } from '../handlers/process-message.js';

export async function startMessageConsumer() {
  const worker = createWorker<IncomingMessage, void>(
    QUEUES.INCOMING_MESSAGES,
    async (job) => {
      const message = job.data;
      const timer = performanceLogger.startTimer(`Process message ${message.id}`);
      
      queueLogger.jobStarted('process-message', job.id!.toString(), {
        userId: message.userId,
        source: message.source,
        messageLength: message.message.length
      });

      try {
        // Always process the message for capability extraction and memory formation
        const response = await processMessage(message);

        // Check if we should respond (from context.shouldRespond)
        const shouldRespond = message.context?.shouldRespond !== false;

        if (!shouldRespond) {
          logger.info(`Passive observation completed for message ${message.id} - no response queued`);
          const duration = timer.end({ userId: message.userId, messageId: message.id });
          queueLogger.jobCompleted('process-message', job.id!.toString(), duration);
          return;
        }

        // Handle API responses differently - just log them
        if (message.respondTo.type === 'api') {
          logger.info(`API Response for ${message.id}: ${response}`);
          logger.info(`API message processed successfully: ${(message.respondTo as { apiResponseId?: string })?.apiResponseId}`);
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

        const duration = timer.end({ 
          userId: message.userId, 
          messageId: message.id,
          responseLength: response.length
        });
        queueLogger.jobCompleted('process-message', job.id!.toString(), duration);

      } catch (error) {
        timer.end({ 
          userId: message.userId, 
          messageId: message.id,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        queueLogger.jobFailed('process-message', job.id!.toString(), error as Error);
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