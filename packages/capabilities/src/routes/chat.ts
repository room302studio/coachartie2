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

// POST /chat - Process message and return AI response immediately
router.post('/', rateLimiter(50, 60000), async (req: Request, res: Response) => {
  try {
    const { message, userId = 'api-user', context }: ChatRequest = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({
        success: false,
        messageId: '',
        error: 'Message is required and must be a string',
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
        error: 'Invalid userId format',
      } as ChatResponse);
    }

    const messageId = uuidv4();

    logger.info(`Processing chat message from ${userId}: ${message.substring(0, 100)}...`);

    // Create message object for processing
    const incomingMessage: IncomingMessage = {
      id: messageId,
      timestamp: new Date(),
      retryCount: 0,
      source: 'api' as const,
      userId,
      message: message.trim(),
      context: context || {}, // Pass Discord context through
      respondTo: {
        type: 'api' as const,
        apiResponseId: messageId,
      },
    };

    // Start tracking the job
    jobTracker.startJob(messageId, userId, message);
    logger.info(`📊 Started tracking job ${messageId} for user ${userId}`);

    // Add message to queue for processing
    try {
      const job = await messageQueue.add('process', incomingMessage);
      logger.info(`✅ Message ${messageId} added to queue with job ID: ${job.id}`);

      // Return job info immediately
      res.json({
        success: true,
        messageId,
        status: 'pending',
        jobUrl: `/chat/${messageId}`,
      } as ChatResponse);
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
    const { messageId } = req.params;

    if (!messageId) {
      return res.status(400).json({
        success: false,
        error: 'Message ID is required',
      });
    }

    const job = jobTracker.getJob(messageId);

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
