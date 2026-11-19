import { logger } from '../../shared/logger.js';
import { CreditMonitor } from './openrouter-balance.js';
import { costMonitor } from './usage-ledger.js';
import { getDailyBudgetUsd, getTodaySpendUsd, getTrailingBurnPerHour } from './daily-cap.js';

// =====================================================
// BROWNOUT CONTROLLER
// Ashby ultrastability: degrade, don't die. Before this,
// Artie had two states — full Opus personality, or total
// silence when credits ran out (which users read as an
// outage). This adds the rungs in between: as credit
// runway shrinks we step down to cheaper models and
// shorter replies instead of going dark. Visibility is
// LOGS ONLY — the vitals monitor owns operator comms.
//
// Two signals, and the MORE conservative one wins:
//  - runway: credit balance ÷ measured burn (below)
//  - daily:  today's ET-day spend as a fraction of
//            DAILY_BUDGET_USD, so Artie tapers through
//            the day instead of running full-Opus into the
//            hard budget mute (daily-budget.ts) at 100%.
// =====================================================

export type BrownoutMode = 'normal' | 'lean' | 'critical';

export interface BrownoutStatus {
  mode: BrownoutMode;
  runwayHours: number | null;
  /** Mode from credit runway alone. */
  runwayMode?: BrownoutMode;
  /** Mode from today's spend vs DAILY_BUDGET_USD alone. */
  dailyMode?: BrownoutMode;
  /** Today's spend ÷ daily budget; null when unknown or the cap is off. */
  dailySpendFraction?: number | null;
}

const MODE_RANK: Record<BrownoutMode, number> = { normal: 0, lean: 1, critical: 2 };

export function moreConservative(a: BrownoutMode, b: BrownoutMode): BrownoutMode {
  if (MODE_RANK[a] >= MODE_RANK[b]) {
    return a;
  }
  return b;
}

function envFraction(name: string, fallback: number): number {
  const parsed = parseFloat(process.env[name] || '');
  if (Number.isFinite(parsed) && parsed > 0 && parsed <= 1) {
    return parsed;
  }
  return fallback;
}

/**
 * Daily-budget rung. At 100% the hard budget mute takes over (nothing generates), so this
 * never needs a rung above critical.
 */
export function dailyBudgetMode(fraction: number | null): BrownoutMode {
  if (fraction === null || !Number.isFinite(fraction)) return 'normal';
  if (fraction >= envFraction('BROWNOUT_DAILY_CRITICAL_FRACTION', 0.85)) return 'critical';
  if (fraction >= envFraction('BROWNOUT_DAILY_LEAN_FRACTION', 0.6)) return 'lean';
  return 'normal';
}

export function runwayMode(runwayHours: number | null): BrownoutMode {
  if (runwayHours === null) return 'normal';
  if (runwayHours < envNumber('BROWNOUT_CRITICAL_HOURS', 6)) return 'critical';
  if (runwayHours < envNumber('BROWNOUT_LEAN_HOURS', 24)) return 'lean';
  return 'normal';
}

/**
 * Today's spend as a fraction of the daily budget, or null (cap off, or lookup failed).
 * Null means "no opinion" — it fails toward normal, and the runway signal still applies.
 */
export function readDailySpendFraction(
  spend: () => number = getTodaySpendUsd,
  budget: number | null = getDailyBudgetUsd()
): number | null {
  if (budget === null) return null;
  try {
    return spend() / budget;
  } catch (error) {
    logger.warn('🕯️ Brownout: daily spend lookup failed — using runway signal only', error);
    return null;
  }
}

/** Combine both signals. Pure, so the precedence is testable. */
export function deriveBrownoutStatus(
  runwayHours: number | null,
  dailySpendFraction: number | null
): BrownoutStatus {
  const rMode = runwayMode(runwayHours);
  const dMode = dailyBudgetMode(dailySpendFraction);
  return {
    mode: moreConservative(rMode, dMode),
    runwayHours,
    runwayMode: rMode,
    dailyMode: dMode,
    dailySpendFraction,
  };
}

/** Which signal put us in this mode — for the one transition log line. */
export function brownoutDriver(status: BrownoutStatus): string {
  if (status.mode === 'normal') return 'none';
  const r = status.runwayMode === status.mode;
  const d = status.dailyMode === status.mode;
  if (r && d) {
    return 'runway+daily';
  }
  if (d) {
    return 'daily';
  }
  return 'runway';
}

// Balance lookups can hit OpenRouter's /credits endpoint — cache so we
// pay that cost at most once per 5 minutes, not once per message.
const CACHE_TTL_MS = 5 * 60 * 1000;
let cached: { status: BrownoutStatus; fetchedAt: number } | null = null;

// Track the last observed mode so the FIRST transition into a degraded
// mode gets one loud logger.error (visible in prod where console level
// is warn) instead of a per-message drumbeat.
let lastMode: BrownoutMode = 'normal';

function envNumber(name: string, fallback: number): number {
  const parsed = parseFloat(process.env[name] || '');
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

// Stale-while-revalidate: the balance lookup can be a live OpenRouter fetch with
// no timeout, and this sits on the per-message hot path — so a cache miss returns
// the last known status immediately and refreshes in the background. Concurrent
// messages during a refresh share the one in-flight fetch instead of stampeding.
let refreshing = false;

export async function getBrownoutMode(): Promise<BrownoutStatus> {
  const now = Date.now();
  if ((!cached || now - cached.fetchedAt >= CACHE_TTL_MS) && !refreshing) {
    refreshing = true;
    void refresh(now).finally(() => {
      refreshing = false;
    });
  }
  if (!cached) return { mode: 'normal', runwayHours: null };
  // Only the balance (runway) is cached. Today's spend is one indexed SUM, so it's read fresh
  // every time; caching it let spend cross 60% and 85% inside one 5-minute window with no
  // taper before the hard mute (Codex crew 2026-11-18).
  const status = deriveBrownoutStatus(cached.status.runwayHours, readDailySpendFraction());
  noteModeChange(status);
  return status;
}

/** One loud line on each mode change, not one per message. */
function noteModeChange(status: BrownoutStatus): void {
  const mode = status.mode;
  if (mode === lastMode) return;
  let pct: string;
  if (typeof status.dailySpendFraction === 'number') {
    pct = `${Math.round(status.dailySpendFraction * 100)}% of daily budget`;
  } else {
    pct = 'daily budget n/a';
  }
  let runway: string;
  if (status.runwayHours === null) {
    runway = 'runway ?';
  } else {
    runway = `~${status.runwayHours.toFixed(1)}h runway`;
  }
  if (mode !== 'normal') {
    logger.error(
      `🚨🕯️ BROWNOUT ENGAGED: ${lastMode} → ${mode.toUpperCase()} ` +
        `(driven by ${brownoutDriver(status)}: ${runway}, ${pct})`
    );
  } else {
    logger.warn(`🕯️ Brownout cleared: ${lastMode} → normal (${runway}, ${pct})`);
  }
  lastMode = mode;
}

// Runway = balance ÷ burn rate, and the burn must be what Artie ACTUALLY spends. History:
// a hardcoded $1.5/hr pinned him in CRITICAL for months; then the in-process rolling window
// was right except after a restart, when its empty window fell back to a guessed $0.75/hr
// (≈30× real) and every deploy meant 15 minutes of LEAN (2026-11-17: both LEANs that day
// landed on restart minutes, and one cut a reply mid-bullet).
//
// Now: the durable ledger's trailing-24h burn is the baseline (survives restarts), and the
// in-process last-hour burn can only raise it, so a live spike still tightens the loop
// quickly. The guessed constant is used only when the ledger can't be read at all.
export function burnPerHour(): number {
  const floor = envNumber('BROWNOUT_BURN_FLOOR', 0.15); // never divide by ~0 → false infinite runway
  let burn: number;
  try {
    burn = getTrailingBurnPerHour();
  } catch (error) {
    logger.warn('🕯️ Brownout: ledger burn unreadable, using BROWNOUT_BURN_PER_HOUR', error);
    burn = envNumber('BROWNOUT_BURN_PER_HOUR', 0.75);
  }
  try {
    const stats = costMonitor.getStats();
    // The rolling window, never costPerHour (a cumulative since-boot average that read ~40×
    // high in July). Needs 15 min of uptime to mean anything.
    const recent = stats.recentBurnPerHour;
    if (stats.uptime >= 15 * 60_000 && typeof recent === 'number' && recent > burn) {
      burn = recent;
    }
  } catch {
    // cost monitor unavailable: the ledger baseline stands
  }
  return Math.max(floor, burn);
}

async function refresh(now: number): Promise<void> {
  let runwayHours: number | null = null;
  try {
    const balance = await CreditMonitor.getInstance().getCurrentBalance();
    const credits = balance?.credits_remaining;
    if (typeof credits === 'number' && Number.isFinite(credits)) {
      runwayHours = credits / burnPerHour();
    }
  } catch (error) {
    logger.error('🕯️ Brownout: balance check failed, staying in normal mode', error);
  }

  // Unknown balance → runway says normal. Fail toward full service: the credit monitor
  // already guards true exhaustion, and the daily budget has its own hard mute.
  const status = deriveBrownoutStatus(runwayHours, readDailySpendFraction());
  noteModeChange(status);
  cached = { status, fetchedAt: now };
}

// =====================================================
// BROWNOUT BREVITY
// The taper is in the PROMPT, not max_tokens. A token cap
// never saves money (every generated token is billed, and
// a capped reply is wasted whole); it only cut replies off
// (2026-11-17). So brownout's levers are this note plus
// reasoning off (generate-reply.ts). Length and word choice
// only: voice, persona and [SILENT] are untouched.
// =====================================================

const BREVITY_NOTES: Record<Exclude<BrownoutMode, 'normal'>, string> = {
  lean:
    'Length note: keep this reply short, under 80 words, plain small words. ' +
    'Your voice and everything else (including choosing [SILENT]) is unchanged.',
  critical:
    'Length note: keep this reply short, under 30 words, one or two sentences. ' +
    'Your voice and everything else (including choosing [SILENT]) is unchanged.',
};

export function brevityNoteFor(mode: BrownoutMode): string | null {
  if (mode === 'normal') {
    return null;
  }
  return BREVITY_NOTES[mode];
}

export interface BrownoutRoute {
  model: string;
  /** OpenRouter plugins for the request (unused by brownout since 2026-11-17). */
  plugins?: unknown[];
}

/**
 * Which model answers. EJ (2026-09-29): Artie's voice IS the persona model; swapping "loses
 * his creativity and flavor". EJ (2026-11-17): swap ONLY at runway-critical (the real balance
 * nearly gone), so he keeps answering instead of going silent. Daily-budget pressure never
 * swaps; the $3/day mute ends the day instead.
 *
 * The critical model must be a concrete, tool-capable model (BROWNOUT_CRITICAL_MODEL, default
 * Sonnet): the native tool loop can't use openrouter/auto. History: until 11-17 this sent the
 * final third of either tank to openrouter/auto, which the tool loop silently pinned to the
 * first tool-capable OPENROUTER_MODELS entry (Haiku in prod), so lean meant Haiku and nobody
 * had chosen that.
 */
export function brownoutRoute(status: BrownoutStatus, persona: string): BrownoutRoute {
  if (status.runwayMode === 'critical') {
    return { model: process.env.BROWNOUT_CRITICAL_MODEL || 'anthropic/claude-sonnet-5' };
  }
  return { model: persona };
}

/**
 * Insert the brevity note as its own system message immediately AFTER the first system
 * message — i.e. after the prompt-cache breakpoint (prompt-cache.ts marks messages[first
 * system] and nothing else). The cached prefix stays byte-identical across normal/lean/
 * critical, so a brownout never costs a cache miss. Placing it here (not at the tail) also
 * respects the Anthropic role-ordering rule: no system message may follow an assistant turn,
 * and this position always precedes any history. Normal mode returns the input unchanged.
 */
export function applyBrevityNote<T extends { role: 'system' | 'user' | 'assistant'; content: string }>(
  messages: T[],
  mode: BrownoutMode
): T[] {
  const note = brevityNoteFor(mode);
  if (!note) return messages;
  const first = messages.findIndex((m) => m.role === 'system');
  let at: number;
  if (first === -1) {
    at = 0;
  } else {
    at = first + 1;
  }
  const noteMessage = { role: 'system', content: note } as T;
  return [...messages.slice(0, at), noteMessage, ...messages.slice(at)];
}
