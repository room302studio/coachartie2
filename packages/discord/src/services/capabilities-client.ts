import { logger } from '@coachartie/shared';

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
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry if explicitly marked as non-retryable (e.g., 404s)
      if (error?.noRetry) {
        throw lastError;
      }

      if (attempt === maxRetries) {
        logger.error(`${name} failed after ${maxRetries} attempts:`, lastError.message);
        throw lastError;
      }

      // Exponential backoff with jitter
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1) + Math.random() * 500, maxDelay);
      logger.warn(`${name} failed (attempt ${attempt}/${maxRetries}), retrying in ${Math.round(delay)}ms: ${lastError.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
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

export class CapabilitiesClient {
  private baseUrl: string;

  constructor(baseUrl = process.env.CAPABILITIES_URL || 'http://localhost:47324') {
    this.baseUrl = baseUrl;
  }

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
        const source = context?.platform === 'discord' ? 'discord' : undefined;

        const response = await fetch(`${this.baseUrl}/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message,
            userId,
            context,
            source, // Pass source to trigger Discord-specific handling
          }),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          logger.error(`❌ Job submission failed:`, {
            status: response.status,
            statusText: response.statusText,
            body: errorBody,
          });
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const result = (await response.json()) as JobSubmissionResponse;

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
        const response = await fetch(`${this.baseUrl}/chat/${messageId}`);

        if (!response.ok) {
          if (response.status === 404) {
            // Don't retry 404s - job genuinely doesn't exist
            logger.warn(`🔍 API RESPONSE: 404 Job not found - ${messageId.slice(-8)}`);
            const error = new Error('Job not found or expired') as Error & { noRetry?: boolean };
            error.noRetry = true;
            throw error;
          }
          logger.error(`🔍 API RESPONSE: HTTP ${response.status} - ${messageId.slice(-8)}`);
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const result = (await response.json()) as JobStatusResponse;
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
   * Fetch pending file attachments for a user (and clear them from the server)
   */
  async getPendingAttachments(userId: string): Promise<
    Array<{
      filename: string;
      content?: string;
      data: string; // base64
      size: number;
    }>
  > {
    try {
      const response = await fetch(`${this.baseUrl}/chat/pending-attachments/${userId}`);
      if (!response.ok) {
        logger.warn(`Failed to fetch pending attachments: ${response.status}`);
        return [];
      }
      const result = (await response.json()) as {
        attachments?: Array<{ filename: string; content?: string; data: string; size: number }>;
      };
      return result.attachments || [];
    } catch (error) {
      logger.error('Failed to fetch pending attachments:', error);
      return [];
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
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger.error(`Polling error for job ${messageId}:`, error);

          if (onError) {
            onError(errorMsg);
          }
          reject(error);
        }
      };

      // Start polling
      poll();
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
      const response = await fetch(`${this.baseUrl}/api/traces/link-discord`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jobId,
          discordMessageId,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
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
      const response = await fetch(`${this.baseUrl}/api/traces/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          discordMessageId,
          sentiment,
          emoji,
        }),
      });

      if (response.ok) {
        logger.debug(`Recorded ${sentiment} feedback for Discord message ${discordMessageId}`);
        return true;
      } else {
        const errorBody = await response.text();
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
