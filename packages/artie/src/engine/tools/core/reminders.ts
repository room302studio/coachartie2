import { schedulerService } from '../../jobs/scheduler.js';
import { RegisteredCapability } from '../../5-tool-loop/registry.js';

// =====================================================
// SCHEDULER CAPABILITY
// Set reminders, schedule recurring tasks, manage schedules
// =====================================================

function pluralS(count: number): string {
  if (count === 1) {
    return '';
  }
  return 's';
}

export const schedulerCapability: RegisteredCapability = {
  name: 'scheduler',
  emoji: '⏰',
  supportedActions: ['remind', 'schedule', 'list', 'cancel'],
  description:
    'Set one-time reminders (e.g., "remind me in 5 minutes"), view scheduled tasks, or cancel scheduled tasks. Recurring (cron) reminders are not supported yet.',
  handler: async (params, _content, context) => {
    const { action } = params;
    // Who the reminder belongs to comes from the real caller, never from model params: a
    // reminder replays through the full pipeline as that user when it fires, so a forged
    // userId (e.g. EJ's, via a context-less `sequence` call) would borrow their authority.
    const callerId = context?.userId || 'unknown-user';

    switch (action) {
      case 'remind': {
        const { message, delay } = params;
        if (!message) {
          throw new Error('Reminder message is required');
        }

        const delayMs = parseInt(String(delay)) || 60000; // Default 1 minute
        const reminderName = `reminder-${Date.now()}`;

        await schedulerService.scheduleOnce(
          reminderName,
          {
            type: 'user-reminder',
            message,
            userId: callerId,
            reminderType: 'one-time',
          },
          delayMs
        );

        const delayMinutes = Math.round(delayMs / 60000);
        return `✅ Reminder set: "${message}" in ${delayMinutes} minute${pluralS(delayMinutes)}`;
      }

      case 'schedule': {
        // Refused (2026-10-31): no handler ever ran a 'user-task', and the task registry is
        // in memory, so after a restart a user's cron can't be listed or cancelled and fires
        // forever from Redis. Say so instead of "✅ scheduled".
        return '❌ Recurring reminders aren\'t supported yet. I can set a one-time reminder instead (action "remind" with a delay).';
      }

      case 'list': {
        const tasks = await schedulerService.getScheduledTasks();

        if (tasks.length === 0) {
          return '📋 No scheduled tasks found';
        }

        const taskList = tasks
          .map((task) => `• ${task.name} - Next: ${task.nextRun.toLocaleString()}`)
          .join('\n');

        return `📋 Scheduled tasks (${tasks.length}):\n${taskList}`;
      }

      case 'cancel': {
        const { taskId } = params;
        if (!taskId) {
          throw new Error('Task ID is required for cancellation');
        }

        await schedulerService.removeTask(taskId);
        return `✅ Task "${taskId}" cancelled successfully`;
      }

      default:
        throw new Error(`Unknown scheduler action: ${action}`);
    }
  },
};
