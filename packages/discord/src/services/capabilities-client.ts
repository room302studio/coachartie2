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

  constructor(baseUrl = process.env.CAPABILITIES_URL || 'http://localhost:18239') {
    this.baseUrl = baseUrl;
  }

  /**
   * Submit a message for processing and get job ID
   */
  async submitJob(message: string, userId: string): Promise<JobSubmissionResponse> {
    try {
      const response = await fetch(`${this.baseUrl}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message,
          userId
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json() as JobSubmissionResponse;
      logger.info(`📤 Submitted job ${result.messageId} for user ${userId}`);
      
      return result;
    } catch (error) {
      logger.error('Failed to submit job to capabilities service:', error);
      throw new Error(`Failed to submit job: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Check job status and get result if completed
   */
  async checkJobStatus(messageId: string): Promise<JobStatusResponse> {
    try {
      const response = await fetch(`${this.baseUrl}/chat/${messageId}`);

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Job not found or expired');
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json() as JobStatusResponse;
      
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
      onError
    } = options;

    let attempts = 0;

    return new Promise((resolve, reject) => {
      const poll = async () => {
        try {
          attempts++;
          const status = await this.checkJobStatus(messageId);

          // Call progress callback
          if (onProgress) {
            onProgress(status);
          }

          if (status.status === 'completed') {
            if (status.response && onComplete) {
              onComplete(status.response);
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
    } = {}
  ): Promise<string> {
    const { onJobSubmitted, ...pollOptions } = options;

    // Submit job
    const jobInfo = await this.submitJob(message, userId);
    
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