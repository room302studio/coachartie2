import { getSyncDb, logger } from '@coachartie/shared';

/**
 * Read-only access to ONE user's own memories, for /memory. Always filtered by user_id in SQL:
 * there is no code path here that can return another user's rows.
 *
 * /memory used to call BRAIN_URL (default localhost:18239, where nothing listens), so it
 * failed for everyone. It reads the shared DB directly now.
 */
export interface OwnMemory {
  id: number;
  content: string;
  timestamp: string;
  importance: number | null;
  tags: string | null;
}

const COLUMNS = 'm.id, m.content, m.timestamp, m.importance, m.tags';

/** FTS5 query from free text: distinct quoted words OR'd (quoting defuses FTS syntax). */
export function toFtsQuery(text: string): string | null {
  const words = [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}_-]+/u)
        .filter((w) => w.length >= 2)
    ),
  ].slice(0, 16);
  return words.length ? words.map((w) => `"${w.replace(/"/g, '""')}"`).join(' OR ') : null;
}

export function searchOwnMemories(userId: string, query: string, limit: number): OwnMemory[] {
  const db = getSyncDb();
  const fts = toFtsQuery(query);
  if (fts) {
    try {
      return db.all<OwnMemory>(
        `SELECT ${COLUMNS} FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
          WHERE memories_fts MATCH ? AND m.user_id = ?
          ORDER BY bm25(memories_fts) LIMIT ?`,
        [fts, userId, limit]
      );
    } catch (error) {
      logger.warn('/memory search: FTS unavailable, falling back to LIKE', error);
    }
  }
  return db.all<OwnMemory>(
    `SELECT ${COLUMNS} FROM memories m WHERE m.user_id = ? AND m.content LIKE ?
      ORDER BY m.timestamp DESC LIMIT ?`,
    [userId, `%${query.replace(/[%_]/g, '')}%`, limit]
  );
}

export function recentOwnMemories(userId: string, limit: number): OwnMemory[] {
  return getSyncDb().all<OwnMemory>(
    `SELECT ${COLUMNS} FROM memories m WHERE m.user_id = ? ORDER BY m.timestamp DESC LIMIT ?`,
    [userId, limit]
  );
}

export interface OwnMemoryStats {
  total: number;
  lastWeek: number;
  oldest: string | null;
  avgImportance: number | null;
  topTags: Array<[string, number]>;
}

export function ownMemoryStats(userId: string, now: Date = new Date()): OwnMemoryStats {
  const db = getSyncDb();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const agg = db.get<{ total: number; lastWeek: number; oldest: string | null; avg: number | null }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END) AS lastWeek,
            MIN(timestamp) AS oldest, AVG(importance) AS avg
       FROM memories WHERE user_id = ?`,
    [weekAgo, userId]
  );
  // Tags are stored as a JSON array string ('["a","b"]'), not comma-separated.
  const counts = new Map<string, number>();
  for (const { tags } of db.all<{ tags: string | null }>(
    `SELECT tags FROM memories WHERE user_id = ? ORDER BY timestamp DESC LIMIT 2000`,
    [userId]
  )) {
    let list: unknown = [];
    try {
      list = JSON.parse(tags || '[]');
    } catch {
      list = [];
    }
    if (!Array.isArray(list)) continue;
    for (const tag of list) {
      const t = String(tag).trim();
      if (t) counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return {
    total: agg?.total ?? 0,
    lastWeek: agg?.lastWeek ?? 0,
    oldest: agg?.oldest ?? null,
    avgImportance: agg?.avg ?? null,
    topTags: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}
