/**
 * Error helpers usable from engine, gateway and shared alike (shared/ imports nothing from
 * either side). Named so call sites read as a decision, not a ternary.
 */

/**
 * A tool call that was wrong as asked (bad scope, not allowed, no such id). Running it again
 * gives the same answer, so the retry wrapper stops at the first one instead of repeating it
 * three times (2026-11-18: a refused memory save was retried 3x, then sent to fallbacks).
 */
export class CallerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CallerError';
  }
}

/** The message of an Error, or the value stringified. */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** The stack of an Error, or undefined (for structured log fields). */
export function getErrorStackOrUndefined(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.stack;
  }
  return undefined;
}

/** The stack of an Error, or 'No stack trace'. */
export function getErrorStack(error: unknown): string {
  if (error instanceof Error && error.stack) {
    return error.stack;
  }
  return 'No stack trace';
}
