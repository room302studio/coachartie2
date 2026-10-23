/**
 * Subway Builder Steam launch — single source of truth for launch timing.
 * Used by the Sterling Artie persona (live T-minus line in his prompt) and the
 * #prison countdown scheduler. LLMs are unreliable at date math, so anything
 * Artie says about "how long until launch" must come from here, precomputed.
 */

// 1:00 PM ET, Friday July 17 2026 (EDT = UTC-4 in July)
export const STEAM_LAUNCH_AT = new Date('2026-07-17T13:00:00-04:00');

export const LAUNCH_GUILD_ID = '1420846272545296470'; // Subway Builder
export const LAUNCH_CHANNEL_ID = '1520088794551025684'; // #prison

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "2d 3h", "5h 12m", "42m" — coarse on purpose; hype doesn't need seconds. */
export function formatDelta(ms: number): string {
  const abs = Math.abs(ms);
  const days = Math.floor(abs / DAY);
  const hours = Math.floor((abs % DAY) / HOUR);
  const mins = Math.floor((abs % HOUR) / MINUTE);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * One-line launch status for prompt injection, e.g.
 * "T-MINUS 2d 3h until the Subway Builder Steam launch (Fri Jul 17, 1:00 PM ET)"
 * Returns null once launch hype is stale (>7 days after launch).
 */
export function launchStatusLine(now: Date = new Date()): string | null {
  const delta = STEAM_LAUNCH_AT.getTime() - now.getTime();
  const when = 'Fri Jul 17, 1:00 PM ET';
  if (delta > 0) {
    return `T-MINUS ${formatDelta(delta)} until the Subway Builder Steam launch (${when}). This number is precomputed and correct — use it, do not do your own date math.`;
  }
  if (-delta < 7 * DAY) {
    return `Subway Builder LAUNCHED on Steam ${formatDelta(delta)} ago (${when}). It is OUT. NOW.`;
  }
  return null;
}
