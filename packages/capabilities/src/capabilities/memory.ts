import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';
import { getDatabase } from '@coachartie/shared';

/**
 * Real Memory Capability - Persistent storage and retrieval
 * 
 * This provides actual memory functionality using SQLite database
 * to store and retrieve information across conversations.
 */

interface MemoryEntry {
  id?: number;
  userId: string;
  content: string;
  tags: string[];
  context: string;
  timestamp: string;
  importance: number; // 1-10 scale
}

export class MemoryService {
  private static instance: MemoryService;
  private dbReady = false;

  static getInstance(): MemoryService {
    if (!MemoryService.instance) {
      MemoryService.instance = new MemoryService();
    }
    return MemoryService.instance;
  }

  async initializeDatabase(): Promise<void> {
    if (this.dbReady) return;

    try {
      const db = await getDatabase();
      
      // Create memories table
      await db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          content TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '[]',
          context TEXT DEFAULT '',
          timestamp TEXT NOT NULL,
          importance INTEGER DEFAULT 5,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create indexes for fast searching
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);
        CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
        CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
      `);

      // Create full-text search table for content
      await db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          content, tags, context,
          content='memories',
          content_rowid='id'
        );
      `);

      // Create triggers to keep FTS table in sync
      await db.exec(`
        CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content, tags, context) 
          VALUES (new.id, new.content, new.tags, new.context);
        END;

        CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, tags, context) 
          VALUES ('delete', old.id, old.content, old.tags, old.context);
        END;

        CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, tags, context) 
          VALUES ('delete', old.id, old.content, old.tags, old.context);
          INSERT INTO memories_fts(rowid, content, tags, context) 
          VALUES (new.id, new.content, new.tags, new.context);
        END;
      `);

      this.dbReady = true;
      logger.info('✅ Memory database initialized successfully');
    } catch (error) {
      logger.error('❌ Failed to initialize memory database:', error);
      throw error;
    }
  }

  async remember(userId: string, content: string, context: string = '', importance: number = 5): Promise<string> {
    await this.initializeDatabase();

    try {
      const db = await getDatabase();
      
      // Extract tags from content (simple keyword extraction)
      const tags = this.extractTags(content, context);
      const timestamp = new Date().toISOString();

      const result = await db.run(`
        INSERT INTO memories (user_id, content, tags, context, timestamp, importance)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [userId, content, JSON.stringify(tags), context, timestamp, importance]);

      logger.info(`💾 Stored memory for user ${userId}: ${content.substring(0, 50)}...`);
      
      return `✅ Remembered: "${content}" (ID: ${result.lastID}, importance: ${importance}/10, tags: ${tags.join(', ')})`;
    } catch (error) {
      logger.error('❌ Failed to store memory:', error);
      throw new Error(`Failed to store memory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async recall(userId: string, query: string, limit: number = 5): Promise<string> {
    await this.initializeDatabase();

    try {
      const db = await getDatabase();
      
      // Use full-text search for better matching
      const searchResults = await db.all(`
        SELECT m.*, 
               memories_fts.rank as relevance_score
        FROM memories m
        JOIN memories_fts ON m.id = memories_fts.rowid
        WHERE m.user_id = ? 
        AND memories_fts MATCH ?
        ORDER BY relevance_score, m.importance DESC, m.created_at DESC
        LIMIT ?
      `, [userId, query, limit]);

      // Fallback to partial matching if no FTS results
      if (searchResults.length === 0) {
        const fallbackResults = await db.all(`
          SELECT * FROM memories 
          WHERE user_id = ? 
          AND (content LIKE ? OR tags LIKE ? OR context LIKE ?)
          ORDER BY importance DESC, created_at DESC
          LIMIT ?
        `, [userId, `%${query}%`, `%${query}%`, `%${query}%`, limit]);

        if (fallbackResults.length === 0) {
          return `🤔 No memories found for "${query}". Try a different search term or ask me to remember something first.`;
        }

        return this.formatRecallResults(fallbackResults, query, 'partial match');
      }

      return this.formatRecallResults(searchResults, query, 'full-text search');
    } catch (error) {
      logger.error('❌ Failed to recall memories:', error);
      throw new Error(`Failed to recall memories: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getRecentMemories(userId: string, limit: number = 10): Promise<MemoryEntry[]> {
    await this.initializeDatabase();

    try {
      const db = await getDatabase();
      
      const results = await db.all(`
        SELECT * FROM memories 
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `, [userId, limit]);

      return results.map((row: any) => ({
        id: row.id,
        userId: row.user_id,
        content: row.content,
        tags: JSON.parse(row.tags || '[]'),
        context: row.context,
        timestamp: row.timestamp,
        importance: row.importance
      }));
    } catch (error) {
      logger.error('❌ Failed to get recent memories:', error);
      return [];
    }
  }

  async getMemoryStats(userId: string): Promise<string> {
    await this.initializeDatabase();

    try {
      const db = await getDatabase();
      
      const stats = await db.get(`
        SELECT 
          COUNT(*) as total_memories,
          AVG(importance) as avg_importance,
          MAX(created_at) as last_memory,
          MIN(created_at) as first_memory
        FROM memories 
        WHERE user_id = ?
      `, [userId]);

      const recentCount = await db.get(`
        SELECT COUNT(*) as recent_count
        FROM memories 
        WHERE user_id = ? 
        AND created_at > datetime('now', '-7 days')
      `, [userId]);

      return `📊 Memory Stats for ${userId}:
• Total memories: ${stats.total_memories}
• Recent (7 days): ${recentCount.recent_count}
• Average importance: ${stats.avg_importance ? stats.avg_importance.toFixed(1) : 'N/A'}/10
• First memory: ${stats.first_memory ? new Date(stats.first_memory).toLocaleDateString() : 'None'}
• Latest memory: ${stats.last_memory ? new Date(stats.last_memory).toLocaleDateString() : 'None'}`;
    } catch (error) {
      logger.error('❌ Failed to get memory stats:', error);
      return `❌ Could not retrieve memory statistics: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private extractTags(content: string, context: string): string[] {
    const text = `${content} ${context}`.toLowerCase();
    const tags: string[] = [];

    // Extract common themes and keywords
    const patterns = {
      weather: /weather|temperature|forecast|rain|snow|sunny|cloudy/g,
      calculation: /math|calculate|equation|formula|number|result/g,
      installation: /install|setup|configure|deploy|create|build/g,
      file: /file|folder|directory|path|save|load/g,
      memory: /remember|recall|memory|note|important/g,
      schedule: /schedule|remind|timer|alarm|later|time/g,
      search: /search|find|lookup|google|web/g,
      mcp: /mcp|server|capability|template|service/g
    };

    for (const [tag, pattern] of Object.entries(patterns)) {
      if (pattern.test(text)) {
        tags.push(tag);
      }
    }

    // Extract any explicit hashtags or @mentions
    const hashtags = text.match(/#\w+/g);
    if (hashtags) {
      tags.push(...hashtags.map(tag => tag.substring(1)));
    }

    // Extract important nouns (simple approach)
    const importantWords = text.match(/\b[a-z]{4,}\b/g);
    if (importantWords) {
      const filtered = importantWords
        .filter(word => !['that', 'this', 'with', 'from', 'have', 'been', 'they', 'were', 'said', 'each', 'which', 'their', 'time', 'will', 'about', 'would', 'there', 'could', 'other', 'more', 'very', 'what', 'know', 'just', 'first', 'year', 'work', 'such', 'make', 'even', 'also', 'many'].includes(word))
        .slice(0, 3); // Max 3 noun tags
      tags.push(...filtered);
    }

    return [...new Set(tags)]; // Remove duplicates
  }

  private formatRecallResults(results: any[], query: string, searchType: string): string {
    const formatted = results.map((memory, index) => {
      const tags = JSON.parse(memory.tags || '[]');
      const date = new Date(memory.created_at || memory.timestamp).toLocaleDateString();
      const importance = '⭐'.repeat(Math.min(memory.importance || 0, 5));
      
      return `${index + 1}. **${memory.content}** ${importance}
   📅 ${date} | 🏷️ ${tags.join(', ') || 'no tags'}${memory.context ? ` | 📝 ${memory.context}` : ''}`;
    }).join('\n\n');

    return `🧠 Recalled ${results.length} memories for "${query}" (${searchType}):

${formatted}

💡 Use these memories to provide context for your response!`;
  }
}

/**
 * Memory capability handler
 */
async function handleMemoryAction(params: Record<string, any>, content?: string): Promise<string> {
  const { action, userId = 'unknown-user' } = params;
  const memoryService = MemoryService.getInstance();

  try {
    switch (action) {
      case 'remember': {
        const contentToRemember = params.content || content;
        if (!contentToRemember) {
          throw new Error('No content provided to remember');
        }
        
        const context = params.context || '';
        const importance = Math.max(1, Math.min(10, parseInt(params.importance) || 5));
        
        return await memoryService.remember(userId, contentToRemember, context, importance);
      }

      case 'recall': {
        const query = params.query || content;
        if (!query) {
          throw new Error('No query provided for recall');
        }
        
        const limit = Math.max(1, Math.min(20, parseInt(params.limit) || 5));
        return await memoryService.recall(userId, query, limit);
      }

      case 'stats': {
        return await memoryService.getMemoryStats(userId);
      }

      case 'recent': {
        const limit = Math.max(1, Math.min(20, parseInt(params.limit) || 10));
        const memories = await memoryService.getRecentMemories(userId, limit);
        
        if (memories.length === 0) {
          return '📭 No recent memories found. Start remembering things to build your memory!';
        }

        const formatted = memories.map((memory, index) => {
          const date = new Date(memory.timestamp).toLocaleDateString();
          const importance = '⭐'.repeat(Math.min(memory.importance, 5));
          return `${index + 1}. **${memory.content}** ${importance} (${date})`;
        }).join('\n');

        return `📚 Your ${memories.length} most recent memories:\n\n${formatted}`;
      }

      default:
        throw new Error(`Unknown memory action: ${action}. Supported actions: remember, recall, stats, recent`);
    }
  } catch (error) {
    logger.error(`Memory capability error for action '${action}':`, error);
    throw error;
  }
}

/**
 * Memory capability definition with real persistence
 */
export const memoryCapability: RegisteredCapability = {
  name: 'memory',
  supportedActions: ['remember', 'recall', 'stats', 'recent'],
  description: 'Persistent memory system for storing and retrieving information across conversations',
  handler: handleMemoryAction,
  examples: [
    '<capability name="memory" action="remember" importance="8">Important user preference or fact</capability>',
    '<capability name="memory" action="recall">search query for previous information</capability>',
    '<capability name="memory" action="stats" />',
    '<capability name="memory" action="recent" limit="5" />'
  ]
};