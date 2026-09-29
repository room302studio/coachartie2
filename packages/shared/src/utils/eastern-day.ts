/**
 * America/New_York calendar-day helpers.
 *
 * The daily spend cap, the budget auto-unmute and the once-per-day alert limiter all reset at
 * EJ's midnight, not UTC's. model_usage_stats.timestamp is SQLite CURRENT_TIMESTAMP — UTC,
 * formatted 'YYYY-MM-DD HH:MM:SS' — so a day's window is computed here in UTC and compared
 * as strings (which sort chronologically in that format).
 *
 * DST is handled by asking Intl for the zone offset at the candidate instant rather than
 * hardcoding -4/-5: a spring-forward day is 23h long and a fall-back day is 25h. US DST
 * transitions happen at 02:00 local, so local midnight is never skipped or repeated.
 */

const ZONE = 'America/New_York';

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function zonedParts(date: Date): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of partsFormatter.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = parseInt(p.value, 10);
  }
  return out;
}

/** Offset of America/New_York from UTC at `date`, in ms (e.g. -4h during EDT). */
function zoneOffsetMs(date: Date): number {
  const p = zonedParts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** 'YYYY-MM-DD' of `date` on the America/New_York calendar. */
export function easternDayKey(date: Date = new Date()): string {
  const p = zonedParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** The UTC instant of local midnight at the start of the given ET calendar day. */
function easternMidnightUtc(year: number, month: number, day: number): Date {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  // First pass uses the offset at UTC midnight; second pass corrects if that guess landed on
  // the other side of a DST change.
  let t = guess - zoneOffsetMs(new Date(guess));
  t = guess - zoneOffsetMs(new Date(t));
  return new Date(t);
}

/** [start, end) of the ET calendar day containing `date`, as UTC instants. */
export function easternDayBounds(date: Date = new Date()): { start: Date; end: Date } {
  const p = zonedParts(date);
  const start = easternMidnightUtc(p.year, p.month, p.day);
  // Next calendar day via UTC date arithmetic (safe: no DST in UTC), then its local midnight.
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  const end = easternMidnightUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  return { start, end };
}

/** Format a Date the way SQLite CURRENT_TIMESTAMP does: 'YYYY-MM-DD HH:MM:SS' in UTC. */
export function toSqliteUtc(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}
