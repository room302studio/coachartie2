/**
 * Spend that was billed but couldn't be written to model_usage_stats yet (Codex crew
 * 2026-11-18: a failed INSERT used to drop the cost for good, so the daily cap summed an
 * incomplete ledger and could let him spend past $3). The rows wait here for a retry, and
 * their cost still counts toward today's spend in the meantime.
 *
 * In-process only: a restart loses whatever is still waiting, the same as before.
 */

const MAX_WAITING = 500;

const waiting: Array<{ row: unknown; costUsd: number }> = [];

export function holdUnrecorded<T>(row: T, costUsd: number): void {
  if (waiting.length >= MAX_WAITING) waiting.shift();
  waiting.push({ row, costUsd: Number.isFinite(costUsd) ? costUsd : 0 });
}

/** Take every waiting row out, to retry. Anything that fails again goes back via holdUnrecorded. */
export function takeUnrecorded<T>(): Array<{ row: T; costUsd: number }> {
  return waiting.splice(0, waiting.length) as Array<{ row: T; costUsd: number }>;
}

/** Cost of the rows still waiting, added to today's spend so the cap stays honest. */
export function unrecordedSpendUsd(): number {
  return waiting.reduce((sum, w) => sum + w.costUsd, 0);
}
