/**
 * Async control-flow helpers shared across Artie.
 *
 * Replaces inlined `new Promise((r) => setTimeout(r, ms))` sleeps (10+ copies)
 * and three separate exponential-backoff retry loops (moltbook, the robust
 * capability executor, the Discord capabilities-client).
 */

/** Resolve after `ms` milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
