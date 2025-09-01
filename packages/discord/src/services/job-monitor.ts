import { logger } from '@coachartie/shared';

export interface JobCallback {
  onComplete: (result: string) => void;
  onError?: (error: string) => void;
  onProgress?: (status: any) => void;
  maxAttempts?: number;
  attemptCount?: number;
  createdAt: number;
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
  partialResponse?: string;
  lastStreamUpdate?: string;
}

/**
 * Persistent Job Monitor - Single wheel that monitors ALL Discord jobs
 * Replaces the broken per-message polling system
 */
export class JobMonitor {
  private static instance: JobMonitor;
  private pendingJobs = new Map<string, JobCallback>();
  private monitorInterval: NodeJS.Timeout | null = null;
  private baseUrl: string;
  private isRunning = false;

  private constructor(baseUrl = process.env.CAPABILITIES_URL || 'http://localhost:18239') {
    this.baseUrl = baseUrl;
  }

  public static getInstance(baseUrl?: string): JobMonitor {
    if (!JobMonitor.instance) {
      JobMonitor.instance = new JobMonitor(baseUrl);
    }
    return JobMonitor.instance;
  }

  /**
   * Start the persistent monitoring wheel
   */
  public startMonitoring(): void {
    if (this.isRunning) {
      logger.warn('Job monitor is already running');
      return;
    }

    logger.info('🎯 Starting persistent job monitor (single wheel for all jobs)');
    this.isRunning = true;
    
    // Single wheel that turns every 3 seconds
    this.monitorInterval = setInterval(async () => {
      await this.checkAllJobs();
    }, 3000);

    logger.info(`✅ Job monitor started - will check jobs every 3 seconds`);
  }

  /**
   * Stop the monitoring wheel
   */
  public stopMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    this.isRunning = false;
    logger.info('🛑 Job monitor stopped');
  }

  /**
   * Register a job to be monitored
   */
  public monitorJob(
    jobId: string, 
    callbacks: {
      onComplete: (result: string) => void;
      onError?: (error: string) => void;
      onProgress?: (status: any) => void;
      maxAttempts?: number;
    }
  ): void {
    logger.info(`📋 Registering job ${jobId.slice(-8)} for monitoring`);
    
    this.pendingJobs.set(jobId, {
      ...callbacks,
      maxAttempts: callbacks.maxAttempts || 60,
      attemptCount: 0,
      createdAt: Date.now()
    });

    logger.info(`📊 Job monitor status: ${this.pendingJobs.size} jobs being monitored`);
  }

  /**
   * Remove a job from monitoring (called when completed/failed)
   */
  public unmonitorJob(jobId: string): void {
    const removed = this.pendingJobs.delete(jobId);
    if (removed) {
      logger.info(`🗑️ Removed job ${jobId.slice(-8)} from monitoring`);
      logger.info(`📊 Job monitor status: ${this.pendingJobs.size} jobs remaining`);
    }
  }

  /**
   * Check all pending jobs - THE SINGLE WHEEL
   */
  private async checkAllJobs(): Promise<void> {
    if (this.pendingJobs.size === 0) {
      return; // No jobs to check, wheel spins quietly
    }

    logger.info(`🔄 Checking ${this.pendingJobs.size} pending jobs...`);
    
    const jobEntries = Array.from(this.pendingJobs.entries());
    
    for (const [jobId, callback] of jobEntries) {
      try {
        await this.checkSingleJob(jobId, callback);
      } catch (error) {
        logger.error(`❌ Error checking job ${jobId.slice(-8)}:`, error);
        
        // Increment attempt count
        callback.attemptCount = (callback.attemptCount || 0) + 1;
        
        // If max attempts reached, fail the job
        if (callback.attemptCount >= callback.maxAttempts!) {
          logger.error(`💀 Job ${jobId.slice(-8)} exceeded max attempts (${callback.maxAttempts}), failing`);
          
          if (callback.onError) {
            callback.onError(`Job exceeded max attempts: ${error}`);
          }
          
          this.unmonitorJob(jobId);
        }
      }
    }
  }

  /**
   * Check a single job status
   */
  private async checkSingleJob(jobId: string, callback: JobCallback): Promise<void> {
    const shortId = jobId.slice(-8);
    
    try {
      logger.info(`🔍 Checking job ${shortId}...`);
      
      const response = await fetch(`${this.baseUrl}/chat/${jobId}`);
      
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Job not found or expired');
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const status: JobStatusResponse = await response.json();
      logger.info(`🔍 Job ${shortId} status: "${status.status}", hasResponse: ${!!status.response}, responseLength: ${status.response?.length || 0}`);

      // Call progress callback if status changed
      if (callback.onProgress) {
        callback.onProgress(status);
      }

      // Handle completion
      if (status.status === 'completed') {
        logger.info(`🎉 Job ${shortId} COMPLETED!`);
        
        if (status.response && callback.onComplete) {
          logger.info(`🚀 Calling onComplete for job ${shortId} with ${status.response.length} chars`);
          logger.info(`📝 Response preview: "${status.response.substring(0, 100)}..."`);
          
          try {
            callback.onComplete(status.response);
            logger.info(`✅ onComplete callback executed successfully for job ${shortId}`);
          } catch (callbackError) {
            logger.error(`❌ onComplete callback failed for job ${shortId}:`, callbackError);
          }
        } else {
          logger.warn(`⚠️ Job ${shortId} completed but missing response (${!!status.response}) or callback (${!!callback.onComplete})`);
        }
        
        this.unmonitorJob(jobId);
        return;
      }

      // Handle failure
      if (status.status === 'failed') {
        logger.error(`💥 Job ${shortId} FAILED: ${status.error}`);
        
        if (callback.onError) {
          callback.onError(status.error || 'Job failed without error message');
        }
        
        this.unmonitorJob(jobId);
        return;
      }

      // Job still pending/processing, increment attempt count
      callback.attemptCount = (callback.attemptCount || 0) + 1;
      
      // Check if we've exceeded max attempts
      if (callback.attemptCount >= callback.maxAttempts!) {
        const elapsed = Date.now() - callback.createdAt;
        const timeoutError = `Job ${shortId} timed out after ${callback.maxAttempts} attempts (${elapsed}ms)`;
        
        logger.error(`⏰ ${timeoutError}`);
        
        if (callback.onError) {
          callback.onError(timeoutError);
        }
        
        this.unmonitorJob(jobId);
        return;
      }

      logger.info(`⏳ Job ${shortId} still ${status.status} (attempt ${callback.attemptCount}/${callback.maxAttempts})`);

    } catch (error) {
      throw error; // Let the caller handle the error and retry logic
    }
  }

  /**
   * Get monitoring statistics
   */
  public getStats(): { pendingJobs: number; isRunning: boolean } {
    return {
      pendingJobs: this.pendingJobs.size,
      isRunning: this.isRunning
    };
  }

  /**
   * Get list of pending job IDs (for debugging)
   */
  public getPendingJobIds(): string[] {
    return Array.from(this.pendingJobs.keys()).map(id => id.slice(-8));
  }
}

// Export singleton instance
export const jobMonitor = JobMonitor.getInstance();