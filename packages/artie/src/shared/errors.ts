/**
 * Error helpers usable from engine, gateway and shared alike (shared/ imports nothing from
 * either side). Named so call sites read as a decision, not a ternary.
 */

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
