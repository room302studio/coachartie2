/**
 * Universal User Intent Processor
 * 
 * Single implementation for all Discord interactions:
 * - Messages, button clicks, menu selections, slash commands
 * - Handles job submission, monitoring, streaming, completion
 * - Provides consistent UX across all interaction types
 */

import { logger } from '@coachartie/shared';
import { capabilitiesClient } from './capabilities-client.js';
import { jobMonitor } from './job-monitor.js';
import { telemetry } from './telemetry.js';
import { generateCorrelationId, getShortCorrelationId } from '../utils/correlation.js';

export interface UserIntent {
  content: string;
  userId: string;
  username?: string;
  source: 'message' | 'button' | 'select' | 'slash_command';
  metadata?: Record<string, unknown>;
  respond: (content: string) => Promise<void>;
  updateProgress?: (status: string) => Promise<void>;
  sendTyping?: () => Promise<void>;
}

export interface ProcessorOptions {
  enableStreaming?: boolean;
  enableTyping?: boolean;
  maxAttempts?: number;
  statusUpdateInterval?: number;
}

/**
 * Process any user intent through the unified pipeline
 */
export async function processUserIntent(
  intent: UserIntent, 
  options: ProcessorOptions = {}
): Promise<void> {
  const {
    enableStreaming = false,
    enableTyping = false,
    maxAttempts = 60,
    statusUpdateInterval = 5
  } = options;

  const correlationId = generateCorrelationId();
  const shortId = getShortCorrelationId(correlationId);
  const startTime = Date.now();

  // Track processing state
  let jobCompleted = false;
  let typingInterval: NodeJS.Timeout | null = null;
  let lastStatus = 'pending';
  let updateCount = 0;
  let streamedChunks = 0;
  let lastSentContent = '';

  try {
    logger.info(`Processing user intent [${shortId}]:`, {
      correlationId,
      source: intent.source,
      userId: intent.userId,
      username: intent.username,
      contentLength: intent.content.length,
      enableStreaming,
      enableTyping
    });

    telemetry.logEvent('intent_started', {
      source: intent.source,
      contentLength: intent.content.length,
      enableStreaming,
      enableTyping
    }, correlationId, intent.userId);

    // Start typing indicator if enabled
    if (enableTyping && intent.sendTyping) {
      await intent.sendTyping();
      typingInterval = setInterval(async () => {
        try {
          await intent.sendTyping?.();
        } catch (error) {
          logger.warn(`Typing indicator failed [${shortId}]:`, error);
        }
      }, 8000);
    }

    // Submit job to capability system
    const jobInfo = await capabilitiesClient.submitJob(intent.content, intent.userId);
    const jobShortId = jobInfo.messageId.slice(-8);

    logger.info(`Job submitted [${shortId}]:`, {
      correlationId,
      jobId: jobInfo.messageId,
      source: intent.source
    });

    telemetry.incrementJobsSubmitted(intent.userId, jobInfo.messageId);

    // Monitor job with unified progress handling
    jobMonitor.monitorJob(jobInfo.messageId, {
      maxAttempts,

      // Progress updates
      onProgress: async (status) => {
        try {
          // Handle streaming if enabled
          if (enableStreaming && status.partialResponse && status.partialResponse !== lastSentContent) {
            const newContent = status.partialResponse.slice(lastSentContent.length);
            if (newContent.trim()) {
              await intent.respond(newContent);
              lastSentContent = status.partialResponse;
              streamedChunks++;
              logger.info(`Streamed chunk ${streamedChunks} [${shortId}]`);
            }
          }

          // Progress status updates
          if (intent.updateProgress && 
              (status.status !== lastStatus || (updateCount % statusUpdateInterval === 0))) {
            let progressText = status.status === 'processing' ? 'Processing...' : 'Working on it...';
            
            // Add partial content preview if available and not streaming
            if (!enableStreaming && status.partialResponse) {
              const preview = status.partialResponse.slice(0, 100);
              progressText += `\n\n${preview}${status.partialResponse.length > 100 ? '...' : ''}`;
            }
            
            await intent.updateProgress(progressText);
            lastStatus = status.status;
          }
          updateCount++;

        } catch (error) {
          logger.warn(`Progress update failed [${shortId}]:`, error);
        }
      },

      // Job completion
      onComplete: async (result) => {
        if (jobCompleted) {
          logger.warn(`Duplicate completion blocked [${shortId}]`);
          return;
        }
        jobCompleted = true;

        const duration = Date.now() - startTime;

        // Stop typing indicator
        if (typingInterval) {
          clearInterval(typingInterval);
          typingInterval = null;
        }

        logger.info(`Job completed [${shortId}]:`, {
          correlationId,
          jobId: jobInfo.messageId,
          duration: `${duration}ms`,
          resultLength: result?.length || 0,
          streamedChunks
        });

        try {
          // Send response if not already streamed
          if (streamedChunks === 0) {
            await intent.respond(result || 'No response received');
          }

          telemetry.logEvent('intent_completed', {
            source: intent.source,
            jobId: jobInfo.messageId,
            duration,
            streamedChunks,
            resultLength: result?.length || 0
          }, correlationId, intent.userId, duration, true);

        } catch (error) {
          logger.error(`Failed to send completion response [${shortId}]:`, error);
        }
      },

      // Error handling
      onError: async (error) => {
        const duration = Date.now() - startTime;

        // Stop typing indicator
        if (typingInterval) {
          clearInterval(typingInterval);
          typingInterval = null;
        }

        logger.error(`Job failed [${shortId}]:`, {
          correlationId,
          jobId: jobInfo.messageId,
          error,
          duration: `${duration}ms`
        });

        try {
          await intent.respond('Something went wrong processing your request.');

          telemetry.logEvent('intent_failed', {
            source: intent.source,
            jobId: jobInfo.messageId,
            error,
            duration
          }, correlationId, intent.userId, duration, false);

        } catch (replyError) {
          logger.error(`Failed to send error response [${shortId}]:`, replyError);
        }
      }
    });

    logger.info(`Intent processing setup complete [${shortId}]`);

  } catch (error) {
    // Cleanup on setup failure
    if (typingInterval) {
      clearInterval(typingInterval);
    }

    logger.error(`Intent processing setup failed [${shortId}]:`, {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      source: intent.source
    });

    telemetry.logEvent('intent_setup_failed', {
      source: intent.source,
      error: error instanceof Error ? error.message : String(error)
    }, correlationId, intent.userId);

    try {
      await intent.respond(`Failed to process your ${intent.source}: ${error instanceof Error ? error.message : String(error)}`);
    } catch (replyError) {
      logger.error(`Failed to send setup error response [${shortId}]:`, replyError);
    }
  }
}