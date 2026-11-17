import { randomUUID } from 'node:crypto';
import { formatInTimeZone } from 'date-fns-tz';
import { schedulerService } from '../../jobs/scheduler.js';
import { RegisteredCapability } from '../../5-tool-loop/registry.js';
import { isOwner } from '../../../shared/config/owner.js';
import {
  MAX_MESSAGE_CHARS,
  cancelRecurringReminder,
  createRecurringReminder,
  getRecurringReminder,
  isValidTimezone,
  listRecurringReminders,
} from '../../jobs/recurring-reminders.js';

// =====================================================
// SCHEDULER CAPABILITY
// One-time reminders (remind, a delayed BullMQ job) and repeating ones (remind_every, a
// SQLite row ticked by the scheduler: see jobs/recurring-reminders.ts).
// `schedule` stays declared only to point old callers at remind_every.
// =====================================================

function pluralS(count: number): string {
  if (count === 1) {
    return '';
  }
  return 's';
}

const TIME_FORMAT = 'EEE yyyy-MM-dd HH:mm zzz';

/** The user's timezone: explicit param, else their profile, else UTC. Never throws. */
async function resolveTimezone(
  explicit: unknown,
  userId: string
): Promise<{ tz: string; source: 'param' | 'profile' | 'default' } | { error: string }> {
  if (explicit) {
    const tz = String(explicit).trim();
    if (!isValidTimezone(tz)) {
      return { error: `"${tz}" isn't a timezone I know. Use an IANA name like America/New_York.` };
    }
    return { tz, source: 'param' };
  }
  try {
    // Dynamic: the profile service opens a Redis connection when imported.
    const { UserProfileService } = await import('../../../shared/db/user-profiles.js');
    const saved = await UserProfileService.getAttribute(userId, 'timezone');
    if (saved && isValidTimezone(saved)) {
      return { tz: saved, source: 'profile' };
    }
  } catch {
    // no profile: fall through to UTC
  }
  return { tz: 'UTC', source: 'default' };
}

function isRecurringId(raw: string): number | null {
  // The R prefix is required: a bare number can be a one-time job id, and cancelling it must
  // never hit an unrelated recurring reminder that happens to share the number (Codex).
  const m = /^r(\d+)$/i.exec(raw.trim());
  if (!m) return null;
  return Number(m[1]);
}

export const schedulerCapability: RegisteredCapability = {
  name: 'scheduler',
  emoji: '⏰',
  actions: {
    remind: {
      effect: 'discord', // sends a DM later
      params: {
        message: { type: 'string', description: 'What to remind the person of', required: true },
        delay: { type: 'integer', description: 'Milliseconds from now (default 60000 = 1 minute)' },
      },
    },
    remind_every: {
      effect: 'discord', // sends a DM on a repeating schedule
      params: {
        message: {
          type: 'string',
          description: `What to remind the person of (max ${MAX_MESSAGE_CHARS} chars)`,
          required: true,
        },
        every: {
          type: 'string',
          description:
            'Schedule: "every 6 hours", "every day", "every week", "every weekday at 9:00", "every monday 18:30". At most hourly.',
          required: true,
          aliases: ['schedule', 'interval'],
        },
        timezone: {
          type: 'string',
          description: 'IANA zone for a time of day, e.g. America/New_York (default: their profile, else UTC)',
        },
      },
    },
    schedule: { effect: 'discord' }, // refuses and points at remind_every
    list: { effect: 'read' },
    cancel: {
      effect: 'discord', // the caller's own reminders only (the owner may cancel anyone's)
      params: {
        taskId: {
          type: 'string',
          description: 'Reminder id from list (R7 for repeating, rem-... for one-time)',
          required: true,
          aliases: ['id', 'reminder_id'],
        },
      },
    },
  },
  supportedActions: ['remind', 'remind_every', 'schedule', 'list', 'cancel'],
  description:
    'Use for timed reminders to the person asking: once (remind) or repeating (remind_every). list shows your reminders, cancel stops one. Repeats at most hourly, 5 per person.',
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
        if (!schedulerService.isReady()) {
          return '❌ The scheduler is offline right now, so I can\'t set a reminder. Try again in a bit.';
        }

        const delayMs = parseInt(String(delay)) || 60000; // Default 1 minute
        const reminderName = `reminder-${Date.now()}`;
        // Short but collision-safe: two reminders in the same millisecond must not share a BullMQ
        // id (BullMQ would silently drop the second while both callers hear "set") (Codex).
        const jobId = `rem-${randomUUID().replace(/-/g, '').slice(0, 12)}`;

        await schedulerService.scheduleOnce(
          reminderName,
          {
            type: 'user-reminder',
            message,
            userId: callerId,
            reminderType: 'one-time',
          },
          delayMs,
          jobId
        );

        const delayMinutes = Math.round(delayMs / 60000);
        return `✅ Reminder set: "${message}" in ${delayMinutes} minute${pluralS(delayMinutes)} (id ${jobId})`;
      }

      case 'remind_every': {
        if (callerId === 'unknown-user') {
          return '❌ I can\'t tell who you are here, so I can\'t set a repeating reminder.';
        }
        const message = String(params.message ?? '').trim();
        const every = String(params.every ?? '').trim();
        if (!message) {
          throw new Error('Reminder message is required');
        }
        if (!every) {
          throw new Error('"every" is required, e.g. "every weekday at 9:00"');
        }
        const zone = await resolveTimezone(params.timezone, callerId);
        if ('error' in zone) {
          return `❌ ${zone.error}`;
        }
        const created = createRecurringReminder({
          userId: callerId,
          message,
          every,
          timezone: zone.tz,
        });
        if (!created.ok) {
          return `❌ ${created.error}`;
        }
        const row = created.row;
        const next = formatInTimeZone(new Date(row.next_fire_at), row.timezone, TIME_FORMAT);
        let tzNote = '';
        if (row.kind === 'calendar') {
          tzNote = ` (${row.timezone} time`;
          if (zone.source === 'default') {
            tzNote += ': you have no timezone saved, so I used UTC; say your timezone to change it';
          }
          tzNote += ')';
        }
        return `✅ Repeating reminder R${row.id}: "${row.message}" ${row.schedule_text}${tzNote}. Next: ${next}. I'll DM you each time.`;
      }

      case 'schedule': {
        return '❌ Cron-style scheduling isn\'t supported. For a repeating reminder use action "remind_every" with message and every (e.g. "every weekday at 9:00"); for a single one use "remind" with a delay.';
      }

      case 'list': {
        const owner = isOwner(callerId);
        let scope: string | null = callerId;
        if (owner) {
          scope = null;
        }
        const recurring = listRecurringReminders(scope);
        const once = await schedulerService.listOneTimeReminders(scope);
        if (recurring.length === 0 && once.length === 0) {
          return '📋 No reminders set';
        }
        const lines: string[] = [];
        for (const r of recurring) {
          const next = formatInTimeZone(new Date(r.next_fire_at), r.timezone, TIME_FORMAT);
          let who = '';
          if (owner && r.user_id !== callerId) {
            who = ` [user ${r.user_id}]`;
          }
          lines.push(`• R${r.id}: "${r.message}" ${r.schedule_text}, next ${next}${who}`);
        }
        for (const o of once) {
          let who = '';
          if (owner && o.userId !== callerId) {
            who = ` [user ${o.userId}]`;
          }
          lines.push(`• ${o.id}: "${o.message}" once, at ${o.runAt.toISOString()}${who}`);
        }
        return `📋 Reminders (${lines.length}):\n${lines.join('\n')}`;
      }

      case 'cancel': {
        const taskId = String(params.taskId ?? '').trim();
        if (!taskId) {
          throw new Error('Task ID is required for cancellation');
        }
        const owner = isOwner(callerId);

        const recurringId = isRecurringId(taskId);
        if (recurringId !== null) {
          const row = getRecurringReminder(recurringId);
          // Same answer for "no such id" and "someone else's": don't confirm other people's ids.
          if (!row || row.active !== 1 || (row.user_id !== callerId && !owner)) {
            return `❌ I don't see a reminder R${recurringId} of yours.`;
          }
          cancelRecurringReminder(recurringId);
          return `✅ Repeating reminder R${recurringId} cancelled ("${row.message}")`;
        }

        const jobOwner = await schedulerService.getOneTimeReminderOwner(taskId);
        if (jobOwner !== null) {
          if (jobOwner !== callerId && !owner) {
            return `❌ I don't see a reminder "${taskId}" of yours.`;
          }
          const removed = await schedulerService.cancelOnce(taskId);
          if (!removed) {
            return `❌ Reminder "${taskId}" couldn't be cancelled (it may have just fired or already been removed).`;
          }
          return `✅ Reminder "${taskId}" cancelled`;
        }

        // Not a reminder: system tasks (health checks, digests) are the owner's alone.
        if (!owner) {
          if (/^\d+$/.test(String(taskId).trim())) {
            return `❌ I don't see a reminder "${taskId}" of yours. Repeating reminders are cancelled as R${String(taskId).trim()} (see list).`;
          }
          return `❌ I don't see a reminder "${taskId}" of yours.`;
        }
        await schedulerService.removeTask(taskId);
        return `✅ Task "${taskId}" cancelled successfully`;
      }

      default:
        throw new Error(`Unknown scheduler action: ${action}`);
    }
  },
};
