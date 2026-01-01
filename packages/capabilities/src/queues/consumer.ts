import {
  createWorker,
  createQueue,
  QUEUES,
  IncomingMessage,
  OutgoingMessage,
  logger,
  queueLogger,
  performanceLogger,
  testRedisConnection,
} from '@coachartie/shared';
import { processMessage } from '../handlers/process-message.js';
import { jobTracker } from '../services/job-tracker.js';
import type { Worker } from 'bullmq';

export async function startMessageConsumer(): Promise<Worker<IncomingMessage, void> | null> {
  const redisHost = process.env.REDIS_HOST || 'localhost';
  const redisPort = process.env.REDIS_PORT || '47320';

  logger.info(`🔌 Checking Redis connection at ${redisHost}:${redisPort}...`);

  const redisOk = await testRedisConnection();

  if (!redisOk) {
    logger.warn(`⚠️ Redis unavailable at ${redisHost}:${redisPort} - queue processing disabled`);
    logger.warn('   Service will run in API-only mode (no queue workers)');
    return null;
  }

  logger.info('✅ Redis available - starting queue workers');

  const worker = createWorker<IncomingMessage, void>(QUEUES.INCOMING_MESSAGES, async (job) => {
    console.log(`📬 Processing job ${job.id} - SNOOKITY LOOKITY!`);
    const message = job.data;

    logger.info(`🔄 WORKER: Job ${job.id} pulled from queue:`, {
      jobId: job.id,
      messageId: message.id,
      userId: message.userId,
      source: message.source,
      respondToType: message.respondTo.type,
      messageLength: message.message.length,
      hasContext: !!message.context,
      contextKeys: message.context ? Object.keys(message.context) : [],
    });

    const timer = performanceLogger.startTimer(`Process message ${message.id}`);

    queueLogger.jobStarted('process-message', job.id!.toString(), {
      userId: message.userId,
      source: message.source,
      messageLength: message.message.length,
    });

    try {
      // Store message in database for context history (only for Discord messages)
      if (
        message.source === 'discord' ||
        (message.source === 'api' && message.context?.platform === 'discord')
      ) {
        try {
          const { database } = await import('../services/database.js');
          await database.run(
            `
              INSERT INTO messages (value, user_id, message_type, channel_id, guild_id, created_at)
              VALUES (?, ?, ?, ?, ?, datetime('now'))
            `,
            [
              message.message,
              message.userId,
              'discord',
              message.context?.channelId || message.respondTo?.channelId || null,
              message.context?.guildId || null,
            ]
          );
          logger.info(`💾 Stored Discord message in database for context history`);
        } catch (dbError) {
          logger.warn('Failed to store message in database:', dbError);
          // Continue processing even if storage fails
        }
      }

      // Update job status to processing (if it's from API)
      if (message.source === 'api' && message.respondTo.type === 'api') {
        jobTracker.markJobProcessing(message.id);
        logger.info(`📊 Job ${message.id} marked as processing`);
      }

      // CRITICAL: Global timeout to prevent infinite loops at ANY level
      // This catches hangs in capability retries, LLM loops, or any other processing
      const GLOBAL_TIMEOUT_MS = 300000; // 5 minutes - allow deep exploration to complete
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          const errorMsg = `Global job timeout after ${GLOBAL_TIMEOUT_MS / 1000}s - prevents infinite loops and resource exhaustion`;
          logger.error(`⏱️ TIMEOUT: ${errorMsg} for message ${message.id}`);
          reject(new Error(errorMsg));
        }, GLOBAL_TIMEOUT_MS);
      });

      // Race between actual processing and timeout
      const processingPromise = processMessage(message, (partial) => {
        // Update partial response for streaming (if it's from API)
        if (message.source === 'api' && message.respondTo.type === 'api') {
          jobTracker.updatePartialResponse(message.id, partial);
        }
      });

      // Always process the message for capability extraction and memory formation
      const response = await Promise.race([processingPromise, timeoutPromise]);

      // Check if we should respond (from context.shouldRespond)
      const shouldRespond = message.context?.shouldRespond !== false;

      if (!shouldRespond) {
        logger.info(`Passive observation completed for message ${message.id} - no response queued`);
        const duration = timer.end({ userId: message.userId, messageId: message.id });
        queueLogger.jobCompleted('process-message', job.id!.toString(), duration);
        return;
      }

      // Handle API responses differently - just log them and complete the job
      if (message.respondTo.type === 'api') {
        logger.info(`API Response for ${message.id}: ${response}`);
        logger.info(
          `API message processed successfully: ${(message.respondTo as { apiResponseId?: string })?.apiResponseId}`
        );
        // Mark job as complete
        jobTracker.completeJob(message.id, response);
        logger.info(`📊 Job ${message.id} marked as complete`);
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
            emailAddress: message.respondTo.emailAddress,
          },
        };

        await outgoingQueue.add('send-response', outgoingMessage);
        logger.info(`Response queued for ${message.respondTo.type} (${message.id})`);

        // Store Artie's response in the messages table (for Discord messages)
        if (
          message.source === 'discord' ||
          (message.source === 'api' && message.context?.platform === 'discord')
        ) {
          try {
            const { database } = await import('../services/database.js');
            await database.run(
              `
                INSERT INTO messages (value, user_id, message_type, channel_id, guild_id, role, related_message_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
              `,
              [
                response,
                'artie', // Artie is the author of this message
                'discord',
                message.context?.channelId || message.respondTo?.channelId || null,
                message.context?.guildId || null,
                'assistant', // Mark as assistant role
                message.id, // Links back to the user's message
              ]
            );
            logger.info(`Stored Artie's response in messages table (related to ${message.id})`);
          } catch (dbError) {
            logger.error('Failed to store Artie response in messages table:', dbError);
          }
        }
      }

      const duration = timer.end({
        userId: message.userId,
        messageId: message.id,
        responseLength: response.length,
      });
      queueLogger.jobCompleted('process-message', job.id!.toString(), duration);
    } catch (error) {
      timer.end({
        userId: message.userId,
        messageId: message.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      queueLogger.jobFailed('process-message', job.id!.toString(), error as Error);

      // Mark job as failed if it's from API
      if (message.source === 'api' && message.respondTo.type === 'api') {
        jobTracker.failJob(message.id, error instanceof Error ? error.message : 'Unknown error');
        logger.info(`📊 Job ${message.id} marked as failed`);
      }

      throw error; // Let BullMQ handle retries
    }
  });

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

function getOutgoingQueueName(type: 'discord' | 'slack' | 'sms' | 'email' | 'api' | 'irc'): string {
  switch (type) {
    case 'discord':
      return QUEUES.OUTGOING_DISCORD;
    case 'slack':
      return QUEUES.OUTGOING_SLACK;
    case 'sms':
      return QUEUES.OUTGOING_SMS;
    case 'email':
      return QUEUES.OUTGOING_EMAIL;
    case 'irc':
      return QUEUES.OUTGOING_IRC;
    default:
      throw new Error(`Unknown response type: ${type}`);
  }
}
