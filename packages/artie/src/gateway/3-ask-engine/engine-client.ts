import { logger } from '../../shared/logger.js';
import { delay } from '../../shared/async.js';
import { getErrorMessage } from '../../shared/errors.js';
import * as engine from '../../engine/api.js';

/**
 * Ensure a value is an Error instance; convert non-Errors by stringifying them.
 */
function ensureError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(String(value));
}

/**
 * Detect the source platform from context metadata; returns 'discord' if explicitly set, else undefined.
 */
function getSourceFromContext(context?: Record<string, any>): string | undefined {
  if (context?.platform === 'discord') {
    return 'discord';
  }
  return undefined;
}

/**
 * Retry a function with exponential backoff
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; baseDelay?: number; maxDelay?: number; name?: string } = {}
): Promise<T> {
  const { maxRetries = 3, baseDelay = 1000, maxDelay = 10000, name = 'operation' } = options;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = ensureError(error);

      // Don't retry if explicitly marked as non-retryable (e.g., 404s)
      if (error?.noRetry) {
        throw lastError;
      }

      if (attempt === maxRetries) {
        logger.error(`${name} failed after ${maxRetries} attempts:`, lastError.message);
        throw lastError;
      }

      // Exponential backoff with jitter
      const backoffMs = Math.min(
        baseDelay * Math.pow(2, attempt - 1) + Math.random() * 500,
        maxDelay
      );
      logger.warn(
        `${name} failed (attempt ${attempt}/${maxRetries}), retrying in ${Math.round(backoffMs)}ms: ${lastError.message}`
      );
      await delay(backoffMs);
    }
  }

  throw lastError || new Error(`${name} failed`);
}

export interface JobSubmissionResponse {
  success: boolean;
  messageId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  jobUrl: string;
  response?: string;
  error?: string;
}

export interface JobStatusResponse {
  success: boolean;
  messageId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  jobUrl: string;
  response?: string;
  error?: string;
  processingTime: number;
  startTime: string;
  endTime?: string;
  partialResponse?: string; // For streaming
  lastStreamUpdate?: string;
}

/** The `HTTP <status>: <statusText>` text these errors carried when they were HTTP failures. */
function httpError(result: engine.ApiResult): string {
  return `HTTP ${result.status}: ${engine.statusText(result)}`;
}

/**
 * The gateway's client for the engine's turn API. Wave 9: one process, so every call goes
 * through engine/api.ts (same handler bodies as POST /chat, GET /chat/:id, ...) instead of
 * loopback HTTP to :47324. Retries, logging and return shapes are unchanged.
 */
export class CapabilitiesClient {

  /**
   * Submit a message for processing and get job ID
   * Includes automatic retry with exponential backoff
   */
  async submitJob(
    message: string,
    userId: string,
    context?: Record<string, any>
  ): Promise<JobSubmissionResponse> {
    return withRetry(
      async () => {
        // AUTO-DETECT: Set source to 'discord' if context contains Discord metadata
        const source = getSourceFromContext(context);

        // engine/api.ts passes the body through a JSON round trip, so the turn's context is
        // the same plain-data copy POST /chat received.
        const response = await engine.submitTurn({
          message,
          userId,
          context,
          source, // Pass source to trigger Discord-specific handling
        });

        if (!engine.isOk(response)) {
          logger.error(`❌ Job submission failed:`, {
            status: response.status,
            statusText: engine.statusText(response),
            body: JSON.stringify(response.body),
          });
          throw new Error(httpError(response));
        }

        const result = response.body as JobSubmissionResponse;

        // DEFENSIVE: Log the raw response for debugging
        logger.info(`📤 Submitted job for user ${userId}:`, {
          messageId: result.messageId,
          hasMessageId: !!result.messageId,
          resultKeys: Object.keys(result),
          fullResult: result,
        });

        // DEFENSIVE: Validate response structure
        if (!result.messageId) {
          logger.error(`❌ INVALID RESPONSE FROM /chat - missing messageId:`, result);
          throw new Error(`Invalid response from capabilities service: missing messageId`);
        }

        return result;
      },
      { maxRetries: 3, baseDelay: 1000, name: 'Job submission' }
    );
  }

  /**
   * Check job status and get result if completed
   * Includes automatic retry for transient failures (but not 404s)
   */
  async checkJobStatus(messageId: string): Promise<JobStatusResponse> {
    return withRetry(
      async () => {
        logger.info(`🔍 API CALL: GET /chat/${messageId.slice(-8)}`);
        const response = await engine.getTurn(messageId);

        if (!engine.isOk(response)) {
          if (response.status === 404) {
            // Don't retry 404s - job genuinely doesn't exist
            logger.warn(`🔍 API RESPONSE: 404 Job not found - ${messageId.slice(-8)}`);
            const error = new Error('Job not found or expired') as Error & { noRetry?: boolean };
            error.noRetry = true;
            throw error;
          }
          logger.error(`🔍 API RESPONSE: HTTP ${response.status} - ${messageId.slice(-8)}`);
          throw new Error(httpError(response));
        }

        const result = response.body as JobStatusResponse;
        logger.info(
          `🔍 API RESPONSE: status="${result.status}", hasResponse=${!!result.response}, responseLength=${result.response?.length || 0}`
        );
        if (result.status === 'completed') {
          logger.info(
            `🔍 API RESPONSE: Full response preview: "${result.response?.substring(0, 150)}..."`
          );
        }

        return result;
      },
      { maxRetries: 2, baseDelay: 500, name: `Job status check (${messageId.slice(-8)})` }
    );
  }

  /**
   * Fetch pending file attachments for a turn (and clear them from the server). Keyed by turn
   * id (jobInfo.messageId), like getPendingComponents (2026-10-31).
   */
  async getPendingAttachments(turnId: string): Promise<
    Array<{
      filename: string;
      content?: string;
      data: string; // base64
      size: number;
    }>
  > {
    try {
      const response = await engine.pendingAttachments(turnId);
      if (!engine.isOk(response)) {
        logger.warn(`Failed to fetch pending attachments: ${response.status}`);
        return [];
      }
      const result = response.body as {
        attachments?: Array<{ filename: string; content?: string; data: string; size: number }>;
      };
      return result.attachments || [];
    } catch (error) {
      logger.error('Failed to fetch pending attachments:', error);
      return [];
    }
  }

  /**
   * Fetch (and clear) the Discord component rows (buttons/select) a turn queued via the
   * discord-ui tool, keyed by turn id (jobInfo.messageId) — not userId, so two turns from
   * the same person never cross.
   */
  async getPendingComponents(turnId: string): Promise<Array<Record<string, unknown>>> {
    try {
      const response = await engine.pendingComponents(turnId);
      if (!engine.isOk(response)) {
        logger.warn(`Failed to fetch pending components: ${response.status}`);
        return [];
      }
      const result = response.body as { rows?: Array<Record<string, unknown>> };
      return result.rows || [];
    } catch (error) {
      logger.error('Failed to fetch pending components:', error);
      return [];
    }
  }

  /** Current brownout mode, for the component-click cap (critical → no paid LLM call). */
  async getBrownoutMode(): Promise<{ mode: 'normal' | 'lean' | 'critical' }> {
    try {
      const response = await engine.brownoutStatus();
      if (!engine.isOk(response)) {
        return { mode: 'normal' };
      }
      return response.body as { mode: 'normal' | 'lean' | 'critical' };
    } catch (error) {
      logger.warn('Failed to fetch brownout mode:', error);
      return { mode: 'normal' };
    }
  }

  /**
   * Poll job until completion with progress callbacks
   */
  async pollJobUntilComplete(
    messageId: string,
    options: {
      maxAttempts?: number;
      pollInterval?: number;
      onProgress?: (status: JobStatusResponse) => void;
      onComplete?: (result: string) => void;
      onError?: (error: string) => void;
    } = {}
  ): Promise<JobStatusResponse> {
    const {
      maxAttempts = 60, // 5 minutes max (5 second intervals)
      pollInterval = 5000, // 5 seconds
      onProgress,
      onComplete,
      onError,
    } = options;

    let attempts = 0;

    return new Promise((resolve, reject) => {
      const poll = async () => {
        try {
          attempts++;
          logger.info(`🔄 POLL #${attempts}: Checking job ${messageId.slice(-8)} status...`);
          const status = await this.checkJobStatus(messageId);
          logger.info(
            `🔄 POLL #${attempts}: Got status="${status.status}", hasResponse=${!!status.response}, responseLength=${status.response?.length || 0}`
          );

          // Call progress callback
          if (onProgress) {
            logger.info(`🔄 POLL #${attempts}: Calling onProgress callback`);
            onProgress(status);
          }

          if (status.status === 'completed') {
            logger.info(`🎯 JOB COMPLETED! Details:`);
            logger.info(`  - messageId: ${messageId}`);
            logger.info(`  - status.response exists: ${!!status.response}`);
            logger.info(`  - status.response type: ${typeof status.response}`);
            logger.info(`  - status.response length: ${status.response?.length || 0}`);
            logger.info(`  - onComplete callback exists: ${!!onComplete}`);
            logger.info(`  - onComplete type: ${typeof onComplete}`);

            if (status.response && onComplete) {
              logger.info(
                `🚀 TRIGGERING onComplete callback with response: "${status.response.substring(0, 100)}..."`
              );
              try {
                onComplete(status.response);
                logger.info(`✅ onComplete callback executed successfully`);
              } catch (callbackError) {
                logger.error(`❌ onComplete callback threw error:`, callbackError);
              }
            } else {
              logger.warn(`🚨 NOT calling onComplete:`);
              logger.warn(`  - status.response truthy: ${!!status.response}`);
              logger.warn(`  - status.response value: ${JSON.stringify(status.response)}`);
              logger.warn(`  - onComplete exists: ${!!onComplete}`);
            }
            resolve(status);
            return;
          }

          if (status.status === 'failed') {
            const errorMsg = status.error || 'Job failed without error message';
            if (onError) {
              onError(errorMsg);
            }
            resolve(status); // Don't reject, return the failed status
            return;
          }

          // Continue polling if pending or processing
          if (attempts >= maxAttempts) {
            const timeoutError = `Job ${messageId} timed out after ${maxAttempts} attempts`;
            if (onError) {
              onError(timeoutError);
            }
            reject(new Error(timeoutError));
            return;
          }

          // Schedule next poll
          setTimeout(poll, pollInterval);
        } catch (error) {
          const errorMsg = getErrorMessage(error);
          logger.error(`Polling error for job ${messageId}:`, error);

          if (onError) {
            onError(errorMsg);
          }
          reject(error);
        }
      };

      // Start polling (poll settles the outer promise itself and catches its own errors)
      void poll();
    });
  }

  /**
   * Submit job and wait for completion (combines submit + poll)
   */
  async processMessage(
    message: string,
    userId: string,
    options: {
      maxAttempts?: number;
      pollInterval?: number;
      onJobSubmitted?: (jobId: string) => void;
      onProgress?: (status: JobStatusResponse) => void;
      onComplete?: (result: string) => void;
      onError?: (error: string) => void;
      context?: Record<string, any>;
    } = {}
  ): Promise<string> {
    const { onJobSubmitted, context, ...pollOptions } = options;

    // Submit job
    const jobInfo = await this.submitJob(message, userId, context);

    if (onJobSubmitted) {
      onJobSubmitted(jobInfo.messageId);
    }

    // Poll until complete
    const finalStatus = await this.pollJobUntilComplete(jobInfo.messageId, pollOptions);

    if (finalStatus.status === 'completed' && finalStatus.response) {
      return finalStatus.response;
    } else if (finalStatus.status === 'failed') {
      throw new Error(finalStatus.error || 'Job failed without error message');
    } else {
      throw new Error(`Job ended in unexpected status: ${finalStatus.status}`);
    }
  }

  /**
   * Link a Discord message ID to a trace for feedback correlation
   * Called after sending a response to Discord
   */
  async linkDiscordMessage(jobId: string, discordMessageId: string): Promise<void> {
    try {
      const response = await engine.linkDiscordMessage({ jobId, discordMessageId });

      if (!engine.isOk(response)) {
        const errorBody = JSON.stringify(response.body);
        logger.warn(`Failed to link Discord message: ${response.status} ${errorBody}`);
      } else {
        logger.debug(`Linked Discord message ${discordMessageId} to job ${jobId.slice(-8)}`);
      }
    } catch (error) {
      // Non-critical - log and continue
      logger.warn('Failed to link Discord message to trace:', error);
    }
  }

  /**
   * Record feedback for a trace based on Discord reaction
   * Called when a user reacts to Artie's message with 👍/👎 etc.
   */
  async recordTraceFeedback(
    discordMessageId: string,
    sentiment: 'positive' | 'negative',
    emoji: string
  ): Promise<boolean> {
    try {
      const response = await engine.recordTraceFeedback({ discordMessageId, sentiment, emoji });

      if (engine.isOk(response)) {
        logger.debug(`Recorded ${sentiment} feedback for Discord message ${discordMessageId}`);
        return true;
      } else {
        const errorBody = JSON.stringify(response.body);
        logger.debug(`No trace found for Discord message ${discordMessageId}: ${errorBody}`);
        return false;
      }
    } catch (error) {
      // Non-critical - log and continue
      logger.debug('Failed to record trace feedback:', error);
      return false;
    }
  }
}

// Export singleton instance
export const capabilitiesClient = new CapabilitiesClient();
