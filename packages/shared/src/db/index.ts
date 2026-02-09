/**
 * Database Module Exports
 *
 * Import from '@coachartie/shared/db' or '@coachartie/shared'
 */

export * from './schema.js';
export * from './client.js';

// Re-export drizzle-orm operators to ensure all packages use the same drizzle instance
// This fixes type mismatch errors when tables from @coachartie/shared are used with
// operators imported directly from drizzle-orm (different package instances due to pnpm hoisting)
export {
  eq,
  ne,
  and,
  or,
  not,
  gt,
  gte,
  lt,
  lte,
  like,
  ilike,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  asc,
  desc,
  sql,
  count,
  countDistinct,
  sum,
  avg,
  min,
  max,
} from 'drizzle-orm';
