import { Queue, Worker } from 'bullmq';
import { logger } from '../../shared/logger.js';
import { mintTrusted } from '../../shared/trusted-ids.js';
import { createRedisConnection, createWorker, testRedisConnection } from '../../shared/queue/redis.js';
import { getSyncDb } from '../../shared/db/client.js';
import { withTimeout } from '../../shared/async.js';
import { isEasternSunday, isEasternWeekend } from '../../shared/eastern-day.js';
import * as gateway from '../../gateway/api.js';
import { IncomingMessage } from '../../shared/queue/types.js';
import { QUEUES } from '../../shared/queue/names.js';
import { redditMentionMonitor } from '../proactive/reddit-mentions.js';
import { memoryGardener } from '../memory/gardener.js';
import { ensureRecurringRemindersTable, fireDueRecurringReminders } from './recurring-reminders.js';

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

interface ScheduledJob {
  id: string;
  name: string;
  nextRun: Date;
  lastRun?: Date;
  data: Record<string, unknown>;
  cron: string;
}

interface BullJob {
  id?: string;
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

// Daily work digests: weekdays only.
const WEEKDAY_ONLY_JOB_TYPES = new Set(['daily-summary', 'morning-briefing', 'trend-digest']);

/**
 * Why a job sits out today, or '' if it runs (EJ, 2026-10-31: "no daily code/work digests on
 * the weekends, and take Sundays off"). Saturday drops the daily digests; Sunday drops every
 * unprompted job. Replies and reminders people asked for aren't in either list, so they run.
 * Exported for tests.
 */
export function restDayReason(jobType: string, proactiveJobTypes: Set<string>, now: Date = new Date()): string {
  if (isEasternSunday(now) && proactiveJobTypes.has(jobType)) return 'Sunday off';
  if (isEasternWeekend(now) && WEEKDAY_ONLY_JOB_TYPES.has(jobType)) return 'Weekend';
  return '';
}

// Every job type executeScheduledJob has a handler for.
const HANDLED_JOB_TYPES = new Set([
  'health-check',
  'daily-summary',
  'user-reminder',
  'recurring-reminders',
  'cleanup-old-data',
  'reddit-mentions',
  'memory-gardening',
  'morning-briefing',
  'trend-digest',
  'heartbeat',
  'daily-summarization',
  'delivery-retries',
]);

/**
 * Which handler a job goes to, or '' if none (2026-10-31). BullMQ job names are free text
 * from callers (`reminder-<ts>`, a user's label, `<name>-immediate`), so dispatching on the
 * name sent every one-time reminder to the unknown branch. `data.type` wins when it names a
 * handler; the name is the fallback because the built-in crons carry descriptive types
 * (`system-health`, `daily-report`) and those repeatables already live in Redis as-is.
 * Exported for tests.
 */
export function resolveJobType(name: string, data: Record<string, unknown> | undefined): string {
  const dataType = data?.type;
  if (typeof dataType === 'string' && HANDLED_JOB_TYPES.has(dataType)) return dataType;
  if (HANDLED_JOB_TYPES.has(name)) return name;
  return '';
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
  // Unknown jobs already logged this boot, so an orphan repeatable errors once, not every run.
  private unknownJobsLogged = new Set<string>();
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

    // Re-test on every call rather than trusting an earlier failure (2026-10-31): the flag
    // used to be sticky, so Redis down at boot meant no scheduler until the next restart.
    const redisOk = await testRedisConnection();
    if (!redisOk) {
      logger.warn('⚠️ Scheduler: Redis unavailable - scheduler disabled');
      this.initializationFailed = true;
      return false;
    }
    this.initializationFailed = false;

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
      this.discordQueue = new Queue(QUEUES.OUTGOING_DISCORD, {
        connection,
      });

      // Create incoming messages queue for processing reminder messages
      this.incomingQueue = new Queue(QUEUES.INCOMING_MESSAGES, {
        connection,
      });

      // Via the shared helper, not a raw Worker: it's the only thing that can detect a
      // second worker sneaking onto a queue that already has one.
      this.worker = createWorker('coachartie-scheduler', async (job) => {
        await this.executeScheduledJob(job);
      });

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
  async scheduleOnce(
    name: string,
    data: Record<string, unknown>,
    delay: number,
    jobId?: string
  ): Promise<void> {
    if (!this.initialized || !this.schedulerQueue) {
      logger.warn(`Cannot schedule one-time job '${name}' - scheduler not initialized`);
      return;
    }

    try {
      // A caller-chosen jobId lets it cancel the job later (meetings, 2026-10-31).
      await this.schedulerQueue.add(name, data, {
        delay,
        jobId: jobId || `once-${name}-${Date.now()}`,
      });

      logger.info(`Scheduled one-time job '${name}' with ${delay}ms delay`);
    } catch (error) {
      logger.error(`Failed to schedule one-time job '${name}':`, error);
      throw error;
    }
  }

  /**
   * Remove a pending one-time job by the jobId given to scheduleOnce. Returns false if there
   * was none (already ran, or never queued).
   */
  async cancelOnce(jobId: string): Promise<boolean> {
    if (!this.initialized || !this.schedulerQueue) {
      return false;
    }
    const job = await this.schedulerQueue.getJob(jobId);
    if (!job) {
      return false;
    }
    await job.remove();
    return true;
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

      const jobType = resolveJobType(job.name, job.data);
      if (!jobType) {
        this.reportUnknownJob(job);
        return;
      }

      // Pause switch: when AUTONOMOUS_PAUSED=true, skip every unprompted/outbound job
      // (briefings, heartbeat, social, digests, reddit) while leaving internal maintenance
      // (memory, cleanup, reflection, summarization) and user-requested reminders running.
      // Reversible — just unset the env var and restart.
      const PROACTIVE_JOB_TYPES = new Set([
        'daily-summary',
        'reddit-mentions',
        'morning-briefing',
        'trend-digest',
        'heartbeat',
        'delivery-retries', // also gated: don't flush queued proactive DMs while paused
      ]);
      if (process.env.AUTONOMOUS_PAUSED === 'true' && PROACTIVE_JOB_TYPES.has(jobType)) {
        logger.info(`⏸️  AUTONOMOUS_PAUSED — skipping proactive job "${jobType}" (ID: ${taskId})`);
        return;
      }
      const resting = restDayReason(jobType, PROACTIVE_JOB_TYPES);
      if (resting) {
        logger.info(`🛋️ ${resting} — skipping "${jobType}" (ID: ${taskId})`);
        return;
      }

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

        case 'recurring-reminders':
          await this.executeRecurringReminders();
          break;

        case 'cleanup-old-data':
          await this.executeCleanup(job.data);
          break;

        case 'reddit-mentions':
          await this.executeRedditMentions();
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

        case 'delivery-retries':
          await this.executeDeliveryRetries();
          break;

        default:
          // Unreachable while the switch matches HANDLED_JOB_TYPES; kept loud in case they drift.
          this.reportUnknownJob(job);
          return;
      }

      logger.info(`✅ Scheduled job '${job.name}' completed successfully`);
    } catch (error) {
      logger.error(`❌ Scheduled job '${job.name}' failed:`, error);
      throw error;
    }
  }

  /**
   * A job no handler claims (2026-10-31): error once per name+type per boot (an orphan
   * repeatable like an old cron fires forever, so warn-every-run was noise nobody read), then
   * debug. Not thrown: a throwing repeatable only adds failed-job churn.
   */
  private reportUnknownJob(job: BullJob): void {
    const key = `${job.name}|${String(job.data.type)}`;
    const detail = `name="${job.name}" data.type="${String(job.data.type)}" taskId=${String(job.data.taskId)} jobId=${String(job.id)}`;
    if (this.unknownJobsLogged.has(key)) {
      logger.debug(`Unknown scheduled job again: ${detail}`);
      return;
    }
    this.unknownJobsLogged.add(key);
    logger.error(
      `❓ Unknown scheduled job type, no handler ran: ${detail}. ` +
        `If it's an orphan repeatable it fires on every run until removed from Redis.`
    );
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

    // A cancelled or deleted meeting's reminder stays silent (2026-10-31). Checked before
    // anything is queued; removing the job on cancel is only best effort.
    if (meetingId) {
      const status = getSyncDb().get<{ status: string }>('SELECT status FROM meetings WHERE id = ?', [
        meetingId,
      ])?.status;
      if (status !== 'scheduled') {
        logger.info(`🔕 Meeting ${String(meetingId)} is ${status ?? 'gone'} — reminder skipped`);
        return;
      }
    }

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

    // A plain reminder has to reach the person (2026-10-31): the replay above answers to
    // 'api', which only logs, so nothing a user asked to be reminded of ever arrived.
    if (!meetingId && this.discordQueue && userId && userId !== 'unknown-user') {
      await this.discordQueue.add('send-message', {
        userId,
        content: `⏰ Reminder: ${reminderMessage}`,
        source: 'user-reminder',
      });
      logger.info(`✅ Reminder DM queued for ${userId}`);
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
   * Per-minute tick: DM every due recurring reminder once (see recurring-reminders.ts).
   * A plain message: no LLM replay, no tools.
   */
  private async executeRecurringReminders(): Promise<void> {
    const sent = await fireDueRecurringReminders(new Date(), async (userId, content, occurrenceKey) => {
      if (!this.discordQueue) {
        throw new Error('Discord queue not available');
      }
      // Stable per-occurrence jobId: if Redis took the job but the ack was lost, the retry next
      // tick adds the same id and BullMQ drops it instead of DMing twice (Codex).
      await this.discordQueue.add(
        'send-message',
        { userId, content, source: 'user-reminder' },
        { jobId: occurrenceKey }
      );
    });
    if (sent > 0) {
      logger.info(`⏰ ${sent} recurring reminder(s) sent`);
    }
  }

  /**
   * One-time reminders still waiting to fire (delayed jobs), optionally only one user's.
   */
  async listOneTimeReminders(
    userId: string | null
  ): Promise<Array<{ id: string; userId: string; message: string; runAt: Date }>> {
    if (!this.initialized || !this.schedulerQueue) {
      return [];
    }
    // Page through ALL delayed jobs before filtering: one capped page could be filled by other
    // users' or system jobs and hide the caller's reminders (Codex). Bounded at 50 pages.
    const PAGE = 500;
    const jobs: Awaited<ReturnType<NonNullable<typeof this.schedulerQueue>['getDelayed']>> = [];
    for (let start = 0; start < PAGE * 50; start += PAGE) {
      const page = await this.schedulerQueue.getDelayed(start, start + PAGE - 1);
      jobs.push(...page);
      if (page.length < PAGE) break;
    }
    const out: Array<{ id: string; userId: string; message: string; runAt: Date }> = [];
    for (const job of jobs) {
      const data = job.data as Record<string, unknown>;
      if (data.type !== 'user-reminder' || data.meetingId) continue;
      const owner = String(data.userId ?? '');
      if (userId !== null && owner !== userId) continue;
      out.push({
        id: String(job.id),
        userId: owner,
        message: String(data.message ?? ''),
        runAt: new Date(job.timestamp + (job.opts.delay ?? 0)),
      });
    }
    return out.sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
  }

  /**
   * Who owns a pending one-time reminder, or null if there is no such job.
   */
  async getOneTimeReminderOwner(jobId: string): Promise<string | null> {
    if (!this.initialized || !this.schedulerQueue) {
      return null;
    }
    const job = await this.schedulerQueue.getJob(jobId);
    if (!job || job.data?.type !== 'user-reminder') {
      return null;
    }
    return String(job.data.userId ?? '');
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
        '../proactive/morning-briefing.js'
      );

      // Generate the briefing
      const briefing = await morningBriefingCapability.handler(
        { action: 'now' },
        undefined,
        mintTrusted({ userId }, 'engine-job')
      );

      // Deliver via the gateway's DM handler (a direct call avoids the BullMQ consumer race).
      // Wave 9: in-process (was POST :47321/api/dm over loopback, which sent no Bearer token and
      // so answered 401 on every run; the HTTP-only token check doesn't apply in-process).
      if (channel === 'discord' || channel === 'both') {
        try {
          const resp = await withTimeout(
            gateway.sendDm({ userId: userId as string, message: briefing }),
            15000
          );
          if (gateway.isOk(resp)) {
            logger.info(`✅ Morning briefing sent via DM to ${userId}`);
          } else {
            logger.error(`❌ Morning briefing DM failed: ${resp.status} ${gateway.statusText(resp)}`);
          }
        } catch (dmError) {
          logger.error('❌ Morning briefing DM delivery failed:', dmError);
        }
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
        '../proactive/trend-watcher.js'
      );

      const digest = await trendWatcherCapability.handler(
        {
          action: 'overview',
          source: (sources as string) || 'all',
          limit: (limit as number) || 5,
        },
        undefined,
        mintTrusted({ userId }, 'engine-job')
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
      const { executeHeartbeat } = await import('../proactive/heartbeat.js');
      const result = await executeHeartbeat();
      logger.info(
        `Heartbeat complete: ${result.questNudges} nudges, ${result.insightsDelivered} insights, ${result.errors} errors`
      );
    } catch (error) {
      logger.error('Autonomous heartbeat failed:', error);
    }
  }

  /**
   * Daily conversation summaries are retired (2026-11-23, with Artie). They were never written
   * by a model: a word-frequency "Topics discussed" list plus the first sentence of a few
   * messages, saved guild-free at importance 8 and mixing DMs with every server. So they
   * crowded recall ("last time" picks the newest importance >= 7 row) and could carry DM text
   * into a server. The nightly dream pruned them as stubs. "When did X start?" questions are
   * now answered from the source with discord-search after/before. The job stays registered so
   * the repeatable doesn't log an unknown task; it does nothing.
   */
  private async executeDailySummarization(): Promise<void> {
    logger.debug('Daily summarization is retired; nothing to do');
  }

  /**
   * Execute delivery retry processing
   * Retries failed message deliveries with exponential backoff
   */
  private async executeDeliveryRetries(): Promise<void> {
    logger.info('Delivery retry processing triggered');

    try {
      const { deliveryManager } = await import('../proactive/delivery.js');
      await deliveryManager.initialize();
      const result = await deliveryManager.processRetries();
      logger.info(
        `Delivery retries: ${result.processed} processed, ${result.succeeded} succeeded, ${result.failed} abandoned`
      );
    } catch (error) {
      logger.error('Delivery retry processing failed:', error);
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

    // Recurring user reminders: the due-row tick, every minute (state lives in SQLite)
    ensureRecurringRemindersTable();
    await this.scheduleTask({
      id: 'recurring-reminders',
      name: 'recurring-reminders',
      cron: '* * * * *',
      data: { type: 'recurring-reminders' },
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

    // Delivery retry processing - every 15 minutes
    // Processes failed deliveries with exponential backoff
    const deliveryRetryCron = process.env.DELIVERY_RETRY_CRON || '*/15 * * * *';
    await this.scheduleTask({
      id: 'delivery-retries',
      name: 'delivery-retries',
      cron: deliveryRetryCron,
      data: { type: 'delivery-retries' },
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

    // Owner morning briefing - 8 AM Eastern
    // Clawdbot-style daily intelligence briefing for the owner
    const { OWNER_USER_ID } = await import('../../shared/config/owner.js');
    const morningBriefingCron = process.env.MORNING_BRIEFING_CRON || '0 8 * * *';
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
    logger.info(`☀️ Owner morning briefing scheduled at ${morningBriefingCron} (America/New_York)`);

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
