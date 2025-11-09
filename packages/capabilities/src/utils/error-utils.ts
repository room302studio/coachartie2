// =====================================================
// ERROR UTILITIES
// Common error handling utilities for consistent error messaging
// =====================================================

/**
 * Extract error message from any error type
 * Handles Error instances, strings, and unknown types
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Extract error stack trace if available
 * Returns 'No stack trace' for non-Error types
 */
export function getErrorStack(error: unknown): string {
  return error instanceof Error && error.stack ? error.stack : 'No stack trace';
}

/**
 * Format error for logging with message and stack
 */
export function formatError(error: unknown): { message: string; stack: string } {
  return {
    message: getErrorMessage(error),
    stack: getErrorStack(error),
  };
}
