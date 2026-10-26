/**
 * Self-serve privacy opt-out (/artie-optout, /artie-optin).
 *
 * An opted-out user is treated like a blocklisted one for DATA purposes: their messages are
 * dropped at intake, stripped from channel history and digests, and no memories form about
 * them (isBlockedUser() in config/blocklist.ts consults this list). Unlike the EJ-curated
 * blocklist, it's their own choice, so there's no 💔 and no "banned" epithet.
 *
 * Opting out also deletes what Artie already holds about them (deleteUserData): rows keyed
 * to their id, AND memories stored under other people's ids that name them (by id, @-mention
 * or one of their handles). The handles are kept in the opt-out row so memory formation and
 * recall can keep refusing new mentions (mentionsOptedOutUser).
 *
 * Both PM2 processes read the list through a 30s cache, so an opt-out takes effect everywhere
 * within half a minute; the process that writes it sees it immediately.
 */

import { getSyncDb } from './db/client.js';
import { logger } from './logger.js';
import { escapeRegex } from './regex.js';

const CACHE_MS = 30_000;
/** Handles shorter than this are too likely to match ordinary words ("jan", "kai"). */
const MIN_NAME_LEN = 4;

interface OptOutCache {
  at: number;
  ids: Set<string>;
  names: string[]; // lowercased handles + ids
}
let cache: OptOutCache | null = null;
let tableReady = false;

function ensureTable(): void {
  if (tableReady) return;
  const db = getSyncDb();
  db.run(`
    CREATE TABLE IF NOT EXISTS privacy_opt_outs (
      user_id TEXT PRIMARY KEY,
      opted_out_at TEXT NOT NULL
    )
  `);
  // Additive: handles they're known by (JSON array), for name matching.
  // Check first: the db wrapper logs every failed statement as an error.
  const cols = db.all<{ name: string }>(`PRAGMA table_info(privacy_opt_outs)`);
  if (!cols.some((c) => c.name === 'names')) {
    db.run(`ALTER TABLE privacy_opt_outs ADD COLUMN names TEXT NOT NULL DEFAULT '[]'`);
  }
  tableReady = true;
}

/** Normalize a person's handles into the names we match on. */
export function optOutNames(names: Array<string | null | undefined>): string[] {
  return [...new Set(names.map((n) => (n || '').trim().toLowerCase()).filter((n) => n.length >= MIN_NAME_LEN))];
}

function load(): OptOutCache {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache;
  try {
    ensureTable();
    const rows = getSyncDb().all<{ user_id: string; names: string }>(`SELECT user_id, names FROM privacy_opt_outs`);
    const names = rows.flatMap((r) => {
      try {
        return [r.user_id, ...(JSON.parse(r.names) as string[])];
      } catch {
        return [r.user_id];
      }
    });
    cache = { at: now, ids: new Set(rows.map((r) => r.user_id)), names };
  } catch (error) {
    // Keep serving the last known list rather than silently forgetting opt-outs.
    logger.warn('privacy-opt-out: could not read opt-out list', error);
    cache = { at: now, ids: cache?.ids ?? new Set(), names: cache?.names ?? [] };
  }
  return cache;
}

export function isOptedOut(userId?: string | null): boolean {
  return !!userId && load().ids.has(userId);
}

/**
 * True if the text names someone who opted out: their id (covers <@id> mentions) or one of
 * their handles, matched as a whole word. Used to refuse forming memories about them and to
 * keep stragglers out of recall.
 */
export function mentionsOptedOutUser(text?: string | null): boolean {
  if (!text) return false;
  const { names } = load();
  if (names.length === 0) return false;
  const lower = text.toLowerCase();
  return names.some((n) => new RegExp(`(^|[^a-z0-9_])${escapeRegex(n)}($|[^a-z0-9_])`).test(lower));
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

/**
 * Delete everything Artie holds about a user: rows keyed to their id, plus memories stored
 * under anyone else's id that name them. Returns rows removed per table.
 */
export function deleteUserData(userId: string, names: string[] = []): Record<string, number> {
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
  // Memories ABOUT them under other ids. LIKE narrows the scan; the word-boundary check
  // decides, so "janet" doesn't take out memories about "jan_gbg".
  const terms = [userId, ...names];
  const candidates = db.all<{ id: number; content: string }>(
    `SELECT id, content FROM memories WHERE ${terms.map(() => 'lower(content) LIKE ?').join(' OR ')}`,
    terms.map((t) => `%${t.toLowerCase()}%`)
  );
  const hits = candidates.filter((m) =>
    terms.some((t) => new RegExp(`(^|[^a-z0-9_])${escapeRegex(t.toLowerCase())}($|[^a-z0-9_])`).test(m.content.toLowerCase()))
  );
  for (const m of hits) db.run(`DELETE FROM memories WHERE id = ?`, [m.id]);
  removed.memories_mentioning = hits.length;
  return removed;
}

export function optOut(userId: string, handles: Array<string | null | undefined> = []): Record<string, number> {
  ensureTable();
  const names = optOutNames(handles);
  getSyncDb().run(
    `INSERT INTO privacy_opt_outs (user_id, opted_out_at, names) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET names = excluded.names`,
    [userId, new Date().toISOString(), JSON.stringify(names)]
  );
  cache = null;
  return deleteUserData(userId, names);
}

export function optIn(userId: string): boolean {
  ensureTable();
  const changes = getSyncDb().run(`DELETE FROM privacy_opt_outs WHERE user_id = ?`, [userId]).changes;
  cache = null;
  return (changes ?? 0) > 0;
}
