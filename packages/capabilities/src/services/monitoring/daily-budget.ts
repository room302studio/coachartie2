import {
  logger,
  getSyncDb,
  easternDayKey,
  easternDayBounds,
  toSqliteUtc,
  readKillSwitch,
  writeBudgetMute,
  clearKillSwitch,
  readBudgetOverrideDay,
  getKillSwitchPath,
  reportToAnomalywatch,
  type KillSwitchState,
} from '@coachartie/shared';

/**
 * DAILY SPEND CAP → AUTO-MUTE.
 *
 * Once today's recorded spend (model_usage_stats.estimated_cost, America/New_York day) reaches
 * DAILY_BUDGET_USD, Artie is muted through the shared kill switch with a budget marker, and one
 * warning goes to anomalywatch. At the next ET midnight the mute lifts itself — but only if it
 * is still the budget mute: a manual mute is never overridden, and a manual mute written over a
 * budget mute becomes manual. A manual unmute during a budget mute records a same-day override
 * so the cap doesn't immediately re-trip on the next call.
 *
 * Checked after every recorded generation and on a 60s interval (the interval is what lifts
 * the mute at midnight, and what catches spend written directly by the discord process).
 */

export const DEFAULT_DAILY_BUDGET_USD = 3;
export const BUDGET_ALERT_KIND = 'daily-budget-mute';

/** DAILY_BUDGET_USD, default 3. 0, a negative number or "off" disables the cap. */
export function getDailyBudgetUsd(): number | null {
  const raw = (process.env.DAILY_BUDGET_USD ?? '').trim().toLowerCase();
  if (raw === 'off') return null;
  if (raw === '') return DEFAULT_DAILY_BUDGET_USD;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_DAILY_BUDGET_USD;
  return parsed > 0 ? parsed : null;
}

/**
 * Today's spend (ET day) from model_usage_stats. One indexed range SUM (idx_usage_timestamp).
 * Throws on DB failure — callers decide what failure means for them.
 */
export function getTodaySpendUsd(now: Date = new Date()): number {
  const { start, end } = easternDayBounds(now);
  const row = getSyncDb().get<{ spent: number | null }>(
    `SELECT COALESCE(SUM(estimated_cost), 0) AS spent
       FROM model_usage_stats
      WHERE timestamp >= ? AND timestamp < ?`,
    [toSqliteUtc(start), toSqliteUtc(end)]
  );
  return row?.spent ?? 0;
}

export type BudgetAction = 'none' | 'mute' | 'unmute';

/** Pure decision, so precedence is testable without files or a DB. */
export function decideBudgetAction(input: {
  state: KillSwitchState;
  spentUsd: number;
  budgetUsd: number | null;
  today: string;
  overrideDay: string | null;
}): BudgetAction {
  const { state, spentUsd, budgetUsd, today, overrideDay } = input;
  if (state.muted) {
    // Manual mutes belong to a human. Never lift them, never relabel them.
    if (state.kind === 'manual') return 'none';
    // Budget mute from an earlier ET day: midnight has passed, lift it.
    return state.day !== today ? 'unmute' : 'none';
  }
  if (budgetUsd === null) return 'none';
  if (overrideDay === today) return 'none';
  return spentUsd >= budgetUsd ? 'mute' : 'none';
}

export interface BudgetCheckResult {
  action: BudgetAction | 'error';
  spentUsd: number | null;
  budgetUsd: number | null;
}

export interface BudgetCheckOptions {
  now?: Date;
  killSwitchPath?: string;
  /** Test seam; defaults to reportToAnomalywatch. */
  report?: typeof reportToAnomalywatch;
  /** Test seam; defaults to getTodaySpendUsd. */
  spend?: (now: Date) => number;
}

export async function checkDailyBudget(options: BudgetCheckOptions = {}): Promise<BudgetCheckResult> {
  const now = options.now ?? new Date();
  const path = options.killSwitchPath ?? getKillSwitchPath();
  const report = options.report ?? reportToAnomalywatch;
  const today = easternDayKey(now);
  const budgetUsd = getDailyBudgetUsd();

  let state = readKillSwitch(path);

  // Lift yesterday's budget mute first — needs no spend lookup.
  if (state.muted && state.kind === 'budget' && state.day !== today) {
    clearKillSwitch(path);
    logger.warn(`💸 Daily budget: new ET day (${today}) — budget mute from ${state.day} lifted`);
    state = { muted: false };
  }

  if (state.muted || budgetUsd === null) {
    return { action: 'none', spentUsd: null, budgetUsd };
  }

  let spentUsd: number;
  try {
    spentUsd = (options.spend ?? getTodaySpendUsd)(now);
  } catch (error) {
    logger.error('💸 Daily budget: spend lookup failed — cap not evaluated this pass', error);
    return { action: 'error', spentUsd: null, budgetUsd };
  }

  const action = decideBudgetAction({
    state,
    spentUsd,
    budgetUsd,
    today,
    overrideDay: readBudgetOverrideDay(path),
  });

  if (action === 'mute') {
    // Re-read right before writing: if a human muted in the meantime, theirs wins.
    if (readKillSwitch(path).muted) return { action: 'none', spentUsd, budgetUsd };
    writeBudgetMute(
      { day: today, spentUsd: Number(spentUsd.toFixed(4)), budgetUsd, at: now.toISOString() },
      path
    );
    logger.error(
      `🛑💸 DAILY BUDGET HIT: $${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} spent today (ET) — ` +
        `Artie muted until ET midnight`
    );
    await report(
      'warning',
      `Daily budget hit: $${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} spent today (ET). ` +
        `Artie is auto-muted until ET midnight. Unmute early: POST /api/killswitch {"enabled":false}`,
      { kind: BUDGET_ALERT_KIND, now }
    );
  }

  return { action, spentUsd, budgetUsd };
}

// ---------------------------------------------------------------------------------------
// Triggers: after each recorded generation (coalesced), and a 60s interval.
// ---------------------------------------------------------------------------------------

let inFlight: Promise<BudgetCheckResult> | null = null;

/** Fire-and-forget check; concurrent callers share one pass. Never throws. */
export function scheduleDailyBudgetCheck(): void {
  if (inFlight) return;
  inFlight = checkDailyBudget()
    .catch((error) => {
      logger.error('💸 Daily budget check failed:', error);
      return { action: 'error' as const, spentUsd: null, budgetUsd: null };
    })
    .finally(() => {
      inFlight = null;
    });
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startDailyBudgetWatch(intervalMs = 60_000): void {
  if (timer) return;
  const budget = getDailyBudgetUsd();
  logger.warn(
    budget === null
      ? '💸 Daily budget cap DISABLED (DAILY_BUDGET_USD off/0)'
      : `💸 Daily budget cap: $${budget.toFixed(2)}/day (America/New_York), auto-mute via kill switch`
  );
  scheduleDailyBudgetCheck();
  timer = setInterval(scheduleDailyBudgetCheck, intervalMs);
  timer.unref?.();
}

export function stopDailyBudgetWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
