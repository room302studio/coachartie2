import { Queue, Worker } from 'bullmq';
import {
  logger,
  createRedisConnection,
  getSyncDb,
  IncomingMessage,
  QUEUES,
  testRedisConnection,
} from '@coachartie/shared';
import { redditMentionMonitor } from '../reddit-mention-monitor.js';
import { executeOnDemand as moltbookExecute } from '../behaviors/social-media-behavior.js';
import { memoryGardener } from '../learning/memory-gardener.js';

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
  message?: string;
  [key: string]: unknown;
}

export class SchedulerService {
  private schedulerQueue: Queue | null = null;
  private discordQueue: Queue | null = null;
  private incomingQueue: Queue | null = null;
  private worker: Worker | null = null;
  private tasks = new Map<string, ScheduledTask>();
  private initialized = false;
  private initializationFailed = false;
  private completedReminders: Array<{
    timestamp: Date;
    message: string;
    data: Record<string, unknown>;
  }> = [];

  constructor() {
    // Don't initialize in constructor - call initialize() explicitly
  }

  /**
   * Initialize the scheduler with Redis connection
   * Returns true if successful, false if Redis unavailable
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) return true;
    if (this.initializationFailed) return false;

    // Check Redis availability first
    const redisOk = await testRedisConnection();
    if (!redisOk) {
      logger.warn('⚠️ Scheduler: Redis unavailable - scheduler disabled');
      this.initializationFailed = true;
      return false;
    }

    try {
      const connection = createRedisConnection();

      // Create scheduler queue for cron jobs
      this.schedulerQueue = new Queue('coachartie-scheduler', {
        connection,
        defaultJobOptions: {
          removeOnComplete: 10,
          removeOnFail: 5,
        },
      });

      // Create Discord outgoing queue for sending reminders
      this.discordQueue = new Queue('coachartie-discord-outgoing', {
        connection,
      });

      // Create incoming messages queue for processing reminder messages
      this.incomingQueue = new Queue(QUEUES.INCOMING_MESSAGES, {
        connection,
      });

      // Create worker to process scheduled jobs
      this.worker = new Worker(
        'coachartie-scheduler',
        async (job) => {
          await this.executeScheduledJob(job);
        },
        { connection }
      );

      // Handle worker events
      this.worker.on('ready', () => {
        logger.info('🟢 SCHEDULER WORKER READY - Listening for scheduled jobs');
      });

      this.worker.on('completed', (job) => {
        logger.info(`✅ JOB COMPLETED: ${job.name} (ID: ${job.id})`);
      });

      this.worker.on('failed', (job, error) => {
        logger.error(`❌ JOB FAILED: ${job?.name} (ID: ${job?.id}) - ${error?.message}`);
      });

      this.worker.on('error', (error) => {
        logger.error('❌ SCHEDULER WORKER ERROR:', error);
      });

      this.initialized = true;
      logger.info('✅ Scheduler service initialized');
      return true;
    } catch (error) {
      logger.error('Failed to initialize scheduler:', error);
      this.initializationFailed = true;
      return false;
    }
  }

  /**
   * Check if scheduler is ready
   */
  isReady(): boolean {
    return this.initialized && !this.initializationFailed;
  }

  /**
   * Schedule a recurring task using cron expression
   */
  async scheduleTask(task: ScheduledTask): Promise<void> {
    if (!this.initialized || !this.schedulerQueue) {
      logger.warn(`Cannot schedule task '${task.name}' - scheduler not initialized`);
      return;
    }

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
    if (!this.initialized || !this.schedulerQueue) {
      logger.warn(`Cannot schedule one-time job '${name}' - scheduler not initialized`);
      return;
    }

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
    if (!this.initialized || !this.schedulerQueue) {
      logger.warn(`Cannot remove task '${taskId}' - scheduler not initialized`);
      return;
    }

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
    if (!this.initialized || !this.schedulerQueue) {
      return [];
    }

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
      logger.info(`⏰ EXECUTING SCHEDULED JOB: ${job.name} (ID: ${taskId})`);

      // Determine job type: use job.name first, fall back to job.data.type for dynamic names
      const jobType = job.name || job.data.type;

      // Handle different types of scheduled jobs
      switch (jobType) {
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

        case 'reddit-mentions':
          await this.executeRedditMentions();
          break;

        case 'moltbook-social':
          await this.executeMoltbookSocial();
          break;

        case 'daily-reflection':
          await this.executeDailyReflection();
          break;

        case 'weekly-rule-review':
          await this.executeWeeklyRuleReview();
          break;

        case 'memory-gardening':
          await this.executeMemoryGardening();
          break;

        case 'morning-briefing':
          await this.executeMorningBriefing(job.data);
          break;

        case 'trend-digest':
          await this.executeTrendDigest(job.data);
          break;

        case 'heartbeat':
          await this.executeAutonomousHeartbeat();
          break;

        case 'daily-summarization':
          await this.executeDailySummarization();
          break;

        default:
          logger.warn(`Unknown scheduled job type: ${jobType} (job name: ${job.name})`);
      }

      logger.info(`✅ Scheduled job '${job.name}' completed successfully`);
    } catch (error) {
      logger.error(`❌ Scheduled job '${job.name}' failed:`, error);
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
    const { userId, reminderType, message, meetingId } = data;
    const reminderMessage = message || reminderType || 'Scheduled reminder';

    // Log the reminder prominently
    logger.info(`\n${'='.repeat(60)}`);
    logger.info(`🔔 REMINDER TRIGGERED`);
    logger.info(`${'='.repeat(60)}`);
    logger.info(`⏰ Timestamp: ${new Date().toISOString()}`);
    logger.info(`👤 User: ${userId}`);
    logger.info(`📝 Type: ${reminderType}`);
    logger.info(`💬 Message: "${reminderMessage}"`);
    logger.info(`${'='.repeat(60)}\n`);

    // Store the reminder in memory for tracking
    this.completedReminders.push({
      timestamp: new Date(),
      message: reminderMessage,
      data,
    });

    // Keep only last 100 reminders
    if (this.completedReminders.length > 100) {
      this.completedReminders.shift();
    }

    // Send reminder message through normal processing pipeline
    // This will trigger capability extraction and execution
    try {
      const incomingMessage: IncomingMessage = {
        id: `reminder-processed-${Date.now()}`,
        userId,
        message: reminderMessage,
        timestamp: new Date(),
        retryCount: 0,
        source: 'capabilities',
        respondTo: {
          type: 'api', // Use API type so it doesn't try to send to Discord automatically
        },
        context: {
          reminderTriggered: true,
          originalReminderType: reminderType,
          meetingId,
        },
      };

      if (this.incomingQueue) {
        await this.incomingQueue.add('process-reminder', incomingMessage);
        logger.info(`📤 Reminder message queued for processing: "${reminderMessage}"`);
      }
    } catch (error) {
      logger.error('Failed to queue reminder message for processing:', error);
    }

    // Get meeting details if meetingId is provided
    if (meetingId && this.discordQueue) {
      try {
        const db = getSyncDb();
        const meeting = db.get<{ id: number; title: string }>(
          'SELECT * FROM meetings WHERE id = ?',
          [meetingId]
        );

        if (!meeting) {
          logger.error(`Meeting ${meetingId} not found for reminder`);
          return;
        }

        // Send to Discord via queue
        await this.discordQueue.add('send-message', {
          userId,
          content: `🔔 Reminder: **${meeting.title}** starts in 15 minutes!`,
          source: 'meeting-reminder',
          meetingId,
        });

        logger.info(`✅ Reminder queued for Discord: ${userId} - ${message}`);
      } catch (error) {
        logger.error('Failed to queue Discord reminder:', error);
        throw error;
      }
    }
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

  private async executeRedditMentions(): Promise<void> {
    logger.info('👂 Polling Reddit mentions');
    try {
      const result = await redditMentionMonitor.pollMentions();
      logger.info(
        `Reddit mention poll done: fetched=${result.fetched}, queued=${result.queued}, skipped=${result.skipped}`
      );
    } catch (error) {
      logger.error('❌ Reddit mention poll failed:', error);
    }
  }

  private async executeMoltbookSocial(): Promise<void> {
    logger.info('🤖 Moltbook social behavior triggered (LLM + memories)');
    try {
      const result = await moltbookExecute();
      logger.info(`Moltbook social: ${result.action} - ${result.message}`);
    } catch (error) {
      logger.error('❌ Moltbook social behavior failed:', error);
    }
  }

  /**
   * Execute daily reflection consolidation
   * Analyzes recent feedback and generates/updates learned rules
   */
  private async executeDailyReflection(): Promise<void> {
    logger.info('🔄 Daily reflection consolidation triggered');

    // Check if reflection is enabled
    if (process.env.ENABLE_REFLECTION_CONSOLIDATION !== 'true') {
      logger.info(
        '⏭️ Reflection consolidation disabled (set ENABLE_REFLECTION_CONSOLIDATION=true to enable)'
      );
      return;
    }

    try {
      const { reflectionConsolidator } = await import('../learning/reflection-consolidator.js');
      const result = await reflectionConsolidator.runDailyConsolidation();
      logger.info(
        `✅ Daily reflection complete: ${result.rulesCreated} created, ${result.rulesUpdated} updated, ${result.guildsProcessed} guilds`
      );
    } catch (error) {
      logger.error('❌ Daily reflection failed:', error);
    }
  }

  /**
   * Execute weekly rule review
   * Reviews existing rules and retires/modifies based on recent feedback
   */
  private async executeWeeklyRuleReview(): Promise<void> {
    logger.info('📋 Weekly rule review triggered');

    // Check if reflection is enabled
    if (process.env.ENABLE_REFLECTION_CONSOLIDATION !== 'true') {
      logger.info('⏭️ Rule review disabled (set ENABLE_REFLECTION_CONSOLIDATION=true to enable)');
      return;
    }

    try {
      const { reflectionConsolidator } = await import('../learning/reflection-consolidator.js');
      const result = await reflectionConsolidator.reviewAndPruneRules();
      logger.info(
        `✅ Weekly rule review complete: ${result.kept} kept, ${result.modified} modified, ${result.retired} retired`
      );
    } catch (error) {
      logger.error('❌ Weekly rule review failed:', error);
    }
  }

  /**
   * Execute memory gardening
   * Links related memories, consolidates duplicates, prunes stale ones, surfaces gems
   * Inspired by: https://robdodson.me/posts/i-gave-my-second-brain-a-gardener/
   */
  private async executeMemoryGardening(): Promise<void> {
    logger.info('🌱 Memory gardening triggered');

    try {
      const result = await memoryGardener.garden();
      logger.info(
        `✅ Memory gardening complete: ${result.memoriesLinked} linked, ${result.memoriesConsolidated} consolidated, ${result.memoriesPruned} pruned, ${result.memoriesBoosted} boosted`
      );

      // Generate weekly digest on Sundays
      const today = new Date().getDay();
      if (today === 0) {
        // Sunday
        const digest = await memoryGardener.generateWeeklyDigest();
        logger.info(
          `📋 Weekly digest generated: ${digest.newMemories} new memories, themes: ${digest.topThemes.slice(0, 3).join(', ')}`
        );
      }
    } catch (error) {
      logger.error('❌ Memory gardening failed:', error);
    }
  }

  /**
   * Execute morning briefing
   * Clawdbot-style daily intelligence briefing delivered via DM
   */
  private async executeMorningBriefing(data: Record<string, unknown>): Promise<void> {
    const { userId, channel } = data;
    logger.info(`☀️ Morning briefing triggered for user ${userId}`);

    try {
      // Import the briefing capability
      const { morningBriefingCapability } = await import(
        '../../capabilities/productivity/morning-briefing.js'
      );

      // Generate the briefing
      const briefing = await morningBriefingCapability.handler(
        { action: 'now' },
        undefined,
        { userId: userId as string }
      );

      // Queue for delivery via Discord DM
      if (this.discordQueue && (channel === 'discord' || channel === 'both')) {
        await this.discordQueue.add('send-dm', {
          userId,
          content: briefing,
          source: 'morning-briefing',
        });
        logger.info(`✅ Morning briefing queued for Discord delivery to ${userId}`);
      }

      // TODO: Add SMS delivery when channel === 'sms' or 'both'
    } catch (error) {
      logger.error('❌ Morning briefing failed:', error);
    }
  }

  /**
   * Execute trend digest
   * Scheduled delivery of tech trends (GitHub, HN, etc.)
   */
  private async executeTrendDigest(data: Record<string, unknown>): Promise<void> {
    const { userId, sources, limit } = data;
    logger.info(`Trend digest triggered for user ${userId}`);

    try {
      const { trendWatcherCapability } = await import(
        '../../capabilities/research/trend-watcher.js'
      );

      const digest = await trendWatcherCapability.handler(
        {
          action: 'overview',
          source: (sources as string) || 'all',
          limit: (limit as number) || 5,
        },
        undefined,
        { userId: userId as string }
      );

      // Queue for Discord delivery
      if (this.discordQueue) {
        await this.discordQueue.add('send-dm', {
          userId,
          content: `**Your Tech Trend Digest**\n\n${digest}`,
          source: 'trend-digest',
        });
        logger.info(`Trend digest queued for delivery to ${userId}`);
      }
    } catch (error) {
      logger.error('Trend digest failed:', error);
    }
  }

  /**
   * Execute autonomous heartbeat
   * n8nClaw-style hourly check-in that nudges stalled quests and delivers insights
   */
  private async executeAutonomousHeartbeat(): Promise<void> {
    logger.info('Autonomous heartbeat triggered');

    try {
      const { executeHeartbeat } = await import('../autonomous/heartbeat.js');
      const result = await executeHeartbeat();
      logger.info(
        `Heartbeat complete: ${result.questNudges} nudges, ${result.insightsDelivered} insights, ${result.errors} errors`
      );
    } catch (error) {
      logger.error('Autonomous heartbeat failed:', error);
    }
  }

  /**
   * Execute daily conversation summarization
   * Creates long-term memory summaries from daily interactions
   */
  private async executeDailySummarization(): Promise<void> {
    logger.info('Daily conversation summarization triggered');

    try {
      const { runDailySummarization } = await import('../autonomous/conversation-summarizer.js');
      const result = await runDailySummarization();
      logger.info(
        `Summarization complete: ${result.usersProcessed} users, ${result.summariesCreated} summaries`
      );
    } catch (error) {
      logger.error('Daily summarization failed:', error);
    }
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

    // Reddit mentions poll - hourly
    await this.scheduleTask({
      id: 'reddit-mentions',
      name: 'reddit-mentions',
      cron: '0 * * * *',
      data: { type: 'reddit-mentions' },
      options: { immediate: false },
    });

    // Moltbook social behavior - every 4 hours with random skip
    // Runs at 8am, 12pm, 4pm, 8pm UTC but randomly skips ~30% of the time
    await this.scheduleTask({
      id: 'moltbook-social',
      name: 'moltbook-social',
      cron: '0 8,12,16,20 * * *',
      data: { type: 'moltbook-social' },
      options: { immediate: false },
    });

    // Daily reflection consolidation - 4 AM UTC
    // Analyzes feedback from the past 24 hours and generates learned rules
    const dailyReflectionCron = process.env.REFLECTION_DAILY_CRON || '0 4 * * *';
    await this.scheduleTask({
      id: 'daily-reflection',
      name: 'daily-reflection',
      cron: dailyReflectionCron,
      data: { type: 'daily-reflection' },
      options: { immediate: false },
    });

    // Weekly rule review - Monday 3 AM UTC
    // Reviews existing rules and retires ineffective ones
    const weeklyRuleReviewCron = process.env.REFLECTION_WEEKLY_CRON || '0 3 * * 1';
    await this.scheduleTask({
      id: 'weekly-rule-review',
      name: 'weekly-rule-review',
      cron: weeklyRuleReviewCron,
      data: { type: 'weekly-rule-review' },
      options: { immediate: false },
    });

    // Memory gardening - daily at 5 AM UTC
    // Links related memories, consolidates duplicates, prunes stale ones
    const memoryGardeningCron = process.env.MEMORY_GARDENING_CRON || '0 5 * * *';
    await this.scheduleTask({
      id: 'memory-gardening',
      name: 'memory-gardening',
      cron: memoryGardeningCron,
      data: { type: 'memory-gardening' },
      options: { immediate: false },
    });

    // Autonomous heartbeat - hourly
    // n8nClaw-style proactive check-ins: nudge stalled quests, deliver insights
    const heartbeatCron = process.env.HEARTBEAT_CRON || '30 * * * *'; // Every hour at :30
    await this.scheduleTask({
      id: 'heartbeat',
      name: 'heartbeat',
      cron: heartbeatCron,
      data: { type: 'heartbeat' },
      options: { immediate: false },
    });

    // Daily conversation summarization - 6 AM UTC
    // Aggregates daily conversations into long-term memory summaries
    const summarizationCron = process.env.SUMMARIZATION_CRON || '0 6 * * *';
    await this.scheduleTask({
      id: 'daily-summarization',
      name: 'daily-summarization',
      cron: summarizationCron,
      data: { type: 'daily-summarization' },
      options: { immediate: false },
    });

    // Owner morning briefing - 8 AM Eastern (13:00 UTC)
    // Clawdbot-style daily intelligence briefing for the owner
    const { OWNER_USER_ID } = await import('@coachartie/shared');
    const morningBriefingCron = process.env.MORNING_BRIEFING_CRON || '0 13 * * *';
    await this.scheduleTask({
      id: 'owner-morning-briefing',
      name: 'morning-briefing',
      cron: morningBriefingCron,
      data: {
        type: 'morning-briefing',
        userId: OWNER_USER_ID,
        channel: 'discord',
      },
      options: { immediate: false, timezone: 'America/New_York' },
    });
    logger.info(`☀️ Owner morning briefing scheduled at ${morningBriefingCron}`);

    // Startup notification - let owner know Artie is awake
    // Only send if ENABLE_STARTUP_NOTIFICATION is true (default: true)
    if (process.env.ENABLE_STARTUP_NOTIFICATION !== 'false') {
      await this.sendStartupNotification(OWNER_USER_ID);
    }

    // Tasks scheduled
  }

  /**
   * Send startup notification to owner
   * Clawdbot-style "I'm awake" notification with system status
   */
  private async sendStartupNotification(ownerId: string): Promise<void> {
    if (!this.discordQueue) {
      logger.warn('Cannot send startup notification - Discord queue not available');
      return;
    }

    try {
      const now = new Date();
      const timeStr = now.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'America/New_York'
      });

      // Get quick stats
      const stats = await this.getStats();

      const message = `**System Online** 🟢

Artie capabilities service restarted at ${timeStr} ET.

**Scheduled Tasks**: ${stats.repeatable} active
**Next Heartbeat**: :30 past the hour

Say "briefing now" for a full status update.`;

      await this.discordQueue.add('send-dm', {
        userId: ownerId,
        content: message,
        source: 'startup-notification',
      });

      logger.info(`✅ Startup notification queued for owner`);
    } catch (error) {
      logger.error('Failed to send startup notification:', error);
    }
  }

  /**
   * Get scheduler statistics
   */
  async getStats(): Promise<SchedulerStats> {
    if (!this.initialized || !this.schedulerQueue) {
      return {
        jobs: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
        repeatable: 0,
        tasks: 0,
      };
    }

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
    if (!this.initialized) return;

    try {
      if (this.worker) await this.worker.close();
      if (this.schedulerQueue) await this.schedulerQueue.close();
      if (this.discordQueue) await this.discordQueue.close();
      if (this.incomingQueue) await this.incomingQueue.close();
      logger.info('Scheduler service closed');
    } catch (error) {
      logger.error('Error closing scheduler:', error);
    }
  }
}

// Export singleton instance
export const schedulerService = new SchedulerService();
