import type { BrownoutStatus } from './brownout.js';

// =====================================================
// SELF-METER
// Artie asked for this (2026-10-26 check-in): "I can't feel the meter until it's nearly
// empty" and "silent fallbacks are the worst bugs because I only find out later." So the
// spend, brownout mode and recent fallbacks he already lives under get one line in his
// per-message situational context. It's private pacing info: in Sept he nagged EJ about
// credits and got switched off, hence the "don't bring it up" clause.
// =====================================================

export type LlmHiccup = 'fallback' | 'failed' | 'reasoning-retry';

function pluralSuffix(count: number, singular: string = ''): string {
  if (count === 1) {
    return singular;
  }
  if (singular === 'y') {
    return 'ies';
  }
  return singular + 's';
}

function formatHiccupSummary(hiccupMessages: string[]): string {
  if (hiccupMessages.length) {
    return `last 6h: ${hiccupMessages.join(', ')}`;
  }
  return 'last 6h: no fallbacks';
}

const WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_EVENTS = 200;
const events: Array<{ at: number; kind: LlmHiccup }> = [];

/** Called from the OpenRouter ladder whenever a call didn't go the way it was asked. */
export function recordLlmHiccup(kind: LlmHiccup, now: number = Date.now()): void {
  events.push({ at: now, kind });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

export function recentHiccups(now: number = Date.now()): Record<LlmHiccup, number> {
  const counts: Record<LlmHiccup, number> = { fallback: 0, failed: 0, 'reasoning-retry': 0 };
  for (const e of events) if (now - e.at <= WINDOW_MS) counts[e.kind]++;
  return counts;
}

/** Test hook. */
export function resetHiccups(): void {
  events.length = 0;
}

const SOFT_FRACTION = 0.4;

/** The one meter line. Pure. */
export function selfMeterLine(
  status: BrownoutStatus,
  budgetUsd: number | null,
  hiccups: Record<LlmHiccup, number>
): string {
  const bits: string[] = [];
  const fraction = status.dailySpendFraction;
  if (budgetUsd !== null && typeof fraction === 'number' && Number.isFinite(fraction)) {
    bits.push(
      `$${(fraction * budgetUsd).toFixed(2)} of $${budgetUsd.toFixed(2)} today (${Math.round(fraction * 100)}%)`
    );
  }
  bits.push(`mode ${status.mode}`);
  if (status.runwayHours !== null) bits.push(`credit runway ~${Math.round(status.runwayHours)}h`);

  const h = [
    hiccups.fallback && `${hiccups.fallback} model fallback${pluralSuffix(hiccups.fallback)}`,
    hiccups.failed && `${hiccups.failed} failed generation${pluralSuffix(hiccups.failed)}`,
    hiccups['reasoning-retry'] && `${hiccups['reasoning-retry']} reasoning retr${pluralSuffix(hiccups['reasoning-retry'], 'y')}`,
  ].filter(Boolean);
  bits.push(formatHiccupSummary(h));

  let advice: string;
  if (status.mode !== 'normal') {
    advice = `you're in ${status.mode} mode, so replies are length-capped`;
  } else if (typeof fraction === 'number' && fraction >= SOFT_FRACTION) {
    advice = `past ${Math.round(SOFT_FRACTION * 100)}% of today, so keep replies short unless it matters`;
  } else {
    advice = 'plenty of room';
  }

  return (
    `🔋 Your meter (private, for pacing yourself; don't bring up budget or credits in chat ` +
    `unless EJ asks): ${bits.join(' · ')}. ${advice[0].toUpperCase()}${advice.slice(1)}.`
  );
}
