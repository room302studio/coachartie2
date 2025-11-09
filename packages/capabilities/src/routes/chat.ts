import { Router, Request, Response } from 'express';
import { logger, createQueue, QUEUES, IncomingMessage } from '@coachartie/shared';
import { processMessage } from '../handlers/process-message.js';
import { v4 as uuidv4 } from 'uuid';
import { rateLimiter } from '../middleware/rate-limiter.js';
import { jobTracker } from '../services/job-tracker.js';

const messageQueue = createQueue<IncomingMessage>(QUEUES.INCOMING_MESSAGES);

const router: Router = Router();

interface ChatRequest {
  message: string;
  userId?: string;
  context?: Record<string, any>; // Discord context including guildId, channelId
  source?: string; // Optional: specify 'discord' to enable Discord-specific features like UI modality rules
}

interface ChatResponse {
  success: boolean;
  messageId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  jobUrl: string;
  response?: string;
  error?: string;
  cancellationReason?: string;
  additionalContext?: string[];
}

// POST /chat - Process message and return AI response immediately (or wait with ?wait=true)
router.post('/', rateLimiter(50, 60000), async (req: Request, res: Response) => {
  try {
    const waitForResult = req.query.wait === 'true';

    logger.info(`🎯 POST /chat - Request received:`, {
      bodyKeys: Object.keys(req.body),
      hasMessage: !!req.body.message,
      hasUserId: !!req.body.userId,
      hasContext: !!req.body.context,
      waitForResult,
    });

    const { message, userId = 'api-user', context, source = 'api' }: ChatRequest = req.body;

    logger.info(`🎯 POST /chat - Extracted params:`, {
      message: message?.substring(0, 100),
      userId,
      contextKeys: context ? Object.keys(context) : [],
    });

    if (!message || typeof message !== 'string') {
      logger.warn(`❌ POST /chat - Invalid message:`, {
        hasMessage: !!message,
        messageType: typeof message,
      });
      return res.status(400).json({
        success: false,
        messageId: '',
        error:
          'Message is required and must be a string. Expected format: {"message": "your text here", "user_id": "optional-user-id"}',
      } as ChatResponse);
    }

    // Enhanced input validation for better error handling
    if (message.length > 10000) {
      return res.status(400).json({
        success: false,
        messageId: '',
        error: 'Message too long (max 10000 characters)',
      } as ChatResponse);
    }

    if (typeof userId !== 'string' || userId.length > 100) {
      return res.status(400).json({
        success: false,
        messageId: '',
        error:
          'Invalid userId format (must be a string, max 100 characters). Example: {"message": "hello", "user_id": "user-123"}',
      } as ChatResponse);
    }

    const messageId = uuidv4();
    logger.info(`🆔 Generated messageId: ${messageId}`);

    logger.info(`Processing chat message from ${userId}: ${message.substring(0, 100)}...`);

    // Create message object for processing
    const messageSource = source === 'discord' ? 'discord' : 'api';
    const incomingMessage: IncomingMessage = {
      id: messageId,
      timestamp: new Date(),
      retryCount: 0,
      source: messageSource,
      userId,
      message: message.trim(),
      context: context || {}, // Pass Discord context through
      respondTo: {
        type: 'api' as const,
        apiResponseId: messageId,
      },
    };

    logger.info(`📦 Created incomingMessage object:`, {
      id: incomingMessage.id,
      userId: incomingMessage.userId,
      source: incomingMessage.source,
      respondToType: incomingMessage.respondTo.type,
    });

    // Start tracking the job
    jobTracker.startJob(messageId, userId, message);
    logger.info(`📊 Started tracking job ${messageId} for user ${userId}`);

    // Add message to queue for processing
    try {
      logger.info(`➕ Adding message ${messageId} to queue...`);
      const job = await messageQueue.add('process', incomingMessage);
      logger.info(`✅ Message ${messageId} added to queue with job ID: ${job.id}`);

      // If wait=true, poll for result before responding
      if (waitForResult) {
        logger.info(`⏳ Waiting for job ${messageId} to complete...`);
        const maxWaitTime = 120000; // 2 minutes max
        const pollInterval = 100; // Poll every 100ms
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitTime) {
          const jobStatus = jobTracker.getJob(messageId);

          if (jobStatus?.status === 'completed') {
            logger.info(`✅ Job ${messageId} completed in ${Date.now() - startTime}ms`);
            return res.json({
              success: true,
              messageId,
              status: 'completed',
              jobUrl: `/chat/${messageId}`,
              response: jobStatus.result,
            } as ChatResponse);
          } else if (jobStatus?.status === 'failed') {
            logger.error(`❌ Job ${messageId} failed: ${jobStatus.error}`);
            return res.json({
              success: false,
              messageId,
              status: 'failed',
              jobUrl: `/chat/${messageId}`,
              error: jobStatus.error,
            } as ChatResponse);
          }

          // Wait before next poll
          await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        // Timeout - return pending status
        logger.warn(`⏰ Job ${messageId} timed out after ${maxWaitTime}ms`);
        return res.json({
          success: true,
          messageId,
          status: 'pending',
          jobUrl: `/chat/${messageId}`,
          error: 'Request timeout - job still processing',
        } as ChatResponse);
      }

      // Construct response
      const response: ChatResponse = {
        success: true,
        messageId,
        status: 'pending',
        jobUrl: `/chat/${messageId}`,
      };

      logger.info(`📤 Sending response to client:`, {
        success: response.success,
        messageId: response.messageId,
        messageIdExists: !!response.messageId,
        messageIdType: typeof response.messageId,
        status: response.status,
        jobUrl: response.jobUrl,
      });

      // Return job info immediately
      res.json(response);
    } catch (queueError) {
      logger.error(`Failed to queue message ${messageId}:`, queueError);
      // Mark job as failed if queuing fails
      jobTracker.failJob(messageId, 'Failed to queue message');
      throw queueError;
    }
  } catch (error) {
    logger.error('Error in chat endpoint:', error);
    res.status(500).json({
      success: false,
      messageId: '',
      error: 'Internal server error',
    } as ChatResponse);
  }
});

// GET /chat/health - Simple health check for chat endpoint
router.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    endpoint: 'chat',
    timestamp: new Date().toISOString(),
  });
});

// GET /chat/_stats - Job tracker statistics (for debugging)
router.get('/_stats', (req: Request, res: Response) => {
  try {
    const stats = jobTracker.getStats();
    res.json({
      success: true,
      stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error getting job stats:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

// DELETE /chat/:messageId - Cancel a running job
router.delete('/:messageId', (req: Request, res: Response) => {
  try {
    const { messageId } = req.params;
    const { reason } = req.body;

    if (!messageId) {
      return res.status(400).json({
        success: false,
        error: 'Message ID is required',
      });
    }

    const cancelled = jobTracker.cancelJob(messageId, reason || 'User requested cancellation');

    if (!cancelled) {
      return res.status(404).json({
        success: false,
        error: 'Job not found or cannot be cancelled',
      });
    }

    logger.info(`🛑 Job ${messageId} cancelled via API`);

    res.json({
      success: true,
      messageId,
      status: 'cancelled',
      message: 'Job cancelled successfully',
    });
  } catch (error) {
    logger.error('Error cancelling job:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

// PATCH /chat/:messageId - Add context to a running job
router.patch('/:messageId', (req: Request, res: Response) => {
  try {
    const { messageId } = req.params;
    const { context } = req.body;

    if (!messageId) {
      return res.status(400).json({
        success: false,
        error: 'Message ID is required',
      });
    }

    if (!context || typeof context !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Context is required and must be a string',
      });
    }

    const added = jobTracker.addJobContext(messageId, context);

    if (!added) {
      return res.status(404).json({
        success: false,
        error: 'Job not found or cannot be modified',
      });
    }

    logger.info(`📝 Context added to job ${messageId} via API`);

    // Return updated job info
    const job = jobTracker.getJob(messageId);
    if (job) {
      res.json({
        success: true,
        messageId,
        status: job.status,
        message: 'Context added successfully',
        additionalContext: job.additionalContext,
      });
    } else {
      res.json({
        success: true,
        messageId,
        message: 'Context added successfully',
      });
    }
  } catch (error) {
    logger.error('Error adding context to job:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

// GET /chat/:messageId - Check job status and get result (MUST BE LAST)
router.get('/:messageId', (req: Request, res: Response) => {
  try {
    logger.info(`🔍 GET /chat/:messageId - Request received:`, {
      messageId: req.params.messageId,
      messageIdLength: req.params.messageId?.length,
      messageIdType: typeof req.params.messageId,
      fullUrl: req.url,
      method: req.method,
    });

    const { messageId } = req.params;

    if (!messageId) {
      logger.warn(`❌ GET /chat/:messageId - Missing messageId`);
      return res.status(400).json({
        success: false,
        error: 'Message ID is required',
      });
    }

    logger.info(`🔍 Looking up job ${messageId} in tracker...`);
    const job = jobTracker.getJob(messageId);

    logger.info(`🔍 Job lookup result for ${messageId}:`, {
      found: !!job,
      status: job?.status,
      hasResult: !!job?.result,
      hasError: !!job?.error,
    });

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job not found or expired',
      });
    }

    // Calculate processing time
    const processingTime = job.endTime
      ? job.endTime.getTime() - job.startTime.getTime()
      : Date.now() - job.startTime.getTime();

    const response: ChatResponse = {
      success: true,
      messageId: job.messageId,
      status: job.status,
      jobUrl: `/chat/${messageId}`,
    };

    // Add result, error, or cancellation info based on status
    if (job.status === 'completed' && job.result) {
      response.response = job.result;
    } else if (job.status === 'failed' && job.error) {
      response.error = job.error;
    } else if (job.status === 'cancelled') {
      response.cancellationReason = job.cancellationReason;
    } else if ((job.status === 'processing' || job.status === 'pending') && job.partialResponse) {
      // Include partial response for streaming
      (response as any).partialResponse = job.partialResponse;
      (response as any).lastStreamUpdate = job.lastStreamUpdate?.toISOString();
    }

    // Add additional context if present
    if (job.additionalContext && job.additionalContext.length > 0) {
      response.additionalContext = job.additionalContext;
    }

    // Add timing info for debugging
    (response as any).processingTime = processingTime;
    (response as any).startTime = job.startTime.toISOString();
    if (job.endTime) {
      (response as any).endTime = job.endTime.toISOString();
    }

    logger.info(`📊 Job status check for ${messageId}: ${job.status} (${processingTime}ms)`);

    res.json(response);
  } catch (error) {
    logger.error('Error checking job status:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

export { router as chatRouter };
