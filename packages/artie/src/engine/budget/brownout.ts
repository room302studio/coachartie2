import { logger } from '@coachartie/shared';
import { CreditMonitor } from '../monitoring/credit-monitor.js';
import { costMonitor } from '../monitoring/cost-monitor.js';
import { getDailyBudgetUsd, getTodaySpendUsd } from '../monitoring/daily-budget.js';

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
  return MODE_RANK[a] >= MODE_RANK[b] ? a : b;
}

function envFraction(name: string, fallback: number): number {
  const parsed = parseFloat(process.env[name] || '');
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
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
  return r && d ? 'runway+daily' : d ? 'daily' : 'runway';
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
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
  return cached?.status ?? { mode: 'normal', runwayHours: null };
}

// Runway = balance ÷ burn rate. The burn rate must reflect what Artie is ACTUALLY
// spending, not a fixed guess. For months this used a hardcoded $1.5/hr constant while
// the real burn was $0.3–0.6/hr, so a healthy balance looked like ~4h of runway and
// pinned Artie in CRITICAL (Haiku, 250 tokens) all day — the root cause of most
// "he's acting dumb" reports. We now read the measured burn from the cost monitor and
// only fall back to the constant when the sample is too fresh to trust (right after a
// restart). The fallback default is also lowered to a realistic 0.75/hr.
function currentBurnPerHour(): number {
  const floor = envNumber('BROWNOUT_BURN_FLOOR', 0.15); // never divide by ~0 → false infinite runway
  const fallback = envNumber('BROWNOUT_BURN_PER_HOUR', 0.75);
  try {
    const stats = costMonitor.getStats();
    const uptimeHours = stats.uptime / 3_600_000;
    // Use the ROLLING burn, not costPerHour. costPerHour is cost-since-boot over
    // hours-since-boot — a cumulative average that divides a post-restart burst by a tiny
    // uptime and reads enormous. Measured over July it ran a median $11.39/hr against a real
    // $0.26/hr, roughly 40x, which is exactly the kind of overstatement that pins Artie in
    // CRITICAL and produces the "he's acting dumb" reports this function was written to fix.
    const recent = stats.recentBurnPerHour;
    // Still need a stable sample: a fresh process hasn't spent enough to estimate.
    if (uptimeHours >= 0.25 && typeof recent === 'number' && recent > 0) {
      return Math.max(floor, recent);
    }
  } catch {
    // cost monitor unavailable → fallback below
  }
  return Math.max(floor, fallback);
}

async function refresh(now: number): Promise<void> {
  let runwayHours: number | null = null;
  try {
    const balance = await CreditMonitor.getInstance().getCurrentBalance();
    const credits = balance?.credits_remaining;
    if (typeof credits === 'number' && Number.isFinite(credits)) {
      runwayHours = credits / currentBurnPerHour();
    }
  } catch (error) {
    logger.error('🕯️ Brownout: balance check failed, staying in normal mode', error);
  }

  // Unknown balance → runway says normal. Fail toward full service: the credit monitor
  // already guards true exhaustion, and the daily budget has its own hard mute.
  const status = deriveBrownoutStatus(runwayHours, readDailySpendFraction());
  const mode = status.mode;

  if (mode !== lastMode) {
    const pct =
      typeof status.dailySpendFraction === 'number'
        ? `${Math.round(status.dailySpendFraction * 100)}% of daily budget`
        : 'daily budget n/a';
    const runway = runwayHours === null ? 'runway ?' : `~${runwayHours.toFixed(1)}h runway`;
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

  cached = { status, fetchedAt: now };
}

// =====================================================
// BROWNOUT BREVITY
// Under lean/critical the reply is token-capped. Without
// telling the model, it writes a normal-length answer and
// the cap truncates it mid-sentence. This note asks for a
// COMPLETE short reply that fits instead. Length and word
// choice only — voice, persona and [SILENT] are untouched.
// =====================================================

const BREVITY_NOTES: Record<Exclude<BrownoutMode, 'normal'>, string> = {
  lean:
    'Length note: keep this reply brief — a few short sentences, plain small words. ' +
    'Your voice and everything else (including choosing [SILENT]) is unchanged.',
  critical:
    'Length note: reply in one or two short sentences, simple words. ' +
    'Your voice and everything else (including choosing [SILENT]) is unchanged.',
};

export function brevityNoteFor(mode: BrownoutMode): string | null {
  return mode === 'normal' ? null : BREVITY_NOTES[mode];
}

/**
 * Which model answers under brownout. EJ's call (2026-09-29): Artie's voice IS the persona
 * model — swapping to a cheaper one "loses his creativity and flavor". So the taper is by
 * LENGTH only (max_tokens + brevity note) and the model never changes, with one exception:
 * when the OpenRouter balance itself is nearly gone (runway-driven critical), a cheap model
 * keeps him answering instead of failing. Daily-budget pressure never swaps models — the
 * budget mute handles the end of the day.
 */
export interface BrownoutRoute {
  model: string;
  /** OpenRouter plugins for the request (the auto-router's cost tier lives here). */
  plugins?: unknown[];
}

/**
 * The final third of either tank goes to OpenRouter's auto-router at a low cost tier
 * (EJ, 2026-09-29: "if we're in our final 33% of tokens, daily or total, revert to
 * openrouter auto-routing" — it tracks the cheapest capable models, so nobody has to keep a
 * hardcoded "cheap model" current). Daily: spend >= BROWNOUT_DAILY_AUTO_FRACTION (0.67) of
 * DAILY_BUDGET_USD. Total: the balance runway is lean or critical — Artie can't know what a
 * "full" OpenRouter tank was, so runway (balance ÷ measured burn, < BROWNOUT_LEAN_HOURS) is
 * the proxy. Before that, his persona model answers — length tapering still applies.
 * BROWNOUT_AUTO_COST_TIER (low) and BROWNOUT_AUTO_ALLOWED_MODELS (comma-separated wildcards,
 * e.g. "anthropic/*,google/*"; unset = auto-router's own pool) keep a quality floor.
 */
export function brownoutRoute(status: BrownoutStatus, persona: string): BrownoutRoute {
  const fraction = status.dailySpendFraction;
  const dailyLow =
    typeof fraction === 'number' && fraction >= envNumber('BROWNOUT_DAILY_AUTO_FRACTION', 0.67);
  const totalLow = status.runwayMode === 'lean' || status.runwayMode === 'critical';
  if (!dailyLow && !totalLow) return { model: persona };
  const allowed = (process.env.BROWNOUT_AUTO_ALLOWED_MODELS || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return {
    model: 'openrouter/auto',
    plugins: [
      {
        id: 'auto-router',
        cost_tier: process.env.BROWNOUT_AUTO_COST_TIER || 'low',
        ...(allowed.length ? { allowed_models: allowed } : {}),
      },
    ],
  };
}

/** max_tokens cap per mode (BROWNOUT_LEAN_MAX_TOKENS 500, BROWNOUT_CRITICAL_MAX_TOKENS 250). */
export function brownoutMaxTokens(mode: BrownoutMode, requested: number): number {
  if (mode === 'lean') return Math.min(requested, envNumber('BROWNOUT_LEAN_MAX_TOKENS', 500));
  if (mode === 'critical') return Math.min(requested, envNumber('BROWNOUT_CRITICAL_MAX_TOKENS', 250));
  return requested;
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
  const at = first === -1 ? 0 : first + 1;
  const noteMessage = { role: 'system', content: note } as T;
  return [...messages.slice(0, at), noteMessage, ...messages.slice(at)];
}
