/**
 * Research Queue Service
 *
 * Manages background research tasks:
 * - Queues research requests
 * - Polls for completion
 * - Writes results to wiki/entityhub
 * - Sends notifications
 */

import { logger } from '../../../../shared/logger.js';
import { getSyncDb } from '../../../../shared/db/client.js';
import type { ResearchTask, TaskHandle, TaskResult } from './types.js';
import { openaiResearchHarness } from './openai-research.js';
import { getErrorMessage } from '../../../../shared/errors.js';
import { UsageLedger } from '../../../budget/usage-ledger.js';

// Initialize research queue table
function ensureTable(): void {
  const db = getSyncDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_tasks (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      context TEXT,
      tools TEXT,
      max_budget REAL,
      user_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      handle_id TEXT,
      handle_provider TEXT,
      result TEXT,
      cost REAL,
      error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      completed_at TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_research_status ON research_tasks(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_research_user ON research_tasks(user_id)`);
}

interface QueuedTask extends ResearchTask {
  status: 'pending' | 'running' | 'completed' | 'failed';
  handleId?: string;
  result?: TaskResult;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}

class ResearchQueueService {
  private pollInterval: NodeJS.Timeout | null = null;
  private isPolling = false;
  private tableInitialized = false;

  private ensureTable(): void {
    if (this.tableInitialized) return;
    ensureTable();
    this.tableInitialized = true;
  }

  /**
   * Queue a new research task
   */
  async queueTask(task: Omit<ResearchTask, 'id' | 'createdAt'>): Promise<string> {
    this.ensureTable();
    const db = getSyncDb();
    const id = `research-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    let toolsJson: string | null = null;
    if (task.tools) {
      toolsJson = JSON.stringify(task.tools);
    }

    db.run(
      `INSERT INTO research_tasks (id, prompt, context, tools, max_budget, user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        task.prompt,
        task.context || null,
        toolsJson,
        task.maxBudget || null,
        task.userId,
      ]
    );

    logger.info(`🔬 Research task queued: ${id}`);

    // Start polling if not already running
    this.startPolling();

    return id;
  }

  /**
   * Get task status
   */
  getTask(id: string): QueuedTask | null {
    this.ensureTable();
    const db = getSyncDb();
    const row = db.get<Record<string, unknown>>('SELECT * FROM research_tasks WHERE id = ?', [id]);
    if (!row) return null;

    return this.rowToTask(row);
  }

  /**
   * List tasks by status
   */
  listTasks(status?: QueuedTask['status'], limit = 20): QueuedTask[] {
    this.ensureTable();
    const db = getSyncDb();

    let rows: Record<string, unknown>[];
    if (status) {
      rows = db.all<Record<string, unknown>>(
        'SELECT * FROM research_tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?',
        [status, limit]
      );
    } else {
      rows = db.all<Record<string, unknown>>(
        'SELECT * FROM research_tasks ORDER BY created_at DESC LIMIT ?',
        [limit]
      );
    }

    return rows.map((row) => this.rowToTask(row));
  }

  /** Oldest first, for the poll loop: newest-first let new tasks starve old ones (Codex). */
  private oldestTasks(status: QueuedTask['status'], limit: number): QueuedTask[] {
    this.ensureTable();
    const rows = getSyncDb().all<Record<string, unknown>>(
      'SELECT * FROM research_tasks WHERE status = ? ORDER BY created_at ASC LIMIT ?',
      [status, limit]
    );
    return rows.map((row) => this.rowToTask(row));
  }

  private rowToTask(row: Record<string, unknown>): QueuedTask {
    let tools: QueuedTask['tools'];
    if (row.tools) {
      tools = JSON.parse(row.tools as string);
    }

    let result: TaskResult | undefined;
    if (row.result) {
      result = JSON.parse(row.result as string);
    }

    let startedAt: Date | undefined;
    if (row.started_at) {
      startedAt = new Date(row.started_at as string);
    }

    let completedAt: Date | undefined;
    if (row.completed_at) {
      completedAt = new Date(row.completed_at as string);
    }

    return {
      id: row.id as string,
      prompt: row.prompt as string,
      context: row.context as string | undefined,
      tools,
      maxBudget: row.max_budget as number | undefined,
      userId: row.user_id as string,
      status: row.status as QueuedTask['status'],
      handleId: row.handle_id as string | undefined,
      result,
      error: row.error as string | undefined,
      createdAt: new Date(row.created_at as string),
      startedAt,
      completedAt,
    };
  }

  /**
   * Start the background polling loop
   */
  startPolling(): void {
    if (this.pollInterval) return;

    logger.info('🔬 Starting research queue polling');

    this.pollInterval = setInterval(() => {
      this.processTasks().catch((err) => {
        logger.error('🔬 Research queue error:', err);
      });
    }, 10000); // Poll every 10 seconds
  }

  /**
   * Stop polling
   */
  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      logger.info('🔬 Research queue polling stopped');
    }
  }

  /**
   * Process pending and running tasks
   */
  private async processTasks(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      // Check if harness is available
      if (!openaiResearchHarness.isAvailable()) {
        return;
      }

      // Submit pending tasks, first come first served
      const pending = this.oldestTasks('pending', 5);
      for (const task of pending) {
        await this.submitTask(task);
      }

      // Poll every running task (submissions are capped at 5 a tick, so this stays small)
      const running = this.oldestTasks('running', 1000);
      for (const task of running) {
        await this.pollTask(task);
      }
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Submit a pending task to the harness
   */
  private async submitTask(task: QueuedTask): Promise<void> {
    const db = getSyncDb();
    try {
      const handle = await openaiResearchHarness.submitTask({
        id: task.id,
        prompt: task.prompt,
        context: task.context,
        tools: task.tools,
        maxBudget: task.maxBudget,
        userId: task.userId,
        createdAt: task.createdAt,
      });

      db.run(
        `UPDATE research_tasks
         SET status = 'running', handle_id = ?, handle_provider = ?, started_at = datetime('now')
         WHERE id = ?`,
        [handle.id, handle.provider, task.id]
      );

      logger.info(`🔬 Task ${task.id} submitted to ${handle.provider}`);
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      db.run(`UPDATE research_tasks SET status = 'failed', error = ? WHERE id = ?`, [
        errorMsg,
        task.id,
      ]);

      logger.error(`🔬 Task ${task.id} failed to submit:`, error);
    }
  }

  /**
   * Poll a running task for completion
   */
  private async pollTask(task: QueuedTask): Promise<void> {
    if (!task.handleId) return;
    this.ensureTable();
    const db = getSyncDb();

    try {
      const handle: TaskHandle = {
        id: task.handleId,
        provider: 'openai',
        createdAt: task.startedAt || task.createdAt,
      };

      const status = await openaiResearchHarness.pollTask(handle);

      if (status.status === 'completed') {
        const result = await openaiResearchHarness.getResult(handle);

        db.run(
          `UPDATE research_tasks
           SET status = 'completed', result = ?, cost = ?, completed_at = datetime('now')
           WHERE id = ?`,
          [JSON.stringify(result), result.cost.total, task.id]
        );

        logger.info(`🔬 Task ${task.id} completed - $${result.cost.total.toFixed(2)}`);

        // Security audit 2026-10-26 (sec-abuse.md Critical #3): OpenAI deep-research spend
        // used to be tracked only in-memory and in research_tasks.cost — never written to
        // model_usage_stats, so daily-cap.ts's getTodaySpendUsd (which sums exactly that
        // table) never saw it and the daily budget mute could never trip on it. Cost lands
        // here, at completion, not at submit — there is no per-call cost before the task
        // finishes.
        void UsageLedger.recordUsage({
          model_name: 'openai/o4-mini-deep-research',
          user_id: task.userId,
          message_id: task.id,
          input_length: task.prompt.length,
          output_length: result.content.length,
          response_time_ms: 0,
          capabilities_detected: 0,
          capabilities_executed: 1,
          capability_types: 'deep_research',
          success: true,
          prompt_tokens: result.usage.inputTokens,
          completion_tokens: result.usage.outputTokens,
          total_tokens: result.usage.inputTokens + result.usage.outputTokens,
          estimated_cost: result.cost.total,
          step_type: 'deep_research',
        });

        await this.handleCompletion(task, result);
      } else if (status.status === 'failed') {
        db.run(`UPDATE research_tasks SET status = 'failed', error = ? WHERE id = ?`, [
          status.error || 'Unknown error',
          task.id,
        ]);

        logger.error(`🔬 Task ${task.id} failed: ${status.error}`);
      }
    } catch (error) {
      logger.error(`🔬 Error polling task ${task.id}:`, error);
    }
  }

  /**
   * Log a finished task. Delivery is pull-based: the result is saved on the task row and the
   * person (or Artie) reads it with deep_research `results`. Nothing pushes it anywhere, by
   * design; there's no wiki/Discord/entityhub hand-off.
   */
  private async handleCompletion(task: QueuedTask, result: TaskResult): Promise<void> {
    logger.info(`🔬 Research "${task.prompt.slice(0, 50)}..." completed`);
    logger.info(`   Cost: $${result.cost.total.toFixed(2)}`);
    logger.info(`   Tool calls: ${result.toolCalls?.length || 0}`);
    logger.info(`   Result length: ${result.content.length} chars`);
  }
}

export const researchQueueService = new ResearchQueueService();
