import { logger } from '../../shared/logger.js';
import { getSyncDb, type SyncDbWrapper } from '../../shared/db/client.js';
import { isBlockedUser } from '../../shared/blocklist.js';
import { mentionsOptedOutUser } from '../../shared/privacy-opt-out.js';
import { getDatabasePath } from '../../shared/paths.js';
import { escapeFts5 } from '../../shared/sql-escape.js';
import { isHiddenLegacyReflection } from './legacy-reflection-filter.js';

// Memories keyed to blocked users never surface in recall. Memories that merely
// mention a BANNED user are allowed (policy 2026-07-16: Artie may reference banned users;
// the no-name rule is enforced at the discord output layer). Memories that name someone
// who OPTED OUT never surface: that was their request.
function isRecallable(memory: MemoryRecord): boolean {
  return !isBlockedUser(memory.user_id) && !mentionsOptedOutUser(memory.content) && !isStaleNoise(memory);
}

/**
 * Memories that only ever cluttered recall (Artie flagged it himself, 2026-10-22):
 * the July observation firehose (7,161 rows, never once recalled usefully), old
 * daily-summary notes that read as current events, and importance ≤ 2 chatter. They stay
 * in the database (history, audits); they just aren't candidates for what he "remembers".
 */
export function isStaleNoise(
  memory: Pick<MemoryRecord, 'user_id' | 'tags' | 'importance'> & { context?: string | null; content?: string }
): boolean {
  if (memory.user_id === 'observational-system') return true;
  if ((memory.importance ?? 5) <= 2) return true;
  const tags = memory.tags || '';
  if (/"(observation|passive-learning|daily-summary)"/.test(tags)) return true;
  // Other AIs' Moltbook posts were stored as memories; Moltbook is off, so are they.
  if (/^moltbook_/.test(memory.context || '')) return true;
  // Pre-wave-10 reflections written in character ("Lap eighteen, comrade") instead of as
  // notes; recalled, they replay old loops. JSON-path rows (tagged reflection_v3) skip this.
  return isHiddenLegacyReflection(memory);
}

/**
 * Other guilds whose memories a guild may also recall, one way, from
 * MEMORY_GUILD_READS_FROM="reader:source|source,reader2:source". For a private server whose
 * members all come from a bigger one, it can remember the bigger one's history, never the
 * reverse. Keyword matches only; ids live in env, never in code.
 */
export function readableGuilds(guildId: string, spec = process.env.MEMORY_GUILD_READS_FROM || ''): string[] {
  for (const pair of spec.split(',')) {
    const [reader, sources] = pair.split(':').map((s) => s?.trim());
    if (reader === guildId && sources) return sources.split('|').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

/** The guilds a recall in `guildId` may draw from: itself plus any it reads from. None outside a guild. */
export function recallGuildIds(guildId?: string): string[] {
  if (!guildId) return [];
  return [guildId, ...readableGuilds(guildId)];
}

// Words that say "this is a question about memory" rather than what it's about.
const RECALL_STOPWORDS = new Set(
  ('the and for you your are was were with that this what when where who why how does did ' +
    'have has had about from into they them their there then than just like know remember ' +
    'recall tell think thing things some any can could would should will artie coach hey yeah ' +
    'please again ever still also our out its not all get got one people here').split(' ')
);

/**
 * An FTS5 MATCH string for a recall question: distinctive words OR'd together, each also
 * matched in singular form ("trolls" finds "troll"). Exact tokens, not prefixes: troll*
 * matched "Trolley". Returns '' when nothing distinctive is left.
 */
export function ftsKeywordQuery(text: string): string {
  const words = Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/<@!?\d+>|https?:\/\/\S+/g, ' ')
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3 && !RECALL_STOPWORDS.has(w) && !/^\d+$/.test(w))
    )
  ).slice(0, 8);
  const terms = new Set<string>();
  for (const w of words) {
    terms.add(w);
    if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) terms.add(w.slice(0, -1));
  }
  return [...terms].map(escapeFts5).join(' OR ');
}

// Read-time legacy filter only (the write path no longer calls it); re-exported for its tests.
export { isInCharacterReflection } from './legacy-reflection-filter.js';

/**
 * Memory Record interface - Aligned with shared schema
 * Uses snake_case for SQL compatibility since we use raw SQL with sql.js
 *
 * Note: This extends the shared Memory type but uses snake_case field names
 * for direct SQL compatibility. The shared Memory type uses camelCase (TypeScript)
 * which maps to snake_case (database) via Drizzle, but we're using raw SQL here.
 */
export interface MemoryRecord {
  id: number; // Auto-increment ID (matches shared schema)
  user_id: string;
  content: string;
  tags: string; // JSON array as string
  context: string;
  timestamp: string; // ISO timestamp string
  importance: number;
  metadata: string; // JSON object as string
  related_message_id?: string | null; // Changed to string to match shared schema
  guild_id?: string | null; // Discord guild scope
  channel_id?: string | null; // Discord channel scope
  created_at?: string;
  updated_at?: string;
}

/**
 * Async Queue for serializing writes
 */
class AsyncQueue {
  private queue: Array<() => Promise<void>> = [];
  private processing = false;

  async add<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await operation();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });

      // Fire-and-forget on purpose: processQueue catches every operation's error itself.
      void this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      const operation = this.queue.shift();
      if (operation) {
        try {
          await operation();
        } catch (error) {
          logger.error('Queue operation failed:', error);
        }
      }
    }

    this.processing = false;
  }
}

/**
 * Hybrid Data Layer - Combines in-memory performance with SQLite persistence
 *
 * This eliminates SQLite concurrency bottlenecks by:
 * 1. Serving reads from fast in-memory cache
 * 2. Serializing writes through async queue
 * 3. Background persistence without blocking user requests
 */
class MemoryStore {
  private hotData = new Map<number, MemoryRecord>(); // In-memory for active data
  private userIndex = new Map<string, Set<number>>(); // User ID -> Memory IDs
  private writeQueue = new AsyncQueue(); // Serialize writes
  private coldStorage?: SyncDbWrapper; // SQLite for persistence (using better-sqlite3, not sql.js!)
  private maxHotMemories = 10000; // Keep most recent 10k in memory
  private syncInterval: NodeJS.Timeout;

  constructor(databasePath?: string) {
    if (databasePath) {
      try {
        // Use synchronous better-sqlite3 instead of async sql.js
        // This prevents database corruption from sql.js overwriting better-sqlite3 changes
        this.coldStorage = getSyncDb();
        this.validateSchema(); // Check schema integrity at startup
        this.loadRecentMemories();
      } catch (error) {
        logger.warn('Failed to initialize SQLite, running in memory-only mode:', error);
      }
    }

    // Periodic sync every 30 seconds
    this.syncInterval = setInterval(() => {
      this.syncToStorage().catch((error) => {
        logger.error('Background sync failed:', error);
      });
    }, 30000);

    logger.info(`✅ Hybrid Data Layer initialized (hot cache: ${this.hotData.size} memories)`);
  }

  // Schema initialization deleted - use existing database schema

  /**
   * Validate required schema exists at startup
   * Logs errors loudly if critical tables/indexes are missing
   */
  private validateSchema(): void {
    if (!this.coldStorage) return;

    const requiredTables = ['memories', 'memories_fts', 'messages', 'learned_rules'];
    const missingTables: string[] = [];

    for (const table of requiredTables) {
      try {
        // Check if table exists by querying it
        const result = this.coldStorage.get<{ count: number }>(
          `SELECT COUNT(*) as count FROM ${table} LIMIT 1`
        );
        if (result === undefined) {
          missingTables.push(table);
        }
      } catch {
        missingTables.push(table);
      }
    }

    if (missingTables.length > 0) {
      const msg = `⚠️ SCHEMA VALIDATION FAILED: Missing tables: ${missingTables.join(', ')}. Run schema.sql to fix.`;
      logger.error(msg);
      // Log every startup, not just once - this is critical
      console.error(`\n${'='.repeat(60)}\n${msg}\n${'='.repeat(60)}\n`);
    } else {
      logger.info('✅ Schema validation passed: all required tables exist');
    }
  }

  /**
   * Load recent memories into hot cache
   */
  private loadRecentMemories(): void {
    if (!this.coldStorage) {
      return;
    }

    try {
      // Now using synchronous better-sqlite3 (no await needed)
      const rows = this.coldStorage.all<MemoryRecord>(
        `
        SELECT id, user_id, content, tags, context, timestamp, importance,
               metadata, embedding, related_message_id, guild_id, channel_id, created_at, updated_at
        FROM memories
        ORDER BY timestamp DESC
        LIMIT ${this.maxHotMemories}
      `
      );

      for (const row of rows) {
        this.hotData.set(row.id, row);

        // Update user index
        if (!this.userIndex.has(row.user_id)) {
          this.userIndex.set(row.user_id, new Set());
        }
        this.userIndex.get(row.user_id)!.add(row.id);
      }

      logger.info(`✅ Loaded ${rows.length} recent memories into hot cache`);
    } catch (error) {
      logger.error('Failed to load recent memories:', error);
    }
  }

  /**
   * Store memory - instant hot cache write, async persistence
   * Accepts a partial memory (without id) and returns the assigned id
   */
  async storeMemory(
    memory: Omit<MemoryRecord, 'id' | 'created_at' | 'updated_at'>
  ): Promise<number> {
    // Generate a temporary negative ID for immediate hot cache storage
    // This will be replaced with the real auto-increment ID after persistence
    const tempId = -Date.now();

    const tempMemory: MemoryRecord = {
      ...memory,
      id: tempId,
    };

    // Immediate hot cache storage with temp ID
    this.hotData.set(tempId, tempMemory);

    // Update user index
    if (!this.userIndex.has(memory.user_id)) {
      this.userIndex.set(memory.user_id, new Set());
    }
    this.userIndex.get(memory.user_id)!.add(tempId);

    // Maintain hot cache size limit
    if (this.hotData.size > this.maxHotMemories) {
      this.evictOldestMemories();
    }

    // Wait for the (synchronous, sub-ms) insert and hand back the REAL id. Returning the temp
    // id meant the semantic tagger looked it up after the swap and found nothing (0 of 65
    // tags landed Oct 29-31), and the model was shown a negative id (2026-10-31).
    try {
      return await this.writeQueue.add(() => this.persistMemory(memory, tempId));
    } catch (error) {
      // Same as before on a failed insert: the memory stays in the hot cache under its temp id.
      logger.error('Failed to persist memory:', error);
      return tempId;
    }
  }

  /**
   * Get memory by ID - instant hot cache lookup
   */
  async getMemory(id: number): Promise<MemoryRecord | null> {
    const memory = this.hotData.get(id);
    if (memory) {
      if (isRecallable(memory)) {
        return memory;
      }
      return null;
    }

    // If not in hot cache, try cold storage
    if (this.coldStorage) {
      try {
        // Now using synchronous better-sqlite3 (no await needed)
        const row = this.coldStorage.get<MemoryRecord>(
          `
          SELECT id, user_id, content, tags, context, timestamp, importance,
                 metadata, embedding, related_message_id, guild_id, channel_id, created_at, updated_at
          FROM memories WHERE id = ?
        `,
          [id]
        );

        if (row) {
          // Promote to hot cache
          this.hotData.set(row.id, row);
          if (isRecallable(row)) {
            return row;
          }
          return null;
        }
      } catch (error) {
        logger.error('Failed to get memory from cold storage:', error);
      }
    }

    return null;
  }

  /**
   * Get recent memories for user - fast index lookup
   * SECURITY: Filters by guild_id to prevent cross-guild info leakage
   */
  async getRecentMemories(userId: string, limit = 10, guildId?: string): Promise<MemoryRecord[]> {
    const userMemoryIds = this.userIndex.get(userId);
    if (!userMemoryIds) {
      return [];
    }

    // Get memories from hot cache with guild isolation
    const memories = Array.from(userMemoryIds)
      .map((id) => this.hotData.get(id))
      .filter(
        (memory): memory is MemoryRecord =>
          memory !== undefined &&
          isRecallable(memory) &&
          // Guild isolation: only return memories from same guild or no guild
          (!guildId || !memory.guild_id || memory.guild_id === guildId)
      )
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);

    // If we don't have enough in hot cache, check cold storage
    if (memories.length < limit && this.coldStorage) {
      try {
        // Build query with optional guild filter
        let guildFilter = '';
        let params: unknown[];
        if (guildId) {
          guildFilter = 'AND (guild_id = ? OR guild_id IS NULL)';
          params = [userId, guildId, limit];
        } else {
          params = [userId, limit];
        }

        // Now using synchronous better-sqlite3 (no await needed)
        const rows = this.coldStorage.all<MemoryRecord>(
          `
          SELECT id, user_id, content, tags, context, timestamp, importance,
                 metadata, embedding, related_message_id, guild_id, channel_id, created_at, updated_at
          FROM memories
          WHERE user_id = ? ${guildFilter}
            AND COALESCE(importance, 5) > 2
            AND COALESCE(tags, '') NOT LIKE '%"observation"%'
            AND COALESCE(tags, '') NOT LIKE '%"daily-summary"%'
          ORDER BY timestamp DESC
          LIMIT ?
        `,
          params
        );

        return rows.filter(isRecallable).slice(0, limit);
      } catch (error) {
        logger.error('Failed to get recent memories from cold storage:', error);
      }
    }

    return memories;
  }

  /**
   * Full-text keyword search for recall, ranked by bm25. The other candidate fetches are
   * recency windows (the newest 60/150/400), so anything older could never be remembered:
   * asked about "the bee movie incident" (February), the pool reached back only to April
   * and he said he had no record of it (2026-10-30). This pass lets an old memory that
   * matches the question join the pool.
   *
   * Scope matches the recency pool: the asker's own memories (this guild or unscoped), plus
   * anything stored in `guildIds`; outside a guild, the asker's and Artie's own.
   */
  keywordSearch(
    query: string,
    opts: { userId: string; guildIds?: string[]; limit?: number }
  ): MemoryRecord[] {
    const match = ftsKeywordQuery(query);
    if (!this.coldStorage || !match) return [];
    const guildIds = (opts.guildIds ?? []).filter(Boolean);
    let scope: string;
    let params: unknown[];
    if (guildIds.length) {
      const marks = guildIds.map(() => '?').join(', ');
      scope = `((m.user_id = ? AND (m.guild_id IS NULL OR m.guild_id IN (${marks}))) OR m.guild_id IN (${marks}))`;
      params = [opts.userId, ...guildIds, ...guildIds];
    } else {
      scope = `m.user_id IN (?, 'artie-social')`;
      params = [opts.userId];
    }
    try {
      const rows = this.coldStorage.all<MemoryRecord>(
        `
        SELECT m.id, m.user_id, m.content, m.tags, m.context, m.timestamp, m.importance,
               m.metadata, m.related_message_id, m.guild_id, m.channel_id, m.created_at, m.updated_at
        FROM (
          -- FTS first, scope after: with the scope in the same WHERE, SQLite drove the join
          -- from memories and ran MATCH per row (4s on prod; this is ~20ms).
          SELECT rowid, rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT 500
        ) f
        JOIN memories m ON m.id = f.rowid
        WHERE ${scope}
          AND COALESCE(m.importance, 5) > 2
        ORDER BY f.rank - COALESCE(m.importance, 5) * 0.3
        LIMIT ?
        `,
        [match, ...params, (opts.limit ?? 20) * 2]
      );
      return rows.filter(isRecallable).slice(0, opts.limit ?? 20);
    } catch (error) {
      logger.warn('Keyword memory search failed:', error);
      return [];
    }
  }

  /**
   * Get memories for a specific guild (community knowledge)
   * These are guild-scoped memories like observations, community facts, etc.
   */
  async getGuildMemories(guildId: string, limit = 10): Promise<MemoryRecord[]> {
    if (!this.coldStorage) {
      return [];
    }

    try {
      const rows = this.coldStorage.all<MemoryRecord>(
        `
        SELECT id, user_id, content, tags, context, timestamp, importance,
               metadata, embedding, related_message_id, guild_id, channel_id, created_at, updated_at
        FROM memories
        WHERE guild_id = ?
          -- same noise rules as isStaleNoise, in SQL so the LIMIT window isn't all firehose
          AND user_id != 'observational-system'
          AND COALESCE(importance, 5) > 2
          AND COALESCE(tags, '') NOT LIKE '%"observation"%'
          AND COALESCE(tags, '') NOT LIKE '%"passive-learning"%'
          AND COALESCE(tags, '') NOT LIKE '%"daily-summary"%'
        ORDER BY timestamp DESC
        LIMIT ?
        `,
        [guildId, limit]
      );
      return rows.filter(isRecallable);
    } catch (error) {
      logger.error('Failed to get guild memories:', error);
      return [];
    }
  }

  /**
   * Search memories - uses FTS if available
   * SECURITY: Filters by guild_id to prevent cross-guild info leakage
   */
  async searchMemories(
    userId: string,
    query: string,
    limit = 10,
    guildId?: string
  ): Promise<MemoryRecord[]> {
    // First try hot cache simple search
    const userMemoryIds = this.userIndex.get(userId) || new Set();
    const hotResults = Array.from(userMemoryIds)
      .map((id) => this.hotData.get(id))
      .filter(
        (memory): memory is MemoryRecord =>
          memory !== undefined &&
          isRecallable(memory) &&
          memory.content.toLowerCase().includes(query.toLowerCase()) &&
          // Guild isolation: only return memories from same guild or no guild
          (!guildId || !memory.guild_id || memory.guild_id === guildId)
      )
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);

    if (hotResults.length >= limit || !this.coldStorage) {
      return hotResults;
    }

    // Try FTS search in cold storage (only if query is not empty)
    if (query && query.trim().length > 0) {
      try {
        // Build query with optional guild filter
        let guildFilter = '';
        let params: unknown[];
        if (guildId) {
          guildFilter = 'AND (m.guild_id = ? OR m.guild_id IS NULL)';
        }

        // Escape FTS5 query to prevent syntax errors
        // Wrap in quotes and escape internal quotes to make it a phrase search
        const escapedQuery = escapeFts5(query.trim());
        if (guildId) {
          params = [escapedQuery, userId, guildId];
        } else {
          params = [escapedQuery, userId];
        }

        // Now using synchronous better-sqlite3 (no await needed)
        const rows = this.coldStorage.all<MemoryRecord>(
          `
          SELECT m.id, m.user_id, m.content, m.tags, m.context, m.timestamp, m.importance,
                 m.metadata, m.embedding, m.related_message_id, m.created_at, m.updated_at
          FROM memories_fts f
          JOIN memories m ON m.rowid = f.rowid
          WHERE f.content MATCH ? AND m.user_id = ? ${guildFilter}
          ORDER BY m.timestamp DESC
          LIMIT ${limit}
        `,
          params
        );

        return rows.filter(isRecallable);
      } catch (error) {
        logger.error('FTS search failed, falling back to hot cache results:', error);
      }
    }

    return hotResults;
  }

  /**
   * Persist memory to cold storage and update hot cache with real ID
   */
  private async persistMemory(
    memory: Omit<MemoryRecord, 'id' | 'created_at' | 'updated_at'>,
    tempId: number
  ): Promise<number> {
    if (!this.coldStorage) {
      return tempId;
    }

    try {
      // Now using synchronous better-sqlite3 (no await needed)
      const result = this.coldStorage.run(
        `
        INSERT INTO memories
        (user_id, content, tags, context, timestamp, importance, metadata, related_message_id, guild_id, channel_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          memory.user_id,
          memory.content,
          memory.tags,
          memory.context,
          memory.timestamp,
          memory.importance,
          memory.metadata,
          memory.related_message_id || null,
          memory.guild_id || null,
          memory.channel_id || null,
        ]
      );

      // better-sqlite3 uses lastInsertRowid instead of lastID
      const realId = Number(result.lastInsertRowid);

      // Replace temp entry with real ID in hot cache
      const tempMemory = this.hotData.get(tempId);
      if (tempMemory) {
        this.hotData.delete(tempId);
        const realMemory: MemoryRecord = {
          ...tempMemory,
          id: realId,
        };
        this.hotData.set(realId, realMemory);

        // Update user index
        const userSet = this.userIndex.get(memory.user_id);
        if (userSet) {
          userSet.delete(tempId);
          userSet.add(realId);
        }
      }

      return realId;
    } catch (error) {
      logger.error('Failed to persist memory to cold storage:', error);
      throw error;
    }
  }

  /**
   * Update an existing memory in both hot cache and cold storage
   */
  async updateMemory(memory: MemoryRecord): Promise<void> {
    // Update hot cache immediately
    this.hotData.set(memory.id, memory);

    // Queue async persistence
    this.writeQueue
      .add(async () => {
        if (!this.coldStorage) return;

        try {
          // Now using synchronous better-sqlite3 (no await needed)
          this.coldStorage.run(
            `
            UPDATE memories
            SET content = ?, tags = ?, context = ?, timestamp = ?, importance = ?,
                metadata = ?, related_message_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `,
            [
              memory.content,
              memory.tags,
              memory.context,
              memory.timestamp,
              memory.importance,
              memory.metadata,
              memory.related_message_id || null,
              memory.id,
            ]
          );
        } catch (error) {
          logger.error(`Failed to update memory ${memory.id} in cold storage:`, error);
        }
      })
      .catch((error) => {
        logger.error('Failed to queue memory update:', error);
      });
  }

  /**
   * Delete a memory (the `forget` action). Ownership-checked by the caller (memory.ts), not
   * here — this just removes the row once told to. Removes it from the hot cache and the
   * user index immediately, and queues the cold-storage delete, mirroring updateMemory's
   * immediate-hot / async-cold split.
   */
  async deleteMemory(id: number): Promise<void> {
    this.hotData.delete(id);
    for (const [, ids] of this.userIndex) {
      ids.delete(id);
    }

    this.writeQueue
      .add(async () => {
        if (!this.coldStorage) return;
        try {
          this.coldStorage.run(`DELETE FROM memories WHERE id = ?`, [id]);
        } catch (error) {
          logger.error(`Failed to delete memory ${id} from cold storage:`, error);
        }
      })
      .catch((error) => {
        logger.error('Failed to queue memory delete:', error);
      });
  }

  /**
   * Evict oldest memories from hot cache
   */
  private evictOldestMemories(): void {
    const memories = Array.from(this.hotData.values()).sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const toEvict = memories.slice(0, Math.floor(this.maxHotMemories * 0.1)); // Evict 10%

    for (const memory of toEvict) {
      this.hotData.delete(memory.id);

      const userSet = this.userIndex.get(memory.user_id);
      if (userSet) {
        userSet.delete(memory.id);
        if (userSet.size === 0) {
          this.userIndex.delete(memory.user_id);
        }
      }
    }
  }

  /**
   * Background sync to storage
   */
  private async syncToStorage(): Promise<void> {
    if (!this.coldStorage) {
      return;
    }

    // This method can be enhanced to sync dirty flags, etc.
  }

  /**
   * Record that memories were recalled/accessed
   * Tracks usage patterns to understand which memories are actually useful
   */
  recordMemoryRecalls(
    memoryIds: number[],
    context?: {
      userId?: string;
      guildId?: string;
      query?: string;
      relevanceScores?: number[];
    }
  ): void {
    if (!this.coldStorage || memoryIds.length === 0) {
      return;
    }

    try {
      const now = new Date().toISOString();

      for (let i = 0; i < memoryIds.length; i++) {
        const memoryId = memoryIds[i];

        // Update recall count and timestamp on the memory
        this.coldStorage.run(
          `UPDATE memories
           SET recall_count = COALESCE(recall_count, 0) + 1,
               last_recalled_at = ?
           WHERE id = ?`,
          [now, memoryId]
        );

        // Log the individual recall event
        this.coldStorage.run(
          `INSERT INTO memory_recalls
           (memory_id, recalled_at, context, user_id, guild_id, relevance_score)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            memoryId,
            now,
            context?.query || null,
            context?.userId || null,
            context?.guildId || null,
            context?.relevanceScores?.[i] || null,
          ]
        );
      }

      logger.debug(`📊 Recorded ${memoryIds.length} memory recalls`);
    } catch (error) {
      // Don't let recall tracking break the main flow
      logger.warn('Failed to record memory recalls:', error);
    }
  }

  /**
   * Get recall statistics for a memory
   */
  getMemoryRecallStats(
    memoryId: number
  ): { recallCount: number; lastRecalled: string | null } | null {
    if (!this.coldStorage) {
      return null;
    }

    try {
      const result = this.coldStorage.get<{
        recall_count: number;
        last_recalled_at: string | null;
      }>(`SELECT recall_count, last_recalled_at FROM memories WHERE id = ?`, [memoryId]);

      if (result) {
        return { recallCount: result.recall_count || 0, lastRecalled: result.last_recalled_at };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get most frequently recalled memories
   */
  getMostRecalledMemories(limit = 20): Array<{ id: number; content: string; recallCount: number }> {
    if (!this.coldStorage) {
      return [];
    }

    try {
      return this.coldStorage
        .all<{ id: number; content: string; recall_count: number }>(
          `SELECT id, substr(content, 1, 200) as content, recall_count
         FROM memories
         WHERE recall_count > 0
         ORDER BY recall_count DESC
         LIMIT ?`,
          [limit]
        )
        .map((r) => ({ id: r.id, content: r.content, recallCount: r.recall_count }));
    } catch {
      return [];
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<{ hotCacheSize: number; coldStorageConnected: boolean }> {
    return {
      hotCacheSize: this.hotData.size,
      coldStorageConnected: !!this.coldStorage,
    };
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }

    // Final sync
    await this.syncToStorage();

    if (this.coldStorage) {
      this.coldStorage.close();
    }

    this.hotData.clear();
    this.userIndex.clear();

    logger.info('Hybrid Data Layer cleaned up');
  }
}

// Singleton instance - Use shared database path for consolidation. Routed through paths.ts's
// getDatabasePath() (wave 2): same DATABASE_PATH env override, but the fallback is now
// REPO_ROOT/data/coachartie.db instead of a Docker '/app/data/coachartie.db' path that no
// longer exists anywhere this repo runs (Docker support was removed in wave 1).
export const memoryStore = new MemoryStore(getDatabasePath());
