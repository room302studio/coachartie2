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
      await this.initializeDatabase();
      await this.loadRecentMemories();
    } catch (error) {
      logger.error('Failed to initialize database:', error);
      throw error;
    }
  }

  /**
   * Initialize SQLite database schema
   */
  private async initializeDatabase(): Promise<void> {
    if (!this.coldStorage) return;

    try {
      await this.coldStorage.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          content TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          metadata TEXT DEFAULT '{}',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          tags TEXT NOT NULL DEFAULT '[]',
          context TEXT DEFAULT '',
          importance INTEGER DEFAULT 5,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);
        CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
        CREATE INDEX IF NOT EXISTS idx_memories_user_timestamp ON memories(user_id, timestamp DESC);
        
        -- FTS for search (compatible with legacy schema)
        -- Note: Skip FTS setup to avoid trigger conflicts with existing schema
      `);
      
      logger.info('✅ SQLite database schema initialized');
    } catch (error) {
      logger.error('Failed to initialize database schema:', error);
      throw error;
    }
  }

  /**
   * Load recent memories into hot cache
   */
  private async loadRecentMemories(): Promise<void> {
    if (!this.coldStorage) return;

    try {
      const rows = await this.coldStorage.all(`
        SELECT id, user_id, content, timestamp, metadata 
        FROM memories 
        ORDER BY timestamp DESC 
        LIMIT ?
      `, this.maxHotMemories) as Array<{
        id: string;
        user_id: string;
        content: string;
        timestamp: string;
        metadata: string | null;
      }>;

      for (const row of rows) {
        const memory: MemoryRecord = {
          id: String(row.id), // Convert INTEGER id to string for consistency
          user_id: row.user_id,
          content: row.content,
          timestamp: new Date(row.timestamp),
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined
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
          SELECT id, user_id, content, timestamp, metadata 
          FROM memories WHERE id = ?
        `, id) as any;
        
        if (row) {
          const memory: MemoryRecord = {
            id: String(row.id), // Convert INTEGER id to string for consistency
            user_id: row.user_id,
            content: row.content,
            timestamp: new Date(row.timestamp),
            metadata: row.metadata ? JSON.parse(row.metadata) : undefined
          };
          
          // Promote to hot cache
          this.hotData.set(String(row.id), memory);
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
          SELECT id, user_id, content, timestamp, metadata 
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
        }>;

        const coldMemories = rows.map(row => ({
          id: String(row.id), // Convert INTEGER id to string for consistency
          user_id: row.user_id,
          content: row.content,
          timestamp: new Date(row.timestamp),
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined
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
    // Get user's memories
    const userMemoryIds = this.userIndex.get(userId) || new Set();
    
    // Parse query into searchable words (skip short words)
    const queryWords = query.toLowerCase().split(/\s+/).filter(word => word.length > 2);
    if (queryWords.length === 0) return []; // Nothing to search
    
    // Search hot cache
    const hotResults = Array.from(userMemoryIds)
      .map(id => this.hotData.get(id))
      .filter((memory): memory is MemoryRecord => {
        if (!memory) return false;
        // Check if ANY query word appears in content
        const content = memory.content.toLowerCase();
        return queryWords.some(word => content.includes(word));
      })
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
    
    logger.info(`🔍 Search "${query}" found ${hotResults.length}/${limit} in cache`);

    if (hotResults.length >= limit || !this.coldStorage) {
      return hotResults;
    }

    // Fall back to cold storage if needed
    try {
      // Build WHERE clause for word matching
      const wordConditions = queryWords
        .map(() => 'LOWER(content) LIKE ?')
        .join(' OR ');
      
      const params = [
        userId,
        ...queryWords.map(word => `%${word}%`),
        limit - hotResults.length
      ];
      
      const rows = await this.coldStorage.all(`
        SELECT id, user_id, content, timestamp, metadata
        FROM memories 
        WHERE user_id = ? 
        AND (${wordConditions})
        ORDER BY timestamp DESC
        LIMIT ?
      `, ...params) as Array<{
        id: string;
        user_id: string;
        content: string;
        timestamp: string;
        metadata: string | null;
      }>;

      // Convert and merge results (deduped by id)
      const existingIds = new Set(hotResults.map(m => m.id));
      const coldResults = rows
        .filter(row => !existingIds.has(String(row.id)))
        .map(row => ({
          id: String(row.id),
          user_id: row.user_id,
          content: row.content,
          timestamp: new Date(row.timestamp),
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined
        }));

      return [...hotResults, ...coldResults].slice(0, limit);
    } catch (error) {
      logger.error('Cold storage search failed, falling back to hot cache results:', error);
      return hotResults;
    }
  }

  /**
   * Persist memory to cold storage
   */
  private async persistMemory(memory: MemoryRecord): Promise<void> {
    if (!this.coldStorage) return;

    try {
      // Handle schema mismatch: legacy schema uses INTEGER id, hybrid uses TEXT uuid
      // Insert without specifying id (let SQLite auto-increment), then update our memory record
      const tags = memory.metadata?.tags ? JSON.stringify(memory.metadata.tags) : '[]';
      const context = memory.metadata?.context as string || '';
      const importance = memory.metadata?.importance as number || 5;
      
      logger.info(`🔍 Persisting memory - user_id: ${memory.user_id}, content: ${memory.content.substring(0, 50)}..., tags: ${tags}, context: ${context}, timestamp: ${memory.timestamp.toISOString()}, importance: ${importance}`);
      
      // Log the parameters as an array to see exactly what's being passed
      const params = [
        memory.user_id,
        memory.content,
        tags,
        context,
        memory.timestamp.toISOString(),
        importance,
        memory.metadata ? JSON.stringify(memory.metadata) : '{}'
      ];
      logger.info(`🔍 SQL parameters:`, params);
      
      logger.info(`🔍 About to execute INSERT statement with ${params.length} parameters`);
      const result = await this.coldStorage.run(`
        INSERT INTO memories 
        (user_id, content, tags, context, timestamp, importance, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, ...params);
      logger.info(`✅ INSERT successful, lastID: ${result.lastID}`);

      // Update our in-memory record to use the SQLite-generated ID
      if (result.lastID) {
        const oldId = memory.id;
        const newId = String(result.lastID);
        
        // Update hot cache with new ID
        this.hotData.delete(oldId);
        memory.id = newId;
        this.hotData.set(newId, memory);
        
        // Update user index
        const userSet = this.userIndex.get(memory.user_id);
        if (userSet) {
          userSet.delete(oldId);
          userSet.add(newId);
        }
        
        logger.debug(`✅ Persisted memory with SQLite ID: ${newId} (was UUID: ${oldId})`);
      }
    } catch (error) {
      logger.error('Failed to persist memory to cold storage:', error);
      throw error;
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
    if (!this.coldStorage) return;

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
  process.env.DATABASE_PATH || '/Users/ejfox/code/coachartie2/data/coachartie.db'
);