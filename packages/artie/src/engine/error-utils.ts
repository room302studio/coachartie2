// =====================================================
// ERROR UTILITIES
// Common error handling utilities for consistent error messaging.
// The helpers live in shared/errors.ts so the gateway can use them too.
// =====================================================

import { getErrorMessage, getErrorStack } from '../shared/errors.js';

export { getErrorMessage, getErrorStack };

/**
 * Format error for logging with message and stack
 */
export function formatError(error: unknown): { message: string; stack: string } {
  return {
    message: getErrorMessage(error),
    stack: getErrorStack(error),
  };
}
