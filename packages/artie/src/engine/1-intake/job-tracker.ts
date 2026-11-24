import { logger } from '../../shared/logger.js';

interface JobResult {
  messageId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  result?: string;
  error?: string;
  startTime: Date;
  endTime?: Date;
  userId: string;
  originalMessage: string;
  additionalContext?: string[];
  cancellationReason?: string;
  partialResponse?: string; // For streaming responses
  lastStreamUpdate?: Date;
  capabilityEmojis?: string[]; // Emoji signatures of executing capabilities for Discord reactions
}

class JobTracker {
  private static instance: JobTracker;
  private jobs = new Map<string, JobResult>();
  private cleanupInterval: NodeJS.Timeout;

  private constructor() {
    // Clean up old jobs every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldJobs();
    }, 300000); // 5 minutes

    logger.info('🔧 JobTracker initialized with automatic cleanup');
  }

  static getInstance(): JobTracker {
    if (!JobTracker.instance) {
      JobTracker.instance = new JobTracker();
    }
    return JobTracker.instance;
  }

  /**
   * Start tracking a new job
   */
  startJob(messageId: string, userId: string, originalMessage: string): void {
    const job: JobResult = {
      messageId,
      userId,
      originalMessage,
      status: 'pending',
      startTime: new Date(),
    };

    this.jobs.set(messageId, job);
    logger.info(`📝 Started tracking job ${messageId} for user ${userId}`);
  }

  /**
   * Update job status to processing
   */
  markJobProcessing(messageId: string): void {
    const job = this.jobs.get(messageId);
    if (job) {
      job.status = 'processing';
      logger.info(`🔄 Job ${messageId} is now processing`);
    }
  }

  /**
   * Update partial response for streaming
   */
  updatePartialResponse(messageId: string, partialResponse: string): void {
    const job = this.jobs.get(messageId);
    if (job && (job.status === 'pending' || job.status === 'processing')) {
      job.partialResponse = partialResponse;
      job.lastStreamUpdate = new Date();
      logger.info(
        `🔄 Updated partial response for job ${messageId}: ${partialResponse.substring(0, 100)}...`
      );
    }
  }

  /**
   * Track capability execution for Discord reactions
   */
  trackCapabilityExecution(messageId: string, emoji: string): void {
    const job = this.jobs.get(messageId);
    if (job && emoji) {
      if (!job.capabilityEmojis) {
        job.capabilityEmojis = [];
      }
      // Only add if not already present
      if (!job.capabilityEmojis.includes(emoji)) {
        job.capabilityEmojis.push(emoji);
        logger.info(`${emoji} Tracking capability emoji for job ${messageId}`);
      }
    }
  }

  /**
   * Complete a job with success result
   */
  completeJob(messageId: string, result: string): void {
    logger.info(`✅ JOB TRACKER: Completing job ${messageId}:`, {
      messageId,
      messageIdType: typeof messageId,
      messageIdLength: messageId?.length,
      hasResult: !!result,
      resultLength: result?.length,
      resultPreview: result?.substring(0, 100),
    });

    const job = this.jobs.get(messageId);

    if (!job) {
      logger.error(`❌ JOB TRACKER: Cannot complete job ${messageId} - not found in tracker`, {
        messageId,
        totalJobsInTracker: this.jobs.size,
        allJobIds: Array.from(this.jobs.keys()).map((id) => id.slice(-8)),
      });
      return;
    }

    logger.info(`✅ JOB TRACKER: Found job ${messageId}, marking complete:`, {
      previousStatus: job.status,
      userId: job.userId,
      originalMessage: job.originalMessage.substring(0, 100),
    });

    job.status = 'completed';
    job.result = result;
    job.endTime = new Date();
    // Clear partial response when complete
    job.partialResponse = undefined;

    const duration = job.endTime.getTime() - job.startTime.getTime();
    logger.info(`✅ Job ${messageId} completed successfully in ${duration}ms`, {
      messageId,
      duration,
      resultLength: result.length,
      status: job.status,
    });
  }

  /**
   * Fail a job with error
   */
  failJob(messageId: string, error: string): void {
    const job = this.jobs.get(messageId);
    if (job) {
      job.status = 'failed';
      job.error = error;
      job.endTime = new Date();

      const duration = job.endTime.getTime() - job.startTime.getTime();
      logger.error(`❌ Job ${messageId} failed after ${duration}ms: ${error}`);
    }
  }

  /**
   * Get job status and result
   */
  getJob(messageId: string): JobResult | undefined {
    return this.jobs.get(messageId);
  }

  /**
   * Get all jobs for a user (for debugging)
   */
  getUserJobs(userId: string): JobResult[] {
    return Array.from(this.jobs.values())
      .filter((job) => job.userId === userId)
      .sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
  }

  /**
   * Get system statistics
   */
  getStats(): {
    totalJobs: number;
    pendingJobs: number;
    processingJobs: number;
    completedJobs: number;
    failedJobs: number;
    cancelledJobs: number;
    oldestJob?: Date;
  } {
    const jobs = Array.from(this.jobs.values());

    let oldestJob: Date | undefined;
    if (jobs.length > 0) {
      oldestJob = new Date(Math.min(...jobs.map((j) => j.startTime.getTime())));
    }

    return {
      totalJobs: jobs.length,
      pendingJobs: jobs.filter((j) => j.status === 'pending').length,
      processingJobs: jobs.filter((j) => j.status === 'processing').length,
      completedJobs: jobs.filter((j) => j.status === 'completed').length,
      failedJobs: jobs.filter((j) => j.status === 'failed').length,
      cancelledJobs: jobs.filter((j) => j.status === 'cancelled').length,
      oldestJob,
    };
  }

  /**
   * Clean up jobs older than 1 hour
   */
  private cleanupOldJobs(): void {
    const oneHourAgo = new Date(Date.now() - 3600000);
    let cleanedCount = 0;

    for (const [messageId, job] of this.jobs.entries()) {
      // Clean up completed/failed jobs older than 1 hour
      if (
        (job.status === 'completed' || job.status === 'failed') &&
        job.endTime &&
        job.endTime < oneHourAgo
      ) {
        this.jobs.delete(messageId);
        cleanedCount++;
      }
      // Clean up pending/processing jobs older than 1 hour (likely stuck)
      else if (
        (job.status === 'pending' || job.status === 'processing') &&
        job.startTime < oneHourAgo
      ) {
        this.jobs.delete(messageId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.info(`🧹 Cleaned up ${cleanedCount} old jobs`);
    }
  }

  /**
   * Cancel a running job
   */
  cancelJob(messageId: string, reason: string = 'User requested cancellation'): boolean {
    const job = this.jobs.get(messageId);
    if (!job) {
      return false;
    }

    // Only allow cancellation of pending or processing jobs
    if (job.status === 'pending' || job.status === 'processing') {
      job.status = 'cancelled';
      job.cancellationReason = reason;
      job.endTime = new Date();

      const duration = job.endTime.getTime() - job.startTime.getTime();
      logger.info(`🛑 Job ${messageId} cancelled after ${duration}ms: ${reason}`);
      return true;
    }

    logger.warn(`⚠️ Cannot cancel job ${messageId} with status: ${job.status}`);
    return false;
  }

  /**
   * Add additional context to a running job
   */
  addJobContext(messageId: string, context: string): boolean {
    const job = this.jobs.get(messageId);
    if (!job) {
      return false;
    }

    // Only allow context addition to pending or processing jobs
    if (job.status === 'pending' || job.status === 'processing') {
      if (!job.additionalContext) {
        job.additionalContext = [];
      }
      job.additionalContext.push(context);

      logger.info(`📝 Added context to job ${messageId}: ${context.substring(0, 100)}...`);
      return true;
    }

    logger.warn(`⚠️ Cannot add context to job ${messageId} with status: ${job.status}`);
    return false;
  }

  /**
   * Get full job context (original message + additional context)
   */
  getJobFullContext(messageId: string): string | null {
    const job = this.jobs.get(messageId);
    if (!job) {
      return null;
    }

    let fullContext = job.originalMessage;

    if (job.additionalContext && job.additionalContext.length > 0) {
      fullContext += '\n\nAdditional context:\n' + job.additionalContext.join('\n');
    }

    return fullContext;
  }

  /**
   * Check if a job is cancellable
   */
  isJobCancellable(messageId: string): boolean {
    const job = this.jobs.get(messageId);
    if (!job) {
      return false;
    }
    return job.status === 'pending' || job.status === 'processing';
  }

  /**
   * Manually clean up all jobs (for testing)
   */
  clearAllJobs(): void {
    const count = this.jobs.size;
    this.jobs.clear();
    logger.info(`🗑️ Manually cleared ${count} jobs`);
  }

  /**
   * Shutdown cleanup
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    logger.info('🛑 JobTracker shutdown');
  }
}

// Export singleton instance
export const jobTracker = JobTracker.getInstance();
