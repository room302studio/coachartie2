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

export interface RetryOptions {
  /** Max retry attempts after the first try (default 3). */
  maxRetries?: number;
  /** Base delay for the first backoff step, in ms (default 1000). */
  initialDelayMs?: number;
  /** Cap on any single backoff delay, in ms (default 30_000). */
  maxDelayMs?: number;
  /** Add 0.5x–1.5x random jitter to each delay (default false). */
  jitter?: boolean;
  /** Return false to stop retrying and rethrow immediately (e.g. only retry 429s). */
  shouldRetry?: (error: unknown) => boolean;
  /** Called before each backoff wait — handy for logging. */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

/**
 * Run `fn`, retrying on failure with exponential backoff.
 * Unifies the previously-divergent retry loops; pass `shouldRetry` /
 * `jitter` / `onRetry` to recover each call site's original behavior.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxRetries = 3,
    initialDelayMs = 1000,
    maxDelayMs = 30_000,
    jitter = false,
    shouldRetry,
    onRetry,
  } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries || (shouldRetry && !shouldRetry(error))) {
        throw error;
      }
      let ms = Math.min(initialDelayMs * Math.pow(2, attempt), maxDelayMs);
      if (jitter) {
        ms = Math.round(ms * (0.5 + Math.random()));
      }
      onRetry?.(attempt + 1, ms, error);
      await delay(ms);
    }
  }
  throw lastError;
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
