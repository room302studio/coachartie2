/**
 * Research Queue Service
 *
 * Manages background research tasks:
 * - Queues research requests
 * - Polls for completion
 * - Writes results to wiki/entityhub
 * - Sends notifications
 */

import { logger, getSyncDb } from '@coachartie/shared';
import type { ResearchTask, TaskHandle, TaskResult } from './types.js';
import { openaiResearchHarness } from './openai-research.js';

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

export interface QueuedTask extends ResearchTask {
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

    db.run(
      `INSERT INTO research_tasks (id, prompt, context, tools, max_budget, user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        task.prompt,
        task.context || null,
        task.tools ? JSON.stringify(task.tools) : null,
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

    const rows = status
      ? db.all<Record<string, unknown>>(
          'SELECT * FROM research_tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?',
          [status, limit]
        )
      : db.all<Record<string, unknown>>(
          'SELECT * FROM research_tasks ORDER BY created_at DESC LIMIT ?',
          [limit]
        );

    return rows.map((row) => this.rowToTask(row));
  }

  private rowToTask(row: Record<string, unknown>): QueuedTask {
    return {
      id: row.id as string,
      prompt: row.prompt as string,
      context: row.context as string | undefined,
      tools: row.tools ? JSON.parse(row.tools as string) : undefined,
      maxBudget: row.max_budget as number | undefined,
      userId: row.user_id as string,
      status: row.status as QueuedTask['status'],
      handleId: row.handle_id as string | undefined,
      result: row.result ? JSON.parse(row.result as string) : undefined,
      error: row.error as string | undefined,
      createdAt: new Date(row.created_at as string),
      startedAt: row.started_at ? new Date(row.started_at as string) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at as string) : undefined,
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

      // Submit pending tasks
      const pending = this.listTasks('pending', 5);
      for (const task of pending) {
        await this.submitTask(task);
      }

      // Poll running tasks
      const running = this.listTasks('running', 10);
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
      const errorMsg = error instanceof Error ? error.message : String(error);
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

        // TODO: Write results to wiki, notify user
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
   * Handle completed research - write to wiki, notify user
   */
  private async handleCompletion(task: QueuedTask, result: TaskResult): Promise<void> {
    // TODO: Implement wiki integration
    // TODO: Implement Discord notification
    // TODO: Implement entityhub integration

    logger.info(`🔬 Research "${task.prompt.slice(0, 50)}..." completed`);
    logger.info(`   Cost: $${result.cost.total.toFixed(2)}`);
    logger.info(`   Tool calls: ${result.toolCalls?.length || 0}`);
    logger.info(`   Result length: ${result.content.length} chars`);

    // For now, just log. Will wire up wiki/notifications later.
  }
}

export const researchQueueService = new ResearchQueueService();
