/**
 * Self-serve privacy opt-out (/artie-optout, /artie-optin).
 *
 * An opted-out user is treated like a blocklisted one for DATA purposes: their messages are
 * dropped at intake, stripped from channel history and digests, and no memories form about
 * them (isBlockedUser() in config/blocklist.ts consults this list). Unlike the EJ-curated
 * blocklist, it's their own choice, so there's no 💔 and no "banned" epithet.
 *
 * Opting out also deletes what Artie already holds about them (deleteUserData). Both PM2
 * processes read the list through a 30s cache, so an opt-out takes effect everywhere within
 * half a minute; the process that writes it sees it immediately.
 */

import { getSyncDb } from '../db/client.js';
import { logger } from '../utils/logger.js';

const CACHE_MS = 30_000;
let cache: { at: number; ids: Set<string> } | null = null;
let tableReady = false;

function ensureTable(): void {
  if (tableReady) return;
  getSyncDb().run(`
    CREATE TABLE IF NOT EXISTS privacy_opt_outs (
      user_id TEXT PRIMARY KEY,
      opted_out_at TEXT NOT NULL
    )
  `);
  tableReady = true;
}

function load(): Set<string> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.ids;
  try {
    ensureTable();
    const rows = getSyncDb().all<{ user_id: string }>(`SELECT user_id FROM privacy_opt_outs`);
    cache = { at: now, ids: new Set(rows.map((r) => r.user_id)) };
  } catch (error) {
    // Keep serving the last known list rather than silently forgetting opt-outs.
    logger.warn('privacy-opt-out: could not read opt-out list', error);
    cache = { at: now, ids: cache?.ids ?? new Set() };
  }
  return cache.ids;
}

export function isOptedOut(userId?: string | null): boolean {
  return !!userId && load().has(userId);
}

/**
 * Tables holding content or profiles keyed by user. model_usage_stats (token counts and
 * cost, no content) is kept for budgeting. memories_fts follows memories via triggers.
 */
export const USER_DATA_TABLES = [
  'memories',
  'messages',
  'generation_traces',
  'memory_recalls',
  'user_scores',
  'user_sessions',
] as const;

/** Delete everything Artie holds about a user. Returns rows removed per table. */
export function deleteUserData(userId: string): Record<string, number> {
  const db = getSyncDb();
  const removed: Record<string, number> = {};
  for (const table of USER_DATA_TABLES) {
    try {
      removed[table] = db.run(`DELETE FROM ${table} WHERE user_id = ?`, [userId]).changes ?? 0;
    } catch (error) {
      // A table missing in some deployment isn't a reason to stop deleting the rest.
      logger.warn(`privacy-opt-out: delete from ${table} failed`, error);
      removed[table] = 0;
    }
  }
  return removed;
}

export function optOut(userId: string): Record<string, number> {
  ensureTable();
  getSyncDb().run(
    `INSERT INTO privacy_opt_outs (user_id, opted_out_at) VALUES (?, ?)
     ON CONFLICT(user_id) DO NOTHING`,
    [userId, new Date().toISOString()]
  );
  cache = null;
  return deleteUserData(userId);
}

export function optIn(userId: string): boolean {
  ensureTable();
  const changes = getSyncDb().run(`DELETE FROM privacy_opt_outs WHERE user_id = ?`, [userId]).changes;
  cache = null;
  return (changes ?? 0) > 0;
}
