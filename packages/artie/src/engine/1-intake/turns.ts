import { Router, Request, Response } from 'express';
import { delay } from '../../shared/async.js';
import { logger } from '../../shared/logger.js';
import { IncomingMessage } from '../../shared/queue/types.js';
import { engineDeps, defaultEngineDeps, type EngineDeps } from '../deps.js';
import { v4 as uuidv4 } from 'uuid';
import { rateLimiter } from './rate-limiter.js';
import { jobTracker } from './job-tracker.js';
import { getPendingAttachments } from '../3-context/assemble.js';
import { type ApiResult, sendResult } from '../../shared/api-result.js';

// Wave 9: POST /chat, GET /chat/:id, its /stream and /pending-attachments are functions
// (submitTurn, getTurn, watchTurn, takePendingAttachments) that the routes and engine/api.ts
// share. They return the status + JSON the route used to send.
const reply = <T = any>(status: number, body: T): ApiResult<T> => ({ status, body });

const router: Router = Router();

/**
 * Map source string to canonical source type.
 */
function getMessageSource(source: string): 'discord' | 'slack' | 'api' {
  if (source === 'discord') {
    return 'discord';
  }
  if (source === 'slack') {
    return 'slack';
  }
  return 'api';
}

/**
 * Calculate processing time in milliseconds.
 */
function calculateProcessingTime(startTime: Date, endTime: Date | undefined): number {
  if (endTime) {
    return endTime.getTime() - startTime.getTime();
  }
  return Date.now() - startTime.getTime();
}

export interface ChatRequest {
  message: string;
  userId?: string;
  context?: Record<string, any>; // Platform context including Discord (guildId, channelId) or Slack (channelId, channelType)
  source?: string; // Optional: specify 'discord' or 'slack' to enable platform-specific features like UI modality rules
}

export interface ChatResponse {
  success: boolean;
  messageId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  jobUrl: string;
  response?: string;
  error?: string;
  cancellationReason?: string;
  additionalContext?: string[];
  partialResponse?: string;
  lastStreamUpdate?: string;
  processingTime?: number;
  startTime?: string;
  endTime?: string;
}

// POST /chat - Process message and return AI response immediately (or wait with ?wait=true)
router.post('/', rateLimiter(50, 60000), async (req: Request, res: Response) =>
  sendResult(res, await submitTurn(req.body, { wait: req.query.wait === 'true', deps: engineDeps(req) }))
);

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

/**
 * GET /chat/:messageId/stream's event loop, without the HTTP: sends 'status', then polls the
 * job tracker every 500ms and sends 'progress' / 'complete' / 'timeout' / 'error' exactly as
 * the SSE route always did (wave 9: job-watcher.ts watches turns in-process through this).
 * `end` is called once the stream is over. Returns false when it ended immediately (no such
 * job, or already finished), true while it keeps polling.
 */
export function watchTurn(
  messageId: string,
  sendEvent: (event: string, data: any) => void,
  end: () => void
): boolean {
  // Send initial status
  const job = jobTracker.getJob(messageId);
  if (!job) {
    sendEvent('error', { error: 'Job not found' });
    end();
    return false;
  }

  sendEvent('status', { status: job.status, messageId });

  // If already complete, send result and close
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    let processingTime: number;
    if (job.endTime) {
      processingTime = job.endTime.getTime() - job.startTime.getTime();
    } else {
      processingTime = 0;
    }
    sendEvent('complete', {
      status: job.status,
      response: job.result,
      error: job.error,
      processingTime,
    });
    end();
    return false;
  }

  // Poll internally until complete (but client doesn't need to poll!)
  const maxWait = 300000; // 5 minutes
  const pollInterval = 500; // Check every 500ms internally
  const startTime = Date.now();

  const checkJob = async () => {
    const currentJob = jobTracker.getJob(messageId);

    if (!currentJob) {
      sendEvent('error', { error: 'Job disappeared' });
      end();
      return;
    }

    if (
      currentJob.status === 'completed' ||
      currentJob.status === 'failed' ||
      currentJob.status === 'cancelled'
    ) {
      let processingTime: number;
      if (currentJob.endTime) {
        processingTime = currentJob.endTime.getTime() - currentJob.startTime.getTime();
      } else {
        processingTime = 0;
      }
      sendEvent('complete', {
        status: currentJob.status,
        response: currentJob.result,
        error: currentJob.error,
        processingTime,
      });
      end();
      return;
    }

    // Send progress update if partial response available
    if (currentJob.partialResponse) {
      sendEvent('progress', { partial: currentJob.partialResponse });
    }

    // Check timeout
    if (Date.now() - startTime > maxWait) {
      sendEvent('timeout', { error: 'Job timed out' });
      end();
      return;
    }

    // Schedule next check
    setTimeout(checkJob, pollInterval);
  };

  // Start checking
  setTimeout(checkJob, pollInterval);
  return true;
}

// GET /chat/:messageId/stream - SSE endpoint for real-time job status (no polling!)
router.get('/:messageId/stream', async (req: Request, res: Response) => {
  const { messageId } = req.params;

  if (!messageId) {
    return res.status(400).json({ error: 'Message ID required' });
  }

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  const sendEvent = (event: string, data: any) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  if (!watchTurn(messageId, sendEvent, () => res.end())) return;

  // Handle client disconnect
  req.on('close', () => {
    logger.info(`📡 SSE client disconnected for job ${messageId}`);
  });
});

// GET /chat/:messageId - Check job status and get result (MUST BE LAST)
router.get('/:messageId', (req: Request, res: Response) => sendResult(res, getTurn(req.params)));

// GET /chat/pending-attachments/:turnId - Get and clear pending file attachments for a turn
router.get('/pending-attachments/:turnId', async (req: Request, res: Response) =>
  sendResult(res, await takePendingAttachments(req.params as { turnId: string }))
);

/**
 * POST /chat's body: validate, track and queue one turn; with `wait`, poll the job tracker up
 * to 2 minutes for the result (?wait=true). Wave 9: the gateway submits Discord turns through
 * this in-process (engine/api.ts submitTurn) instead of POSTing to :47324/chat, so it no longer
 * shares the HTTP route's per-IP rate limiter with external loopback callers.
 */
export async function submitTurn(
  body: any,
  opts: { wait?: boolean; deps?: EngineDeps } = {}
): Promise<ApiResult<ChatResponse>> {
  try {
    const waitForResult = opts.wait === true;

    logger.info(`🎯 POST /chat - Request received:`, {
      bodyKeys: Object.keys(body),
      hasMessage: !!body.message,
      hasUserId: !!body.userId,
      hasContext: !!body.context,
      waitForResult,
    });

    const { message, userId = 'api-user', context, source = 'api' }: ChatRequest = body;

    logger.info(`🎯 POST /chat - Extracted params:`, {
      message: message?.substring(0, 100),
      userId,
      source,
      contextKeys: Object.keys(context || {}),
      contextPlatform: context?.platform,
      hasGuildKnowledge: !!context?.guildKnowledge,
      isProactiveAnswer: context?.isProactiveAnswer,
    });

    if (!message || typeof message !== 'string') {
      logger.warn(`❌ POST /chat - Invalid message:`, {
        hasMessage: !!message,
        messageType: typeof message,
      });
      return reply(400, {
        success: false,
        messageId: '',
        error:
          'Message is required and must be a string. Expected format: {"message": "your text here", "user_id": "optional-user-id"}',
      } as ChatResponse);
    }

    // Enhanced input validation for better error handling
    if (message.length > 10000) {
      return reply(400, {
        success: false,
        messageId: '',
        error: 'Message too long (max 10000 characters)',
      } as ChatResponse);
    }

    if (typeof userId !== 'string' || userId.length > 100) {
      return reply(400, {
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
    const messageSource = getMessageSource(source);
    const incomingMessage: IncomingMessage = {
      id: messageId,
      timestamp: new Date(),
      retryCount: 0,
      source: messageSource,
      userId,
      message: message.trim(),
      context: context || {}, // Pass platform context (Discord/Slack) through
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
      const job = await (opts.deps ?? defaultEngineDeps).enqueueTurn(incomingMessage);
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
            return reply(200, {
              success: true,
              messageId,
              status: 'completed',
              jobUrl: `/chat/${messageId}`,
              response: jobStatus.result,
            } as ChatResponse);
          } else if (jobStatus?.status === 'failed') {
            logger.error(`❌ Job ${messageId} failed: ${jobStatus.error}`);
            return reply(200, {
              success: false,
              messageId,
              status: 'failed',
              jobUrl: `/chat/${messageId}`,
              error: jobStatus.error,
            } as ChatResponse);
          }

          // Wait before next poll
          await delay(pollInterval);
        }

        // Timeout - return pending status
        logger.warn(`⏰ Job ${messageId} timed out after ${maxWaitTime}ms`);
        return reply(200, {
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
      return reply(200, response);
    } catch (queueError) {
      logger.error(`Failed to queue message ${messageId}:`, queueError);
      // Mark job as failed if queuing fails
      jobTracker.failJob(messageId, 'Failed to queue message');
      throw queueError;
    }
  } catch (error) {
    logger.error('Error in chat endpoint:', error);
    return reply(500, {
      success: false,
      messageId: '',
      error: 'Internal server error',
    } as ChatResponse);
  }
}

/** GET /chat/:messageId's body: the job's status, result or error (404 once it's gone). */
export function getTurn(params: { messageId?: string }): ApiResult {
  try {
    logger.info(`🔍 GET /chat/:messageId - Request received:`, {
      messageId: params.messageId,
      messageIdLength: params.messageId?.length,
      messageIdType: typeof params.messageId,
      fullUrl: `/${params.messageId}`,
      method: 'GET',
    });

    const { messageId } = params;

    if (!messageId) {
      logger.warn(`❌ GET /chat/:messageId - Missing messageId`);
      return reply(400, {
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
      return reply(404, {
        success: false,
        error: 'Job not found or expired',
      });
    }

    // Calculate processing time
    const processingTime = calculateProcessingTime(job.startTime, job.endTime);

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
      response.partialResponse = job.partialResponse;
      response.lastStreamUpdate = job.lastStreamUpdate?.toISOString();
    }

    // Add additional context if present
    if (job.additionalContext && job.additionalContext.length > 0) {
      response.additionalContext = job.additionalContext;
    }

    // Add timing info for debugging
    response.processingTime = processingTime;
    response.startTime = job.startTime.toISOString();
    if (job.endTime) {
      response.endTime = job.endTime.toISOString();
    }

    logger.info(`📊 Job status check for ${messageId}: ${job.status} (${processingTime}ms)`);

    return reply(200, response);
  } catch (error) {
    logger.error('Error checking job status:', error);
    return reply(500, {
      success: false,
      error: 'Internal server error',
    });
  }
}

/** GET /chat/pending-attachments/:turnId's body: take (and clear) a turn's queued files, base64. */
export async function takePendingAttachments(params: { turnId: string }): Promise<ApiResult> {
  try {
    const { turnId } = params;
    const attachments = getPendingAttachments(turnId);

    if (attachments.length === 0) {
      return reply(200, { success: true, attachments: [] });
    }

    // Convert buffers to base64 for JSON transport
    const serialized = attachments.map((att) => ({
      filename: att.filename,
      content: att.content,
      data: att.buffer.toString('base64'),
      size: att.buffer.length,
    }));

    logger.info(`📎 Returning ${attachments.length} pending attachments for turn ${turnId.slice(-8)}`);
    return reply(200, { success: true, attachments: serialized });
  } catch (error) {
    logger.error('Error getting pending attachments:', error);
    return reply(500, { success: false, error: 'Internal server error' });
  }
}

export { router as chatRouter };
