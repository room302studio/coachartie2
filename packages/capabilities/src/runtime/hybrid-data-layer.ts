import { logger, getDatabase } from '@coachartie/shared';

/**
 * Memory Record interface
 */
export interface MemoryRecord {
  id: string;
  user_id: string;
  content: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
  related_message_id?: number; // Link to the message that triggered this memory
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
  private hotData = new Map<string, MemoryRecord>(); // In-memory for active data
  private userIndex = new Map<string, Set<string>>(); // User ID -> Memory IDs
  private writeQueue = new AsyncQueue(); // Serialize writes
  private coldStorage?: any; // SQLite for persistence
  private maxHotMemories = 10000; // Keep most recent 10k in memory
  private syncInterval: NodeJS.Timeout;

  constructor(databasePath?: string) {
    if (databasePath) {
      this.initializeAsync().catch(error => {
        logger.warn('Failed to initialize SQLite, running in memory-only mode:', error);
      });
    }

    // Periodic sync every 30 seconds
    this.syncInterval = setInterval(() => {
      this.syncToStorage().catch(error => {
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
    if (!this.coldStorage) {return;}

    try {
      const rows = await this.coldStorage.all(`
        SELECT id, user_id, content, timestamp, metadata, related_message_id
        FROM memories
        ORDER BY timestamp DESC
        LIMIT ?
      `, this.maxHotMemories) as Array<{
        id: string;
        user_id: string;
        content: string;
        timestamp: string;
        metadata: string | null;
        related_message_id: number | null;
      }>;

      for (const row of rows) {
        const memory: MemoryRecord = {
          id: row.id,
          user_id: row.user_id,
          content: row.content,
          timestamp: new Date(row.timestamp),
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
          related_message_id: row.related_message_id || undefined
        };

        this.hotData.set(memory.id, memory);
        
        // Update user index
        if (!this.userIndex.has(memory.user_id)) {
          this.userIndex.set(memory.user_id, new Set());
        }
        this.userIndex.get(memory.user_id)!.add(memory.id);
      }

      logger.info(`✅ Loaded ${rows.length} recent memories into hot cache`);
    } catch (error) {
      logger.error('Failed to load recent memories:', error);
    }
  }

  /**
   * Store memory - instant hot cache write, async persistence
   */
  async storeMemory(memory: MemoryRecord): Promise<void> {
    // Immediate hot cache storage
    this.hotData.set(memory.id, memory);
    
    // Update user index
    if (!this.userIndex.has(memory.user_id)) {
      this.userIndex.set(memory.user_id, new Set());
    }
    this.userIndex.get(memory.user_id)!.add(memory.id);

    // Maintain hot cache size limit
    if (this.hotData.size > this.maxHotMemories) {
      this.evictOldestMemories();
    }

    // Async persistence (non-blocking)
    this.writeQueue.add(async () => {
      await this.persistMemory(memory);
    }).catch(error => {
      logger.error('Failed to persist memory:', error);
    });
  }

  /**
   * Get memory by ID - instant hot cache lookup
   */
  async getMemory(id: string): Promise<MemoryRecord | null> {
    const memory = this.hotData.get(id);
    if (memory) {
      return memory;
    }

    // If not in hot cache, try cold storage
    if (this.coldStorage) {
      try {
        const row = await this.coldStorage.get(`
          SELECT id, user_id, content, timestamp, metadata, related_message_id
          FROM memories WHERE id = ?
        `, id) as any;
        
        if (row) {
          const memory: MemoryRecord = {
            id: row.id,
            user_id: row.user_id,
            content: row.content,
            timestamp: new Date(row.timestamp),
            metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
            related_message_id: row.related_message_id || undefined
          };
          
          // Promote to hot cache
          this.hotData.set(id, memory);
          return memory;
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
      .map(id => this.hotData.get(id))
      .filter((memory): memory is MemoryRecord => memory !== undefined)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);

    // If we don't have enough in hot cache, check cold storage
    if (memories.length < limit && this.coldStorage) {
      try {
        const rows = await this.coldStorage.all(`
          SELECT id, user_id, content, timestamp, metadata, related_message_id
          FROM memories
          WHERE user_id = ?
          ORDER BY timestamp DESC
          LIMIT ?
        `, userId, limit) as Array<{
          id: string;
          user_id: string;
          content: string;
          timestamp: string;
          metadata: string | null;
          related_message_id: number | null;
        }>;

        const coldMemories = rows.map(row => ({
          id: row.id,
          user_id: row.user_id,
          content: row.content,
          timestamp: new Date(row.timestamp),
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
          related_message_id: row.related_message_id || undefined
        }));

        return coldMemories.slice(0, limit);
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
      .map(id => this.hotData.get(id))
      .filter((memory): memory is MemoryRecord => 
        memory !== undefined && 
        memory.content.toLowerCase().includes(query.toLowerCase())
      )
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);

    if (hotResults.length >= limit || !this.coldStorage) {
      return hotResults;
    }

    // Try FTS search in cold storage (only if query is not empty)
    if (query && query.trim().length > 0) {
      try {
        const rows = await this.coldStorage.all(`
          SELECT m.id, m.user_id, m.content, m.timestamp, m.metadata, m.related_message_id
          FROM memories_fts f
          JOIN memories m ON m.rowid = f.rowid
          WHERE f.content MATCH ? AND m.user_id = ?
          ORDER BY m.timestamp DESC
          LIMIT ?
        `, query.trim(), userId, limit) as Array<{
        id: string;
        user_id: string;
        content: string;
        timestamp: string;
        metadata: string | null;
        related_message_id: number | null;
      }>;

        return rows.map(row => ({
          id: row.id,
          user_id: row.user_id,
          content: row.content,
          timestamp: new Date(row.timestamp),
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
          related_message_id: row.related_message_id || undefined
        }));
      } catch (error) {
        logger.error('FTS search failed, falling back to hot cache results:', error);
      }
    }
    
    return hotResults;
  }

  /**
   * Persist memory to cold storage
   */
  private async persistMemory(memory: MemoryRecord): Promise<void> {
    if (!this.coldStorage) {return;}

    try {
      const result = await this.coldStorage.run(`
        INSERT INTO memories
        (user_id, content, tags, context, timestamp, importance, metadata, related_message_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
        memory.user_id,
        memory.content,
        JSON.stringify([]), // empty tags array as string
        '', // empty context
        memory.timestamp.toISOString(),
        5, // default importance
        memory.metadata ? JSON.stringify(memory.metadata) : '{}',
        memory.related_message_id || null
      );

      // Generate and store embedding asynchronously (non-blocking)
      if (result && result.lastInsertRowid) {
        this.generateEmbeddingForMemory(result.lastInsertRowid as number, memory.content).catch(err =>
          logger.warn(`Failed to generate embedding for memory ${result.lastInsertRowid}:`, err)
        );
      }
    } catch (error) {
      logger.error('Failed to persist memory to cold storage:', error);
      throw error;
    }
  }

  /**
   * Generate and store embedding for a memory (async, non-blocking)
   */
  private async generateEmbeddingForMemory(memoryId: number, content: string): Promise<void> {
    try {
      // Dynamic import to avoid circular dependencies
      const { vectorEmbeddingService } = await import('../services/vector-embeddings.js');

      if (!vectorEmbeddingService.isReady()) {
        await vectorEmbeddingService.initialize();
      }

      if (vectorEmbeddingService.isReady()) {
        const success = await vectorEmbeddingService.storeEmbedding(memoryId, content);
        if (success) {
          logger.debug(`🧠 Auto-generated embedding for memory #${memoryId}`);
        }
      }
    } catch (error) {
      // Silently fail - embeddings are optional enhancement
      logger.debug(`Embedding generation skipped for memory #${memoryId}`);
    }
  }

  /**
   * Evict oldest memories from hot cache
   */
  private evictOldestMemories(): void {
    const memories = Array.from(this.hotData.values())
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    
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
    if (!this.coldStorage) {return;}

    // This method can be enhanced to sync dirty flags, etc.
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<{ hotCacheSize: number; coldStorageConnected: boolean }> {
    return {
      hotCacheSize: this.hotData.size,
      coldStorageConnected: !!this.coldStorage
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