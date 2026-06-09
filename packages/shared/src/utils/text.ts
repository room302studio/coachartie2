/**
 * Text/token helpers shared across Artie.
 */

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
