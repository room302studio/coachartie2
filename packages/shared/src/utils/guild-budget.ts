import { getSyncDb } from '../db/client.js';
import { easternDayBounds, toSqliteUtc } from './eastern-day.js';
import { GenerationMutedError } from './kill-switch.js';
import { reportToAnomalywatch } from './anomalywatch.js';

// =====================================================
// PER-GUILD BUDGET SHARES
// A guild may spend at most a fixed share of the daily budget (ET day). Past it, Artie is
// silent in THAT guild only — other guilds and DMs keep working — and one note goes to
// anomalywatch. Why: from Feb to Sep 2026 the Subway Builder server drove ~66% of all spend,
// with surge days of 1,100+ generations (2026-06-30, 2026-07-02). EJ, 2026-09-29: "a hard 50%
// of whatever the budget is". Spend is attributed via model_usage_stats.guild_id; background
// work with no guild context counts toward the overall cap only.
// =====================================================

export const SUBWAY_BUILDER_GUILD_ID = '1420846272545296470';
/** GUILD_BUDGET_SHARES format: "<guildId>:<fraction>,<guildId>:<fraction>". "off" disables. */
export const DEFAULT_GUILD_BUDGET_SHARES = `${SUBWAY_BUILDER_GUILD_ID}:0.5`;
export const DEFAULT_DAILY_BUDGET_USD = 3;

/** DAILY_BUDGET_USD, default 3. 0, a negative number or "off" disables the cap. */
export function readDailyBudgetUsd(): number | null {
  const raw = (process.env.DAILY_BUDGET_USD ?? '').trim().toLowerCase();
  if (raw === 'off') return null;
  if (raw === '') return DEFAULT_DAILY_BUDGET_USD;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_DAILY_BUDGET_USD;
  return parsed > 0 ? parsed : null;
}

export function parseGuildBudgetShares(raw: string | undefined): Map<string, number> {
  const shares = new Map<string, number>();
  const value = (raw ?? DEFAULT_GUILD_BUDGET_SHARES).trim();
  if (value.toLowerCase() === 'off') return shares;
  for (const entry of value.split(',')) {
    const [guildId, fraction] = entry.split(':').map((part) => part.trim());
    const share = parseFloat(fraction);
    if (guildId && Number.isFinite(share) && share > 0 && share <= 1) shares.set(guildId, share);
  }
  return shares;
}

/** This guild's share of the daily budget (0–1), or null if it has no cap. */
export function guildBudgetShare(guildId?: string | null): number | null {
  if (!guildId) return null;
  return parseGuildBudgetShares(process.env.GUILD_BUDGET_SHARES).get(guildId) ?? null;
}

/** Today's (ET day) recorded spend attributed to this guild. Throws on DB failure. */
export function getGuildSpendTodayUsd(guildId: string, now: Date = new Date()): number {
  const { start, end } = easternDayBounds(now);
  const row = getSyncDb().get<{ spent: number | null }>(
    `SELECT COALESCE(SUM(estimated_cost), 0) AS spent
       FROM model_usage_stats
      WHERE guild_id = ? AND timestamp >= ? AND timestamp < ?`,
    [guildId, toSqliteUtc(start), toSqliteUtc(end)]
  );
  return row?.spent ?? 0;
}

export interface GuildBudgetStatus {
  guildId: string;
  capUsd: number;
  spentUsd: number;
  over: boolean;
}

/**
 * The guild's standing against its share today, or null when it has no cap, the daily budget
 * is off, or the spend lookup fails (fail open: the overall daily cap still bounds spend).
 */
export function checkGuildBudget(
  guildId?: string | null,
  now: Date = new Date(),
  spendLookup: (id: string, at: Date) => number = getGuildSpendTodayUsd
): GuildBudgetStatus | null {
  const share = guildBudgetShare(guildId);
  const budget = readDailyBudgetUsd();
  if (!guildId || share === null || budget === null) return null;
  try {
    const capUsd = share * budget;
    const spentUsd = spendLookup(guildId, now);
    return { guildId, capUsd, spentUsd, over: spentUsd >= capUsd };
  } catch {
    return null;
  }
}

export class GuildBudgetExceededError extends GenerationMutedError {
  constructor(where: string, status: GuildBudgetStatus) {
    super(where);
    this.name = 'GuildBudgetExceededError';
    this.message =
      `🔇 GUILD BUDGET SPENT — guild ${status.guildId} used $${status.spentUsd.toFixed(2)} ` +
      `of its $${status.capUsd.toFixed(2)} share today; ${where} skipped`;
  }
}

/** One quiet anomalywatch note per guild per ET day when its share runs out. */
export function reportGuildBudgetSpent(status: GuildBudgetStatus): void {
  void reportToAnomalywatch(
    'warning',
    `Coach Artie went quiet in guild ${status.guildId} for the rest of the day: its budget share ` +
      `($${status.capUsd.toFixed(2)}) is spent ($${status.spentUsd.toFixed(2)}). Other guilds and DMs unaffected.`,
    { kind: `guild-budget:${status.guildId}` }
  );
}

/**
 * Throw before a paid model call when this guild's share is spent. GuildBudgetExceededError
 * extends GenerationMutedError, so every caller that already treats "muted" as silent does
 * the same here.
 */
export function assertGuildBudget(guildId: string | null | undefined, where: string): void {
  const status = checkGuildBudget(guildId);
  if (status?.over) {
    reportGuildBudgetSpent(status);
    throw new GuildBudgetExceededError(where, status);
  }
}
