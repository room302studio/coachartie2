/**
 * Async control-flow helpers shared across Artie, plus the token estimator (was
 * shared/text.ts, folded in wave 6).
 *
 * Replaces inlined `new Promise((r) => setTimeout(r, ms))` sleeps (10+ copies)
 * and separate exponential-backoff retry loops (the robust capability
 * executor, the Discord capabilities-client).
 */

/** Resolve after `ms` milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `promise`, or a rejection (`timeout of <ms>ms exceeded`) once `ms` passes first. The
 * in-process stand-in for the request timeouts the gateway's old loopback HTTP calls had
 * (wave 9); the underlying work is not cancelled, exactly as an aborted fetch didn't stop
 * the server-side handler.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout of ${ms}ms exceeded`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Rough token estimate using the ~4-characters-per-token heuristic.
 *
 * This is the single canonical estimator — previously this exact
 * `Math.ceil(text.length / 4)` was inlined in 35+ places across the codebase.
 * Keep the formula identical so context-budget math stays unchanged.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
