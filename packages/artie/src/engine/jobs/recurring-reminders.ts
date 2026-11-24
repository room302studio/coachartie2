/**
 * Recurring reminders (2026-11-17): "every 6 hours", "every weekday at 9:00".
 *
 * Why a table and a tick, not BullMQ repeatables: a repeatable lives in Redis under a key the
 * scheduler's in-memory task map forgets on restart, so a user's cron could not be listed or
 * cancelled afterwards and fired forever (the reason `schedule` was refused on 2026-10-31).
 * Here the SQLite row is the whole truth. One built-in repeatable ("recurring-reminders",
 * every minute) calls fireDueRecurringReminders(); nothing per-user ever lives in Redis.
 *
 * Fire semantics (the two rules that matter):
 *  - No drift: the next time is computed from the SCHEDULE (an anchor grid, or a wall-clock
 *    time in the user's zone), never from "now + interval", so a late tick doesn't slide it.
 *  - No burst: after downtime a reminder fires ONCE, then jumps to the first slot strictly
 *    after now. Missed slots are skipped, not replayed.
 *  - At most once per slot: next_fire_at is advanced with a compare-and-swap UPDATE BEFORE the
 *    message is queued. A crash between the two loses that one fire; it can never double-send
 *    (a restart, or two ticks racing, sees the advanced row and skips). If the queue add itself
 *    throws we put next_fire_at back (again compare-and-swap) so the next tick retries.
 *
 * Delivery is a DM to the user who set it, a plain message: no LLM, no tools, so a reminder
 * can't be turned into an action by whatever text it carries. (The caller id is always the
 * verified context user, set in reminders.ts, never a model param.)
 */
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { getRawDb, getSyncDb } from '../../shared/db/client.js';
import { logger } from '../../shared/logger.js';

const MIN_INTERVAL_MS = 60 * 60 * 1000;
const MAX_INTERVAL_MS = 366 * 24 * 60 * 60 * 1000;
export const MAX_ACTIVE_PER_USER = 5;
export const MAX_MESSAGE_CHARS = 300;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type ParsedSchedule =
  | { kind: 'interval'; intervalMs: number; text: string }
  | { kind: 'calendar'; days: number[]; time: string; text: string };

type ParseResult = { ok: true; schedule: ParsedSchedule } | { ok: false; error: string };

const DAY_NAMES: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};
const WEEKDAY_ORDER = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const EXAMPLES = '"every 6 hours", "every day", "every week", "every weekday at 9:00", "every monday 18:30"';

const INTERVAL_RE = /^(\d+)?\s*(minute|min|hour|hr|day|week)s?$/;
const CALENDAR_RE = /^(.+?)(?:\s+at)?\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midnight)$/;
const TIME_RE = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function parseTime(raw: string): string | null {
  if (raw === 'noon') return '12:00';
  if (raw === 'midnight') return '00:00';
  const m = TIME_RE.exec(raw);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] || 0);
  const meridiem = m[3];
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'am' && hour === 12) hour = 0;
    if (meridiem === 'pm' && hour !== 12) hour += 12;
  }
  if (hour > 23) return null;
  return `${pad2(hour)}:${pad2(minute)}`;
}

function parseDays(raw: string): number[] | null {
  const tokens = raw.split(/[\s,]+|\band\b/).filter((t) => t && t !== 'and');
  if (tokens.length === 0) return null;
  const days = new Set<number>();
  for (const token of tokens) {
    const word = token.replace(/s$/, '');
    if (word === 'weekday') {
      [1, 2, 3, 4, 5].forEach((d) => days.add(d));
    } else if (word === 'weekend') {
      days.add(0);
      days.add(6);
    } else if (word === 'day' || word === 'dai' || token === 'daily') {
      [0, 1, 2, 3, 4, 5, 6].forEach((d) => days.add(d));
    } else if (token in DAY_NAMES) {
      days.add(DAY_NAMES[token]);
    } else if (word in DAY_NAMES) {
      days.add(DAY_NAMES[word]);
    } else {
      return null;
    }
  }
  return [...days].sort((a, b) => a - b);
}

function describeDays(days: number[]): string {
  if (days.length === 7) return 'day';
  if (days.join() === '1,2,3,4,5') return 'weekday';
  if (days.join() === '0,6') return 'weekend day';
  return days.map((d) => WEEKDAY_ORDER[d]).join('/');
}

function describeInterval(ms: number): string {
  if (ms % (7 * DAY_MS) === 0) {
    const n = ms / (7 * DAY_MS);
    if (n === 1) return 'week';
    return `${n} weeks`;
  }
  if (ms % DAY_MS === 0) {
    const n = ms / DAY_MS;
    if (n === 1) return 'day';
    return `${n} days`;
  }
  const n = ms / HOUR_MS;
  if (n === 1) return 'hour';
  return `${n} hours`;
}

/** Canonical text of a parsed schedule, e.g. "every 6 hours" or "every weekday at 09:00". */
function describeSchedule(s: ParsedSchedule): string {
  if (s.kind === 'interval') return `every ${describeInterval(s.intervalMs)}`;
  return `every ${describeDays(s.days)} at ${s.time}`;
}

/**
 * Parse a schedule phrase. Accepts an interval ("every 6 hours", "every day", "hourly",
 * "every 2 weeks") or a wall-clock schedule with a time ("every weekday at 9:00", "every
 * monday 18:30", "every mon, wed and fri at 8am"). Anything else is rejected with a reason
 * the model can relay.
 */
export function parseSchedule(input: string): ParseResult {
  let text = String(input ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (!text) {
    return { ok: false, error: `Say how often, e.g. ${EXAMPLES}.` };
  }
  if (text === 'hourly') text = 'every hour';
  if (text === 'daily') text = 'every day';
  if (text === 'weekly') text = 'every week';
  text = text.replace(/^(repeat(ing)?\s+)?every\s+/, '');
  if (text.startsWith('daily ')) text = `day ${text.slice(6)}`;

  const interval = INTERVAL_RE.exec(text);
  if (interval) {
    const n = Number(interval[1] || 1);
    const unit = interval[2];
    let unitMs = HOUR_MS;
    if (unit === 'minute' || unit === 'min') unitMs = 60 * 1000;
    if (unit === 'day') unitMs = DAY_MS;
    if (unit === 'week') unitMs = 7 * DAY_MS;
    const intervalMs = n * unitMs;
    if (!Number.isFinite(intervalMs) || n < 1) {
      return { ok: false, error: `That interval isn't valid. Try ${EXAMPLES}.` };
    }
    if (intervalMs < MIN_INTERVAL_MS) {
      return { ok: false, error: 'Recurring reminders can repeat at most once an hour (minimum interval: 1 hour).' };
    }
    if (intervalMs > MAX_INTERVAL_MS) {
      return { ok: false, error: 'Recurring reminders can repeat at most once every 366 days; use a one-time reminder for later.' };
    }
    const schedule: ParsedSchedule = { kind: 'interval', intervalMs, text: '' };
    schedule.text = describeSchedule(schedule);
    return { ok: true, schedule };
  }

  const calendar = CALENDAR_RE.exec(text);
  if (calendar) {
    const days = parseDays(calendar[1]);
    const time = parseTime(calendar[2]);
    if (!days) {
      return { ok: false, error: `I couldn't read the days in "${calendar[1]}". Try ${EXAMPLES}.` };
    }
    if (!time) {
      return { ok: false, error: `I couldn't read the time "${calendar[2]}". Use 9:00, 18:30 or 9am.` };
    }
    const schedule: ParsedSchedule = { kind: 'calendar', days, time, text: '' };
    schedule.text = describeSchedule(schedule);
    return { ok: true, schedule };
  }

  if (parseDays(text)) {
    return { ok: false, error: `"every ${text}" needs a time of day, e.g. "every ${text} at 9:00".` };
  }
  return { ok: false, error: `I couldn't read that schedule. Try ${EXAMPLES}.` };
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The first fire slot STRICTLY after `after`. Interval schedules sit on the grid
 * anchor + k * interval (k >= 1), so a late tick never shifts later slots. Calendar schedules
 * pick the wall-clock time on an allowed weekday in `tz`, one local date at a time, so a
 * daylight-saving change moves the UTC instant but keeps 9:00 at 9:00. (A local time that
 * doesn't exist that day, e.g. 02:30 on spring-forward, fires at the shifted instant.)
 */
export function nextFireAfter(
  schedule: ParsedSchedule,
  after: Date,
  anchor: Date,
  tz: string
): Date {
  if (schedule.kind === 'interval') {
    const k = Math.max(1, Math.floor((after.getTime() - anchor.getTime()) / schedule.intervalMs) + 1);
    return new Date(anchor.getTime() + k * schedule.intervalMs);
  }
  const [y, m, d] = formatInTimeZone(after, tz, 'yyyy-MM-dd').split('-').map(Number);
  // 8 local days always contains every weekday at least once.
  for (let offset = 0; offset <= 8; offset++) {
    const day = new Date(Date.UTC(y, m - 1, d + offset));
    if (!schedule.days.includes(day.getUTCDay())) continue;
    const ymd = `${day.getUTCFullYear()}-${pad2(day.getUTCMonth() + 1)}-${pad2(day.getUTCDate())}`;
    const candidate = fromZonedTime(`${ymd}T${schedule.time}:00`, tz);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error(`No fire time found for "${schedule.text}"`);
}

// ---- storage ---------------------------------------------------------------------------

interface RecurringReminderRow {
  id: number;
  user_id: string;
  message: string;
  schedule_text: string;
  kind: 'interval' | 'calendar';
  interval_ms: number | null;
  days: string;
  time_of_day: string | null;
  timezone: string;
  anchor_at: string;
  next_fire_at: string;
  last_fired_at: string | null;
  created_at: string;
  active: number;
}

let ensuredFor: unknown = null;

/** Lazy CREATE IF NOT EXISTS, same idiom as pending-actions.ts; re-run per DB connection. */
export function ensureRecurringRemindersTable(): void {
  const raw = getRawDb();
  if (ensuredFor === raw) return;
  const db = getSyncDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS recurring_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      message TEXT NOT NULL,
      schedule_text TEXT NOT NULL,
      kind TEXT NOT NULL,
      interval_ms INTEGER,
      days TEXT NOT NULL DEFAULT '',
      time_of_day TEXT,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      anchor_at TEXT NOT NULL,
      next_fire_at TEXT NOT NULL,
      last_fired_at TEXT,
      created_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_recurring_reminders_due ON recurring_reminders(active, next_fire_at)`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_recurring_reminders_user ON recurring_reminders(user_id)`);
  ensuredFor = raw;
}

function rowToSchedule(row: RecurringReminderRow): ParsedSchedule {
  if (row.kind === 'interval') {
    const s: ParsedSchedule = { kind: 'interval', intervalMs: Number(row.interval_ms), text: '' };
    s.text = describeSchedule(s);
    return s;
  }
  const days = row.days.split(',').filter(Boolean).map(Number);
  const s: ParsedSchedule = { kind: 'calendar', days, time: row.time_of_day || '09:00', text: '' };
  s.text = describeSchedule(s);
  return s;
}

type CreateResult =
  | { ok: true; row: RecurringReminderRow }
  | { ok: false; error: string };

export function createRecurringReminder(args: {
  userId: string;
  message: string;
  every: string;
  timezone: string;
  now?: Date;
}): CreateResult {
  ensureRecurringRemindersTable();
  const message = args.message.trim();
  if (!message) return { ok: false, error: 'Reminder message is required.' };
  if (message.length > MAX_MESSAGE_CHARS) {
    return { ok: false, error: `Keep the message under ${MAX_MESSAGE_CHARS} characters (it is ${message.length}).` };
  }
  const parsed = parseSchedule(args.every);
  if (!parsed.ok) return parsed;
  const schedule = parsed.schedule;
  const now = args.now ?? new Date();
  const db = getSyncDb();

  const active = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM recurring_reminders WHERE user_id = ? AND active = 1',
    [args.userId]
  );
  if ((active?.n ?? 0) >= MAX_ACTIVE_PER_USER) {
    return {
      ok: false,
      error: `You already have ${MAX_ACTIVE_PER_USER} repeating reminders (the limit). Cancel one first (scheduler list shows the ids).`,
    };
  }

  const next = nextFireAfter(schedule, now, now, args.timezone);
  let intervalMs: number | null = null;
  let days = '';
  let time: string | null = null;
  if (schedule.kind === 'interval') {
    intervalMs = schedule.intervalMs;
  } else {
    days = schedule.days.join(',');
    time = schedule.time;
  }
  const result = db.run(
    `INSERT INTO recurring_reminders
       (user_id, message, schedule_text, kind, interval_ms, days, time_of_day, timezone,
        anchor_at, next_fire_at, created_at, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      args.userId, message, schedule.text, schedule.kind, intervalMs, days, time,
      args.timezone, now.toISOString(), next.toISOString(), now.toISOString(),
    ]
  );
  const row = db.get<RecurringReminderRow>('SELECT * FROM recurring_reminders WHERE id = ?', [
    Number(result.lastInsertRowid),
  ]);
  if (!row) return { ok: false, error: 'The reminder could not be saved.' };
  return { ok: true, row };
}

/** Active reminders for one user, or for everyone when userId is null (owner view). */
export function listRecurringReminders(userId: string | null): RecurringReminderRow[] {
  ensureRecurringRemindersTable();
  const db = getSyncDb();
  if (userId === null) {
    return db.all<RecurringReminderRow>(
      'SELECT * FROM recurring_reminders WHERE active = 1 ORDER BY next_fire_at'
    );
  }
  return db.all<RecurringReminderRow>(
    'SELECT * FROM recurring_reminders WHERE active = 1 AND user_id = ? ORDER BY next_fire_at',
    [userId]
  );
}

export function getRecurringReminder(id: number): RecurringReminderRow | undefined {
  ensureRecurringRemindersTable();
  return getSyncDb().get<RecurringReminderRow>('SELECT * FROM recurring_reminders WHERE id = ?', [id]);
}

/** Deactivate (keeps the row for history). Authorization is the caller's job. */
export function cancelRecurringReminder(id: number): boolean {
  ensureRecurringRemindersTable();
  const res = getSyncDb().run('UPDATE recurring_reminders SET active = 0 WHERE id = ? AND active = 1', [id]);
  return res.changes === 1;
}

/**
 * occurrenceKey is stable for one scheduled occurrence (reminder id + its slot time): the
 * queue uses it as a job id so a retried enqueue can't deliver the same occurrence twice.
 */
type SendReminder = (userId: string, content: string, occurrenceKey: string) => Promise<void>;

/**
 * Fire every due reminder once. Returns how many messages were sent. See the file header for
 * the at-most-once and skip-ahead rules.
 */
export async function fireDueRecurringReminders(now: Date, send: SendReminder): Promise<number> {
  ensureRecurringRemindersTable();
  const db = getSyncDb();
  const due = db.all<RecurringReminderRow>(
    'SELECT * FROM recurring_reminders WHERE active = 1 AND next_fire_at <= ? ORDER BY next_fire_at',
    [now.toISOString()]
  );
  let sent = 0;
  for (const row of due) {
    const schedule = rowToSchedule(row);
    let next: Date;
    try {
      next = nextFireAfter(schedule, now, new Date(row.anchor_at), row.timezone);
    } catch (error) {
      logger.error(`Recurring reminder ${row.id} has an unusable schedule, deactivating:`, error);
      db.run('UPDATE recurring_reminders SET active = 0 WHERE id = ?', [row.id]);
      continue;
    }
    // Claim the slot: only the tick that still sees the old next_fire_at wins.
    const claimed = db.run(
      `UPDATE recurring_reminders SET next_fire_at = ?, last_fired_at = ?
       WHERE id = ? AND active = 1 AND next_fire_at = ?`,
      [next.toISOString(), now.toISOString(), row.id, row.next_fire_at]
    );
    if (claimed.changes !== 1) continue;
    try {
      // BullMQ job ids can't contain ':'; the ISO slot time is made safe.
      const occurrenceKey = `recurring-${row.id}-${row.next_fire_at.replace(/[^0-9A-Za-z]/g, '')}`;
      await send(row.user_id, `⏰ Reminder: ${row.message}`, occurrenceKey);
      sent++;
    } catch (error) {
      logger.error(`Recurring reminder ${row.id} could not be queued, will retry next tick:`, error);
      db.run(
        'UPDATE recurring_reminders SET next_fire_at = ? WHERE id = ? AND next_fire_at = ?',
        [row.next_fire_at, row.id, next.toISOString()]
      );
    }
  }
  return sent;
}
