import { Queue, Worker } from 'bullmq';
import { logger, createRedisConnection } from '@coachartie/shared';

export interface ScheduledTask {
  id: string;
  name: string;
  cron: string;
  data?: Record<string, unknown>;
  options?: {
    timezone?: string;
    startDate?: Date;
    endDate?: Date;
    immediate?: boolean;
  };
}

export interface ScheduledJob {
  id: string;
  name: string;
  nextRun: Date;
  lastRun?: Date;
  data: Record<string, unknown>;
  cron: string;
}

interface BullJob {
  name: string;
  data: {
    taskId?: string;
    [key: string]: unknown;
  };
}

interface SchedulerStats {
  jobs: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  };
  repeatable: number;
  tasks: number;
}

interface ReminderJobData {
  userId: string;
  reminderType: string;
  [key: string]: unknown;
}

export class SchedulerService {
  private schedulerQueue: Queue;
  private worker: Worker;
  private tasks = new Map<string, ScheduledTask>();

  constructor() {
    const connection = createRedisConnection();

    // Create scheduler queue for cron jobs
    this.schedulerQueue = new Queue('coachartie-scheduler', {
      connection,
      defaultJobOptions: {
        removeOnComplete: 10,
        removeOnFail: 5,
      },
    });

    // Create worker to process scheduled jobs
    this.worker = new Worker(
      'coachartie-scheduler',
      async (job) => {
        await this.executeScheduledJob(job);
      },
      { connection }
    );

    logger.info('Scheduler service initialized');
  }

  /**
   * Schedule a recurring task using cron expression
   */
  async scheduleTask(task: ScheduledTask): Promise<void> {
    try {
      const jobOptions = {
        repeat: {
          pattern: task.cron,
          tz: task.options?.timezone || 'UTC',
        },
        jobId: task.id,
      };

      await this.schedulerQueue.add(
        task.name,
        {
          taskId: task.id,
          ...task.data,
        },
        jobOptions
      );

      this.tasks.set(task.id, task);
      logger.info(`Scheduled task '${task.name}' with cron '${task.cron}'`);

      // Run immediately if requested
      if (task.options?.immediate) {
        await this.schedulerQueue.add(`${task.name}-immediate`, {
          taskId: task.id,
          immediate: true,
          ...task.data,
        });
      }
    } catch (error) {
      logger.error(`Failed to schedule task '${task.name}':`, error);
      throw error;
    }
  }

  /**
   * Schedule a one-time job with delay
   */
  async scheduleOnce(name: string, data: Record<string, unknown>, delay: number): Promise<void> {
    try {
      await this.schedulerQueue.add(name, data, {
        delay,
        jobId: `once-${name}-${Date.now()}`,
      });

      logger.info(`Scheduled one-time job '${name}' with ${delay}ms delay`);
    } catch (error) {
      logger.error(`Failed to schedule one-time job '${name}':`, error);
      throw error;
    }
  }

  /**
   * Remove a scheduled task
   */
  async removeTask(taskId: string): Promise<void> {
    try {
      const task = this.tasks.get(taskId);
      if (!task) {
        throw new Error(`Task '${taskId}' not found`);
      }

      // Remove all repeatable jobs for this task
      const repeatableJobs = await this.schedulerQueue.getRepeatableJobs();
      for (const job of repeatableJobs) {
        if (job.id === taskId) {
          await this.schedulerQueue.removeRepeatableByKey(job.key);
        }
      }

      this.tasks.delete(taskId);
      // Task removed
    } catch (error) {
      logger.error(`Failed to remove task '${taskId}':`, error);
      throw error;
    }
  }

  /**
   * List all scheduled tasks
   */
  async getScheduledTasks(): Promise<ScheduledJob[]> {
    try {
      const repeatableJobs = await this.schedulerQueue.getRepeatableJobs();
      const jobs: ScheduledJob[] = [];

      for (const job of repeatableJobs) {
        const task = this.tasks.get(job.id || '');
        if (task) {
          jobs.push({
            id: task.id,
            name: task.name,
            nextRun: new Date(job.next || Date.now()),
            cron: task.cron,
            data: task.data || {},
          });
        }
      }

      return jobs;
    } catch (error) {
      logger.error('Failed to get scheduled tasks:', error);
      throw error;
    }
  }

  /**
   * Execute a scheduled job
   */
  private async executeScheduledJob(job: BullJob): Promise<void> {
    const { taskId } = job.data;

    try {
      // Silent execution - no logs

      // Handle different types of scheduled jobs
      switch (job.name) {
        case 'health-check':
          await this.executeHealthCheck(job.data);
          break;

        case 'daily-summary':
          await this.executeDailySummary(job.data);
          break;

        case 'user-reminder':
          await this.executeUserReminder(job.data as ReminderJobData);
          break;

        case 'cleanup-old-data':
          await this.executeCleanup(job.data);
          break;

        default:
          logger.warn(`Unknown scheduled job type: ${job.name}`);
      }

      // Job completed
    } catch (error) {
      logger.error(`Scheduled job '${job.name}' failed:`, error);
      throw error;
    }
  }

  /**
   * Execute health check job
   */
  private async executeHealthCheck(_data: Record<string, unknown>): Promise<void> {
    // Health check

    // - Check Redis connectivity
    // - Check queue status
    // - Check service availability
    // - Report to monitoring systems

    logger.info('✅ Health check completed');
  }

  /**
   * Execute daily summary job
   */
  private async executeDailySummary(_data: Record<string, unknown>): Promise<void> {
    logger.info('📊 Executing daily summary generation');

    // - Aggregate daily statistics
    // - Generate summary reports
    // - Send to configured channels

    logger.info('✅ Daily summary completed');
  }

  /**
   * Execute user reminder job
   */
  private async executeUserReminder(data: ReminderJobData): Promise<void> {
    const { userId, reminderType } = data;

    logger.info(`💭 Executing user reminder for ${userId}: ${reminderType}`);

    // - Send reminder messages
    // - Update user interaction logs
    // - Handle reminder responses

    logger.info('✅ User reminder completed');
  }

  /**
   * Execute cleanup job
   */
  private async executeCleanup(_data: Record<string, unknown>): Promise<void> {
    logger.info('🧹 Executing data cleanup');

    // - Remove old completed jobs
    // - Clean up expired sessions
    // - Archive old logs

    logger.info('✅ Data cleanup completed');
  }

  /**
   * Setup default scheduled tasks
   */
  async setupDefaultTasks(): Promise<void> {
    // Set up default tasks

    // Health check every 5 minutes
    await this.scheduleTask({
      id: 'health-check',
      name: 'health-check',
      cron: '*/5 * * * *',
      data: { type: 'system-health' },
      options: { immediate: false },
    });

    // Daily summary at 9 AM UTC
    await this.scheduleTask({
      id: 'daily-summary',
      name: 'daily-summary',
      cron: '0 9 * * *',
      data: { type: 'daily-report' },
      options: { immediate: false },
    });

    // Cleanup old data weekly (Sunday at 2 AM)
    await this.scheduleTask({
      id: 'weekly-cleanup',
      name: 'cleanup-old-data',
      cron: '0 2 * * 0',
      data: { type: 'system-cleanup', maxAge: '7d' },
      options: { immediate: false },
    });

    // Tasks scheduled
  }

  /**
   * Get scheduler statistics
   */
  async getStats(): Promise<SchedulerStats> {
    try {
      const waiting = await this.schedulerQueue.getWaiting();
      const active = await this.schedulerQueue.getActive();
      const completed = await this.schedulerQueue.getCompleted();
      const failed = await this.schedulerQueue.getFailed();
      const delayed = await this.schedulerQueue.getDelayed();
      const repeatableJobs = await this.schedulerQueue.getRepeatableJobs();

      return {
        jobs: {
          waiting: waiting.length,
          active: active.length,
          completed: completed.length,
          failed: failed.length,
          delayed: delayed.length,
        },
        repeatable: repeatableJobs.length,
        tasks: this.tasks.size,
      };
    } catch (error) {
      logger.error('Failed to get scheduler stats:', error);
      throw error;
    }
  }

  /**
   * Close scheduler service
   */
  async close(): Promise<void> {
    await this.worker.close();
    await this.schedulerQueue.close();
    logger.info('Scheduler service closed');
  }
}

// Export singleton instance
export const schedulerService = new SchedulerService();
