import { schedulerService } from '../../services/core/scheduler.js';
import { RegisteredCapability } from '../../services/capability/capability-registry.js';

// =====================================================
// SCHEDULER CAPABILITY
// Set reminders, schedule recurring tasks, manage schedules
// =====================================================

export const schedulerCapability: RegisteredCapability = {
  name: 'scheduler',
  emoji: '⏰',
  supportedActions: ['remind', 'schedule', 'list', 'cancel'],
  description:
    'Set one-time reminders (e.g., "remind me in 5 minutes"), schedule recurring tasks with cron expressions, view scheduled tasks, or cancel scheduled reminders. Perfect for time-based automation and remembering things.',
  handler: async (params, _content) => {
    const { action } = params;

    switch (action) {
      case 'remind': {
        const { message, delay, userId } = params;
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
            userId: userId || 'unknown-user',
            reminderType: 'one-time',
          },
          delayMs
        );

        const delayMinutes = Math.round(delayMs / 60000);
        return `✅ Reminder set: "${message}" in ${delayMinutes} minute${delayMinutes !== 1 ? 's' : ''}`;
      }

      case 'schedule': {
        const { name, cron, message, userId } = params;
        if (!name || !cron) {
          throw new Error('Task name and cron expression are required');
        }

        const taskId = `task-${Date.now()}`;

        await schedulerService.scheduleTask({
          id: taskId,
          name,
          cron,
          data: {
            type: 'user-task',
            message: message || `Scheduled task: ${name}`,
            userId: userId || 'unknown-user',
          },
        });

        return `✅ Recurring task scheduled: "${name}" (${cron})`;
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
