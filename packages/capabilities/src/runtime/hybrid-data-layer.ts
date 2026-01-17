import { logger, getDatabase, type Memory } from '@coachartie/shared';

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
  embedding?: string | null; // JSON array as string
  related_message_id?: string | null; // Changed to string to match shared schema
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
  private coldStorage?: any; // SQLite for persistence
  private maxHotMemories = 10000; // Keep most recent 10k in memory
  private syncInterval: NodeJS.Timeout;

  constructor(databasePath?: string) {
    if (databasePath) {
      this.initializeAsync().catch((error) => {
        logger.warn('Failed to initialize SQLite, running in memory-only mode:', error);
      });
    }

    // Periodic sync every 30 seconds
    this.syncInterval = setInterval(() => {
      this.syncToStorage().catch((error) => {
        logger.error('Background sync failed:', error);
      });
    }, 30000);

    logger.info(`✅ Hybrid Data Layer initialized (hot cache: ${this.hotData.size} memories)`);
  }

  /**
   * Async initialization helper
   */
  private async initializeAsync(): Promise<void> {
    try {
      this.coldStorage = await getDatabase();
      // Database schema already initialized
      await this.loadRecentMemories();
    } catch (error) {
      logger.error('Failed to initialize database:', error);
      throw error;
    }
  }

  // Schema initialization deleted - use existing database schema

  /**
   * Load recent memories into hot cache
   */
  private async loadRecentMemories(): Promise<void> {
    if (!this.coldStorage) {
      return;
    }

    try {
      // Use inline limit to avoid sql.js parameter binding issues with LIMIT
      const rows = (await this.coldStorage.all(
        `
        SELECT id, user_id, content, tags, context, timestamp, importance,
               metadata, embedding, related_message_id, created_at, updated_at
        FROM memories
        ORDER BY timestamp DESC
        LIMIT ${this.maxHotMemories}
      `
      )) as MemoryRecord[];

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
  async storeMemory(memory: Omit<MemoryRecord, 'id' | 'created_at' | 'updated_at'>): Promise<number> {
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
        const row = (await this.coldStorage.get(
          `
          SELECT id, user_id, content, tags, context, timestamp, importance,
                 metadata, embedding, related_message_id, created_at, updated_at
          FROM memories WHERE id = ?
        `,
          [id]
        )) as MemoryRecord | undefined;

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
   */
  async getRecentMemories(userId: string, limit = 10): Promise<MemoryRecord[]> {
    const userMemoryIds = this.userIndex.get(userId);
    if (!userMemoryIds) {
      return [];
    }

    // Get memories from hot cache
    const memories = Array.from(userMemoryIds)
      .map((id) => this.hotData.get(id))
      .filter((memory): memory is MemoryRecord => memory !== undefined)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);

    // If we don't have enough in hot cache, check cold storage
    if (memories.length < limit && this.coldStorage) {
      try {
        const rows = (await this.coldStorage.all(
          `
          SELECT id, user_id, content, tags, context, timestamp, importance,
                 metadata, embedding, related_message_id, created_at, updated_at
          FROM memories
          WHERE user_id = ?
          ORDER BY timestamp DESC
          LIMIT ${limit}
        `,
          [userId]
        )) as MemoryRecord[];

        return rows.slice(0, limit);
      } catch (error) {
        logger.error('Failed to get recent memories from cold storage:', error);
      }
    }

    return memories;
  }

  /**
   * Search memories - uses FTS if available
   */
  async searchMemories(userId: string, query: string, limit = 10): Promise<MemoryRecord[]> {
    // First try hot cache simple search
    const userMemoryIds = this.userIndex.get(userId) || new Set();
    const hotResults = Array.from(userMemoryIds)
      .map((id) => this.hotData.get(id))
      .filter(
        (memory): memory is MemoryRecord =>
          memory !== undefined && memory.content.toLowerCase().includes(query.toLowerCase())
      )
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);

    if (hotResults.length >= limit || !this.coldStorage) {
      return hotResults;
    }

    // Try FTS search in cold storage (only if query is not empty)
    if (query && query.trim().length > 0) {
      try {
        const rows = (await this.coldStorage.all(
          `
          SELECT m.id, m.user_id, m.content, m.tags, m.context, m.timestamp, m.importance,
                 m.metadata, m.embedding, m.related_message_id, m.created_at, m.updated_at
          FROM memories_fts f
          JOIN memories m ON m.rowid = f.rowid
          WHERE f.content MATCH ? AND m.user_id = ?
          ORDER BY m.timestamp DESC
          LIMIT ${limit}
        `,
          [query.trim(), userId]
        )) as MemoryRecord[];

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
      const result = await this.coldStorage.run(
        `
        INSERT INTO memories
        (user_id, content, tags, context, timestamp, importance, metadata, embedding, related_message_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          memory.user_id,
          memory.content,
          memory.tags,
          memory.context,
          memory.timestamp,
          memory.importance,
          memory.metadata,
          memory.embedding || null,
          memory.related_message_id || null,
        ]
      );

      const realId = result.lastID as number;

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

      // Generate and store embedding asynchronously (non-blocking)
      this.generateEmbeddingForMemory(realId, memory.content).catch((err) =>
        logger.warn(`Failed to generate embedding for memory ${realId}:`, err)
      );

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
          await this.coldStorage.run(
            `
            UPDATE memories
            SET content = ?, tags = ?, context = ?, timestamp = ?, importance = ?,
                metadata = ?, embedding = ?, related_message_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `,
            [
              memory.content,
              memory.tags,
              memory.context,
              memory.timestamp,
              memory.importance,
              memory.metadata,
              memory.embedding || null,
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
   * Generate and store embedding for a memory (async, non-blocking)
   */
  private async generateEmbeddingForMemory(memoryId: number, content: string): Promise<void> {
    try {
      // Dynamic import to avoid circular dependencies
      const { vectorEmbeddingService } = await import('../services/memory/vector-embeddings.js');

      if (!vectorEmbeddingService.isReady()) {
        await vectorEmbeddingService.initialize();
      }

      if (vectorEmbeddingService.isReady()) {
        const success = await vectorEmbeddingService.storeEmbedding(memoryId, content);
        if (success) {
          logger.debug(`🧠 Auto-generated embedding for memory #${memoryId}`);
        }
      }
    } catch (_error) {
      // Silently fail - embeddings are optional enhancement
      logger.debug(`Embedding generation skipped for memory #${memoryId}`);
    }
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
