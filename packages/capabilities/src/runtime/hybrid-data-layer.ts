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
 * Direct Database Layer - 4 ways to find shit, Google-style
 */
export class HybridDataLayer {
  private db?: any;

  constructor(databasePath?: string) {
    this.initializeAsync().catch(error => {
      logger.error('Failed to initialize database:', error);
    });
    
    logger.info(`✅ Direct Database Layer initialized`);
  }

  private async initializeAsync(): Promise<void> {
    try {
      this.db = await getDatabase();
      await this.initializeDatabase();
      
      const countResult = await this.db.get('SELECT COUNT(*) as count FROM memories');
      logger.info(`✅ Database connected with ${countResult.count} total memories`);
    } catch (error) {
      logger.error('Failed to initialize database:', error);
      throw error;
    }
  }

  private async initializeDatabase(): Promise<void> {
    if (!this.db) return;

    try {
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      `);
      
      logger.info('✅ SQLite database schema initialized');
    } catch (error) {
      logger.debug('Database schema already exists');
    }
  }

  async storeMemory(memory: MemoryRecord): Promise<void> {
    if (!this.db) {
      logger.error('Database not initialized');
      return;
    }

    try {
      const tags = memory.metadata?.tags ? JSON.stringify(memory.metadata.tags) : '[]';
      const context = memory.metadata?.context as string || '';
      const importance = memory.metadata?.importance as number || 5;
      
      logger.info(`💾 [HYBRID] Stored memory for user ${memory.user_id}: ${memory.content.substring(0, 50)}...`);
      
      const result = await this.db.run(`
        INSERT INTO memories 
        (user_id, content, tags, context, timestamp, importance, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, 
        memory.user_id,
        memory.content,
        tags,
        context,
        memory.timestamp.toISOString(),
        importance,
        memory.metadata ? JSON.stringify(memory.metadata) : '{}'
      );

      if (result.lastID) {
        memory.id = String(result.lastID);
      }
    } catch (error) {
      logger.error('Failed to store memory:', error);
      throw error;
    }
  }

  async getMemory(id: string): Promise<MemoryRecord | null> {
    if (!this.db) return null;

    try {
      const row = await this.db.get(`
        SELECT id, user_id, content, timestamp, metadata 
        FROM memories WHERE id = ?
      `, id);
      
      if (row) {
        return {
          id: String(row.id),
          user_id: row.user_id,
          content: row.content,
          timestamp: new Date(row.timestamp),
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined
        };
      }
    } catch (error) {
      logger.error('Failed to get memory:', error);
    }

    return null;
  }

  async getRecentMemories(userId: string, limit = 10): Promise<MemoryRecord[]> {
    if (!this.db) return [];

    try {
      const rows = await this.db.all(`
        SELECT id, user_id, content, timestamp, metadata 
        FROM memories 
        WHERE user_id = ? 
        ORDER BY timestamp DESC 
        LIMIT ?
      `, userId, limit);

      return rows.map((row: any) => ({
        id: String(row.id),
        user_id: row.user_id,
        content: row.content,
        timestamp: new Date(row.timestamp),
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined
      }));
    } catch (error) {
      logger.error('Failed to get recent memories:', error);
      return [];
    }
  }

  /**
   * GOOGLE-STYLE SEARCH: 4 WAYS TO FIND YOUR SHIT
   */
  async searchMemories(userId: string, query: string, limit = 10): Promise<MemoryRecord[]> {
    if (!this.db) return [];

    logger.info(`🔍 [HYBRID] Memory recall started - User: ${userId}, Query: "${query}"`);
    
    // Combine results from all 4 search methods
    const allResults = new Map<string, MemoryRecord>();
    
    try {
      // METHOD 1: EXACT PHRASE MATCH (highest priority)
      const exactRows = await this.db.all(`
        SELECT id, user_id, content, timestamp, metadata
        FROM memories 
        WHERE user_id = ? 
        AND LOWER(content) LIKE LOWER(?)
        ORDER BY timestamp DESC
        LIMIT ?
      `, userId, `%${query}%`, limit);
      
      exactRows.forEach((row: any) => {
        allResults.set(String(row.id), {
          id: String(row.id),
          user_id: row.user_id,
          content: row.content,
          timestamp: new Date(row.timestamp),
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined
        });
      });
      
      // METHOD 2: ALL WORDS MUST APPEAR (AND search)
      const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      if (words.length > 0) {
        const andConditions = words.map(() => 'LOWER(content) LIKE ?').join(' AND ');
        const andParams = [userId, ...words.map(w => `%${w}%`), limit];
        
        const andRows = await this.db.all(`
          SELECT id, user_id, content, timestamp, metadata
          FROM memories 
          WHERE user_id = ? 
          AND (${andConditions})
          ORDER BY timestamp DESC
          LIMIT ?
        `, ...andParams);
        
        andRows.forEach((row: any) => {
          if (!allResults.has(String(row.id))) {
            allResults.set(String(row.id), {
              id: String(row.id),
              user_id: row.user_id,
              content: row.content,
              timestamp: new Date(row.timestamp),
              metadata: row.metadata ? JSON.parse(row.metadata) : undefined
            });
          }
        });
      }
      
      // METHOD 3: ANY WORD MATCHES (OR search)
      if (words.length > 0) {
        const orConditions = words.map(() => 'LOWER(content) LIKE ?').join(' OR ');
        const orParams = [userId, ...words.map(w => `%${w}%`), limit];
        
        const orRows = await this.db.all(`
          SELECT id, user_id, content, timestamp, metadata
          FROM memories 
          WHERE user_id = ? 
          AND (${orConditions})
          ORDER BY timestamp DESC
          LIMIT ?
        `, ...orParams);
        
        orRows.forEach((row: any) => {
          if (!allResults.has(String(row.id))) {
            allResults.set(String(row.id), {
              id: String(row.id),
              user_id: row.user_id,
              content: row.content,
              timestamp: new Date(row.timestamp),
              metadata: row.metadata ? JSON.parse(row.metadata) : undefined
            });
          }
        });
      }
      
      // METHOD 4: FUZZY MATCH - just the first/last significant words
      if (words.length > 0) {
        const significantWords = [words[0], words[words.length - 1]].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
        const fuzzyConditions = significantWords.map(() => 'LOWER(content) LIKE ?').join(' OR ');
        const fuzzyParams = [userId, ...significantWords.map(w => `%${w}%`), limit];
        
        const fuzzyRows = await this.db.all(`
          SELECT id, user_id, content, timestamp, metadata
          FROM memories 
          WHERE user_id = ? 
          AND (${fuzzyConditions})
          ORDER BY timestamp DESC
          LIMIT ?
        `, ...fuzzyParams);
        
        fuzzyRows.forEach((row: any) => {
          if (!allResults.has(String(row.id))) {
            allResults.set(String(row.id), {
              id: String(row.id),
              user_id: row.user_id,
              content: row.content,
              timestamp: new Date(row.timestamp),
              metadata: row.metadata ? JSON.parse(row.metadata) : undefined
            });
          }
        });
      }
      
      const results = Array.from(allResults.values()).slice(0, limit);
      logger.info(`📊 [HYBRID] Search results: ${results.length} memories found`);
      return results;
      
    } catch (error) {
      logger.error('Memory search failed:', error);
      logger.info(`📊 [HYBRID] Search results: 0 memories found`);
      return [];
    }
  }

  async healthCheck(): Promise<{ hotCacheSize: number; coldStorageConnected: boolean }> {
    return {
      hotCacheSize: 0,
      coldStorageConnected: !!this.db
    };
  }

  async cleanup(): Promise<void> {
    if (this.db) {
      await this.db.close();
    }
    logger.info('Database Layer cleaned up');
  }
}

// Singleton instance
export const hybridDataLayer = new HybridDataLayer(
  process.env.DATABASE_PATH || '/Users/ejfox/code/coachartie2/data/coachartie.db'
);