/**
 * Task Status Capability
 *
 * Send brief status updates during extended operations.
 * Inspired by Clawdbot's "task-status" skill.
 *
 * This allows Artie to keep users informed during long-running tasks
 * without waiting for full completion.
 *
 * Usage:
 * - During multi-step operations, emit progress updates
 * - Track what Artie is currently working on
 * - Provide ETA estimates for long tasks
 */

import { logger } from '@coachartie/shared';
import type {
  RegisteredCapability,
  CapabilityContext,
} from '../../services/capability/capability-registry.js';

interface TaskStatusParams {
  action: string;
  taskName?: string;
  status?: string;
  progress?: number; // 0-100
  eta?: string;
  details?: string;
  [key: string]: unknown;
}

interface ActiveTask {
  id: string;
  name: string;
  status: string;
  progress: number;
  startedAt: string;
  lastUpdate: string;
  eta?: string;
  details?: string;
}

// Track active tasks per user
const activeTasks = new Map<string, ActiveTask[]>();

/**
 * Format progress bar
 */
function progressBar(progress: number, width: number = 10): string {
  const filled = Math.round((progress / 100) * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

/**
 * Format time elapsed
 */
function formatElapsed(startedAt: string): string {
  const elapsed = Date.now() - new Date(startedAt).getTime();
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Task status capability handler
 */
async function handleTaskStatus(
  params: TaskStatusParams,
  content?: string,
  ctx?: CapabilityContext
): Promise<string> {
  const { action } = params;
  const userId = ctx?.userId || 'unknown-user';

  logger.info(`📊 Task status - Action: ${action}, UserId: ${userId}`);

  // Get or initialize user's tasks
  if (!activeTasks.has(userId)) {
    activeTasks.set(userId, []);
  }
  const userTasks = activeTasks.get(userId)!;

  try {
    switch (action) {
      case 'start':
      case 'begin': {
        const taskName = params.taskName || content || 'Unnamed task';
        const task: ActiveTask = {
          id: `task-${Date.now()}`,
          name: taskName,
          status: params.status || 'Starting...',
          progress: params.progress || 0,
          startedAt: new Date().toISOString(),
          lastUpdate: new Date().toISOString(),
          eta: params.eta,
          details: params.details,
        };

        userTasks.push(task);

        return `🚀 **Started:** ${taskName}\n[${progressBar(0)}] 0%`;
      }

      case 'update':
      case 'progress': {
        const taskName = params.taskName;
        const task = taskName
          ? userTasks.find(t => t.name.toLowerCase().includes(taskName.toLowerCase()))
          : userTasks[userTasks.length - 1];

        if (!task) {
          return '⚠️ No active task to update.';
        }

        if (params.status) task.status = params.status;
        if (params.progress !== undefined) task.progress = params.progress;
        if (params.eta) task.eta = params.eta;
        if (params.details) task.details = params.details;
        task.lastUpdate = new Date().toISOString();

        const elapsed = formatElapsed(task.startedAt);
        const etaStr = task.eta ? ` • ETA: ${task.eta}` : '';

        return `📊 **${task.name}**\n[${progressBar(task.progress)}] ${task.progress}%${etaStr}\n${task.status} (${elapsed})`;
      }

      case 'complete':
      case 'done':
      case 'finish': {
        const taskName = params.taskName;
        const taskIndex = taskName
          ? userTasks.findIndex(t => t.name.toLowerCase().includes(taskName.toLowerCase()))
          : userTasks.length - 1;

        if (taskIndex === -1) {
          return '⚠️ No active task to complete.';
        }

        const task = userTasks[taskIndex];
        const elapsed = formatElapsed(task.startedAt);
        userTasks.splice(taskIndex, 1);

        return `✅ **Completed:** ${task.name}\nFinished in ${elapsed}${params.details ? `\n${params.details}` : ''}`;
      }

      case 'fail':
      case 'error': {
        const taskName = params.taskName;
        const taskIndex = taskName
          ? userTasks.findIndex(t => t.name.toLowerCase().includes(taskName.toLowerCase()))
          : userTasks.length - 1;

        if (taskIndex === -1) {
          return '⚠️ No active task.';
        }

        const task = userTasks[taskIndex];
        const elapsed = formatElapsed(task.startedAt);
        userTasks.splice(taskIndex, 1);

        return `❌ **Failed:** ${task.name}\nAfter ${elapsed}${params.details ? `\nError: ${params.details}` : ''}`;
      }

      case 'list':
      case 'active': {
        if (userTasks.length === 0) {
          return '📭 No active tasks.';
        }

        const taskList = userTasks.map(task => {
          const elapsed = formatElapsed(task.startedAt);
          return `📊 **${task.name}**\n   [${progressBar(task.progress)}] ${task.progress}% • ${task.status} (${elapsed})`;
        }).join('\n\n');

        return `🔄 **Active Tasks:**\n\n${taskList}`;
      }

      case 'cancel':
      case 'abort': {
        const taskName = params.taskName;
        const taskIndex = taskName
          ? userTasks.findIndex(t => t.name.toLowerCase().includes(taskName.toLowerCase()))
          : userTasks.length - 1;

        if (taskIndex === -1) {
          return '⚠️ No active task to cancel.';
        }

        const task = userTasks[taskIndex];
        userTasks.splice(taskIndex, 1);

        return `🚫 **Cancelled:** ${task.name}`;
      }

      default:
        return `Unknown task-status action: ${action}. Try: start, update, complete, fail, list, cancel`;
    }
  } catch (error) {
    logger.error('Task status error:', error);
    return `❌ Task status error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

export const taskStatusCapability: RegisteredCapability = {
  name: 'task-status',
  emoji: '📊',
  supportedActions: ['start', 'begin', 'update', 'progress', 'complete', 'done', 'finish', 'fail', 'error', 'list', 'active', 'cancel', 'abort'],
  description: `Track and report progress during extended operations. Actions:
- start/begin: Begin tracking a new task (taskName required)
- update/progress: Update task progress (progress 0-100, status text, eta)
- complete/done: Mark task as successfully finished
- fail/error: Mark task as failed with optional error details
- list/active: Show all active tasks
- cancel/abort: Cancel a task

Use this to keep users informed during long operations like research, file processing, or multi-step workflows.`,
  handler: handleTaskStatus,
};
