import { logger, getSyncDb, type SyncDbWrapper } from '@coachartie/shared';

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

      this.processQueue();
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
export class HybridDataLayer {
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

    // Async persistence (non-blocking) - will update with real ID
    this.writeQueue
      .add(async () => {
        const realId = await this.persistMemory(memory, tempId);
        return realId;
      })
      .catch((error) => {
        logger.error('Failed to persist memory:', error);
      });

    return tempId; // Return temp ID immediately for fast response
  }

  /**
   * Get memory by ID - instant hot cache lookup
   */
  async getMemory(id: number): Promise<MemoryRecord | null> {
    const memory = this.hotData.get(id);
    if (memory) {
      return memory;
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
          return row;
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
      .filter((memory): memory is MemoryRecord =>
        memory !== undefined &&
        // Guild isolation: only return memories from same guild or no guild
        (!guildId || !memory.guild_id || memory.guild_id === guildId)
      )
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);

    // If we don't have enough in hot cache, check cold storage
    if (memories.length < limit && this.coldStorage) {
      try {
        // Build query with optional guild filter
        const guildFilter = guildId ? 'AND (guild_id = ? OR guild_id IS NULL)' : '';
        const params = guildId ? [userId, guildId, limit] : [userId, limit];

        // Now using synchronous better-sqlite3 (no await needed)
        const rows = this.coldStorage.all<MemoryRecord>(
          `
          SELECT id, user_id, content, tags, context, timestamp, importance,
                 metadata, embedding, related_message_id, guild_id, channel_id, created_at, updated_at
          FROM memories
          WHERE user_id = ? ${guildFilter}
          ORDER BY timestamp DESC
          LIMIT ?
        `,
          params
        );

        return rows.slice(0, limit);
      } catch (error) {
        logger.error('Failed to get recent memories from cold storage:', error);
      }
    }

    return memories;
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
        ORDER BY timestamp DESC
        LIMIT ?
        `,
        [guildId, limit]
      );
      return rows;
    } catch (error) {
      logger.error('Failed to get guild memories:', error);
      return [];
    }
  }

  /**
   * Search memories - uses FTS if available
   * SECURITY: Filters by guild_id to prevent cross-guild info leakage
   */
  async searchMemories(userId: string, query: string, limit = 10, guildId?: string): Promise<MemoryRecord[]> {
    // First try hot cache simple search
    const userMemoryIds = this.userIndex.get(userId) || new Set();
    const hotResults = Array.from(userMemoryIds)
      .map((id) => this.hotData.get(id))
      .filter(
        (memory): memory is MemoryRecord =>
          memory !== undefined &&
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
        const guildFilter = guildId ? 'AND (m.guild_id = ? OR m.guild_id IS NULL)' : '';

        // Escape FTS5 query to prevent syntax errors
        // Wrap in quotes and escape internal quotes to make it a phrase search
        const escapedQuery = `"${query.trim().replace(/"/g, '""')}"`;
        const params = guildId ? [escapedQuery, userId, guildId] : [escapedQuery, userId];

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

        return rows;
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

// Singleton instance - Use shared database path for consolidation
export const hybridDataLayer = new HybridDataLayer(
  process.env.DATABASE_PATH || '/app/data/coachartie.db'
);
