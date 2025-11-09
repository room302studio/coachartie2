import { logger } from '@coachartie/shared';

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
   */
  async submitJob(
    message: string,
    userId: string,
    context?: Record<string, any>
  ): Promise<JobSubmissionResponse> {
    try {
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
    } catch (error) {
      logger.error('Failed to submit job to capabilities service:', error);
      throw new Error(
        `Failed to submit job: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Check job status and get result if completed
   */
  async checkJobStatus(messageId: string): Promise<JobStatusResponse> {
    try {
      logger.info(`🔍 API CALL: GET /chat/${messageId.slice(-8)}`);
      const response = await fetch(`${this.baseUrl}/chat/${messageId}`);

      if (!response.ok) {
        if (response.status === 404) {
          logger.warn(`🔍 API RESPONSE: 404 Job not found - ${messageId.slice(-8)}`);
          throw new Error('Job not found or expired');
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
    } catch (error) {
      logger.error(`Failed to check job status for ${messageId}:`, error);
      throw error;
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
}

// Export singleton instance
export const capabilitiesClient = new CapabilitiesClient();
