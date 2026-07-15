/**
 * Shared types + config for Context Alchemy and its context providers.
 *
 * A "context provider" is a small async function that gathers one kind of
 * context (temporal, memory, Discord situational, etc.) and pushes zero or more
 * ContextSource entries onto the shared `sources` array. ContextAlchemy owns the
 * budget/selection/assembly machinery and runs the providers; the providers live
 * in `./` as plain functions so each is independently testable and readable.
 */

export const DEBUG = process.env.CONTEXT_ALCHEMY_DEBUG === 'true';

export interface ContextSource {
  name: string;
  priority: number;
  tokenWeight: number;
  content: string;
  category: 'temporal' | 'goals' | 'memory' | 'capabilities' | 'user_state' | 'evidence' | 'system';
}

export interface ContextBudget {
  totalTokens: number;
  reservedForUser: number;
  reservedForSystem: number;
  availableForContext: number;
}
