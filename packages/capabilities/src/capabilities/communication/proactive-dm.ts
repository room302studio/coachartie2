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

import { logger, canReceiveProactiveDMs, isAdmin } from '@coachartie/shared';
import { Queue } from 'bullmq';
import { createRedisConnection, testRedisConnection } from '@coachartie/shared';
import type {
  RegisteredCapability,
  CapabilityContext,
} from '../../services/capability/capability-registry.js';

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
    discordQueue = new Queue('coachartie-discord-outgoing', {
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
  const callerIsAdmin = callerUserId ? isAdmin(callerUserId) : false;
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

        const delay = params.delay;
        let success: boolean;

        if (delay && delay > 0) {
          success = await sendDelayedDM(targetUserId, message, delay, 'user-requested');
          if (success) {
            const delayStr = delay > 60000
              ? `${Math.round(delay / 60000)} minutes`
              : `${Math.round(delay / 1000)} seconds`;
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

        const delay = params.delay || 60000; // Default 1 minute
        const reminderMessage = `**Reminder**\n\n${message}`;
        const success = await sendDelayedDM(targetUserId, reminderMessage, delay, 'reminder');

        if (success) {
          const delayStr = delay > 60000
            ? `${Math.round(delay / 60000)} minutes`
            : `${Math.round(delay / 1000)} seconds`;
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
    return `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

// Export for use by other services
export { sendDiscordDM, sendDelayedDM };

export const proactiveDMCapability: RegisteredCapability = {
  name: 'proactive-dm',
  emoji: '📤',
  supportedActions: ['send', 'dm', 'message', 'notify', 'alert', 'remind', 'followup', 'status'],
  description: `Send messages to users proactively - Clawdbot-style. Actions:
- send/dm/message: Send a message to a user (optional delay in ms)
- notify/alert: Send an alert notification
- remind: Set a reminder with delay
- followup: Send a follow-up after task completion
- status: Check proactive messaging system status

Used internally by scheduler for briefings, trend digests, and alerts.`,
  handler: handleProactiveDM,
};
