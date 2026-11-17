/**
 * Proactive DM Capability
 *
 * Send messages to users proactively - not just in response.
 * This is the key to Clawdbot-style behavior where Artie initiates conversations.
 *
 * Usage:
 * - Internal: Used by scheduler for briefings, reminders, alerts
 * - Direct: "DM me the results when you're done"
 * - Scheduled: "Send me a trend report every morning"
 */

import { logger } from '../../shared/logger.js';
import { canReceiveProactiveDMs, isAdmin } from '../../shared/config/owner.js';
import { getErrorMessage } from '../../shared/errors.js';
import { Queue } from 'bullmq';
import { createRedisConnection, testRedisConnection } from '../../shared/queue/redis.js';
import { QUEUES } from '../../shared/queue/names.js';
import type {
  RegisteredCapability,
  CapabilityContext,
} from '../5-tool-loop/registry.js';

interface ProactiveDMParams {
  action: string;
  userId?: string;
  message?: string;
  channel?: 'discord' | 'sms' | 'both';
  delay?: number; // ms delay before sending
  schedule?: string; // cron expression for recurring
  [key: string]: unknown;
}

// Queue for outgoing Discord messages
let discordQueue: Queue | null = null;

async function initQueue(): Promise<Queue | null> {
  if (discordQueue) return discordQueue;

  const redisOk = await testRedisConnection();
  if (!redisOk) {
    logger.warn('Proactive DM: Redis unavailable');
    return null;
  }

  try {
    discordQueue = new Queue(QUEUES.OUTGOING_DISCORD, {
      connection: createRedisConnection(),
    });
    return discordQueue;
  } catch (error) {
    logger.error('Failed to create Discord queue:', error);
    return null;
  }
}

/**
 * Send a DM via the Discord outgoing queue
 */
async function sendDiscordDM(
  userId: string,
  message: string,
  source: string = 'proactive-dm'
): Promise<boolean> {
  const queue = await initQueue();
  if (!queue) {
    logger.error('Cannot send DM: Discord queue unavailable');
    return false;
  }

  try {
    await queue.add('send-dm', {
      userId,
      content: message,
      source,
    });
    logger.info(`Proactive DM queued for ${userId}`);
    return true;
  } catch (error) {
    logger.error('Failed to queue DM:', error);
    return false;
  }
}

/**
 * Send a DM with delay
 */
async function sendDelayedDM(
  userId: string,
  message: string,
  delayMs: number,
  source: string = 'delayed-dm'
): Promise<boolean> {
  const queue = await initQueue();
  if (!queue) {
    logger.error('Cannot send delayed DM: Discord queue unavailable');
    return false;
  }

  try {
    await queue.add(
      'send-dm',
      {
        userId,
        content: message,
        source,
      },
      { delay: delayMs }
    );
    logger.info(`Delayed DM queued for ${userId} (${delayMs}ms)`);
    return true;
  } catch (error) {
    logger.error('Failed to queue delayed DM:', error);
    return false;
  }
}

/**
 * Format delay in milliseconds as a human-readable string
 */
function formatDelayString(delayMs: number): string {
  if (delayMs > 60000) {
    return `${Math.round(delayMs / 60000)} minutes`;
  }
  return `${Math.round(delayMs / 1000)} seconds`;
}

/**
 * Check if a user is an admin
 */
function isCallerAdmin(callerUserId: string | undefined): boolean {
  if (callerUserId) {
    return isAdmin(callerUserId);
  }
  return false;
}

/**
 * Proactive DM capability handler
 */
async function handleProactiveDM(
  params: ProactiveDMParams,
  content?: string,
  ctx?: CapabilityContext
): Promise<string> {
  const { action } = params;
  const targetUserId = params.userId || ctx?.userId;
  const callerUserId = ctx?.userId;
  const message = params.message || content;

  logger.info(`Proactive DM - Action: ${action}, Target: ${targetUserId}, Caller: ${callerUserId}`);

  if (!targetUserId) {
    return 'User ID required for proactive messaging.';
  }

  // SECURITY: Check permissions for DMing
  // - Self-DMs are always allowed (user asks to be DMed themselves)
  // - DMing others requires admin privileges
  // - Target must be in the whitelist to receive proactive DMs
  const isSelfDM = targetUserId === callerUserId;
  const callerIsAdmin = isCallerAdmin(callerUserId);
  const targetCanReceiveDMs = canReceiveProactiveDMs(targetUserId);

  if (!isSelfDM && !callerIsAdmin) {
    logger.warn(`Proactive DM blocked: ${callerUserId} tried to DM ${targetUserId} (not admin)`);
    return 'You can only send proactive DMs to yourself. Ask an admin to enable this for others.';
  }

  if (!isSelfDM && !targetCanReceiveDMs) {
    logger.warn(`Proactive DM blocked: target ${targetUserId} not in whitelist`);
    return 'Target user is not opted-in to receive proactive messages.';
  }

  try {
    switch (action) {
      case 'send':
      case 'dm':
      case 'message': {
        if (!message) {
          return 'Message content required.';
        }

        // The native tool path hands every param over as a string; BullMQ wants a number.
        const delay = Number(params.delay) || 0;
        let success: boolean;

        if (delay && delay > 0) {
          success = await sendDelayedDM(targetUserId, message, delay, 'user-requested');
          if (success) {
            const delayStr = formatDelayString(delay);
            return `Message scheduled for delivery in ${delayStr}.`;
          }
        } else {
          success = await sendDiscordDM(targetUserId, message, 'user-requested');
          if (success) {
            return `Message queued for delivery.`;
          }
        }

        return 'Failed to queue message. Please try again.';
      }

      case 'notify':
      case 'alert': {
        if (!message) {
          return 'Alert content required.';
        }

        const alertMessage = `**Alert**\n\n${message}`;
        const success = await sendDiscordDM(targetUserId, alertMessage, 'alert');

        if (success) {
          return 'Alert sent.';
        }
        return 'Failed to send alert.';
      }

      case 'remind': {
        if (!message) {
          return 'Reminder content required.';
        }

        const delay = Number(params.delay) || 60000; // Default 1 minute
        const reminderMessage = `**Reminder**\n\n${message}`;
        const success = await sendDelayedDM(targetUserId, reminderMessage, delay, 'reminder');

        if (success) {
          const delayStr = formatDelayString(delay);
          return `Reminder set for ${delayStr}.`;
        }
        return 'Failed to set reminder.';
      }

      case 'followup': {
        // Send a follow-up message after completing a task
        const followupMessage = message || 'Task completed! Let me know if you need anything else.';
        const success = await sendDiscordDM(targetUserId, followupMessage, 'followup');

        if (success) {
          return 'Follow-up sent.';
        }
        return 'Failed to send follow-up.';
      }

      case 'status': {
        const queue = await initQueue();
        if (!queue) {
          return 'Proactive messaging unavailable (Redis down).';
        }

        try {
          const waiting = await queue.getWaiting();
          const delayed = await queue.getDelayed();
          const active = await queue.getActive();

          return `**Proactive DM Status**

Queued: ${waiting.length}
Delayed: ${delayed.length}
Active: ${active.length}

System ready for proactive messaging.`;
        } catch {
          return 'Unable to get queue status.';
        }
      }

      default:
        return `Unknown proactive-dm action: ${action}. Try: send, notify, alert, remind, followup, status`;
    }
  } catch (error) {
    logger.error('Proactive DM error:', error);
    return `Error: ${getErrorMessage(error)}`;
  }
}

// Export for use by other services
export { sendDiscordDM };

const DM_MESSAGE = { type: 'string', description: 'The text to send', required: true } as const;
const DM_DELAY = { type: 'integer', description: 'Delay in milliseconds before sending' } as const;

export const proactiveDMCapability: RegisteredCapability = {
  name: 'proactive-dm',
  emoji: '📤',
  // The handler takes the recipient from ctx.userId (the asker); a model-supplied userId only
  // works for admins, so userId is deliberately not offered as a param.
  actions: {
    send: { effect: 'discord', params: { message: DM_MESSAGE, delay: DM_DELAY } },
    dm: { effect: 'discord', params: { message: DM_MESSAGE, delay: DM_DELAY } },
    message: { effect: 'discord', params: { message: DM_MESSAGE, delay: DM_DELAY } },
    notify: { effect: 'discord', params: { message: DM_MESSAGE } },
    alert: { effect: 'discord', params: { message: DM_MESSAGE } },
    remind: { effect: 'discord', params: { message: DM_MESSAGE, delay: DM_DELAY } },
    followup: {
      effect: 'discord',
      params: { message: { type: 'string', description: 'Follow-up text (default: a short task-done line)' } },
    },
    status: { effect: 'read' },
  },
  supportedActions: ['send', 'dm', 'message', 'notify', 'alert', 'remind', 'followup', 'status'],
  description: `DM the person asking, now or after a short delay, outside this chat ("DM me when it's done"). Timed reminders: use scheduler. Note for someone's morning briefing: use relay.
Actions:
- send/dm/message: DM now (or after delay in ms)
- notify/alert: DM an alert-styled message
- remind: DM a reminder after delay in ms (default 1 min); for real reminders prefer scheduler
- followup: DM a follow-up after finishing a task
- status: queue depth

You can only DM yourself unless you are an admin and the target opted in. Also used internally for briefings, trend digests and alerts.`,
  handler: handleProactiveDM,
};
