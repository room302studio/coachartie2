import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';
import { getDatabase } from '@coachartie/shared';

interface MemoryRow {
  id: number;
  content: string;
  user_id: string;
  created_at: string;
  content_hash: string;
  semantic_tags?: string;
  importance_score: number;
  tags?: string;
  context?: string;
  timestamp?: string;
  importance?: number;
}

interface MemoryParams {
  action: string;
  user_id?: string;
  query?: string;
  content?: string;
  limit?: string;
  [key: string]: unknown;
}

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
    if (this.dbReady) {return;}

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
      
      // Store memory first with basic tags
      const basicTags = this.extractBasicTags(content, context);
      const timestamp = new Date().toISOString();

      const result = await db.run(`
        INSERT INTO memories (user_id, content, tags, context, timestamp, importance)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [userId, content, JSON.stringify(basicTags), context, timestamp, importance]);

      const memoryId = result.lastID!;
      logger.info(`💾 Stored memory for user ${userId}: ${content.substring(0, 50)}...`);

      // Generate semantic tags asynchronously 
      this.generateSemanticTags(memoryId, content, context).catch(error => {
        logger.error('❌ Failed to generate semantic tags:', error);
      });
      
      return `✅ Remembered: "${content}" (ID: ${memoryId}, importance: ${importance}/10, tags: ${basicTags.join(', ')})`;
    } catch (error) {
      logger.error('❌ Failed to store memory:', error);
      throw new Error(`Failed to store memory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async recall(userId: string, query: string, limit: number = 5): Promise<string> {
    await this.initializeDatabase();

    try {
      const db = await getDatabase();
      
      // Build a fuzzy FTS query that's actually useful
      const cleanQuery = query.toLowerCase().trim();
      
      // Escape FTS5 special characters (dots, quotes, etc.)
      const escapeFTS5 = (text: string): string => {
        return text.replace(/[."]/g, '');  // Remove dots and quotes that break FTS5
      };
      
      // For single words, add fuzzy matching with wildcards
      const queryTerms = cleanQuery.split(/\s+/)
        .filter(term => term.length > 1)
        .map(term => escapeFTS5(term));
      
      const escapedCleanQuery = escapeFTS5(cleanQuery);
      
      // Create fuzzy query: exact matches first, then prefix matches
      let ftsQuery = '';
      if (queryTerms.length === 1) {
        // Single term: try exact, then prefix
        const term = queryTerms[0];
        ftsQuery = `"${term}" OR ${term}*`;
      } else {
        // Multiple terms: try exact phrase, then all terms, then any terms
        ftsQuery = `"${escapedCleanQuery}" OR (${queryTerms.join(' AND ')}) OR (${queryTerms.join(' OR ')})`;
      }
      
      logger.info(`🔍 Memory recall started - User: ${userId}, Query: "${query}"`);
      logger.info(`🔍 FTS query being used: "${ftsQuery}" (terms: ${queryTerms.join(', ')})`);
      
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
      `, [userId, ftsQuery, limit]);

      logger.info(`📊 FTS search results: ${searchResults.length} memories found`);
      if (searchResults.length > 0) {
        logger.info(`📊 FTS search results details:`, searchResults.map(r => ({
          id: r.id,
          content: r.content.substring(0, 50) + '...',
          relevance_score: r.relevance_score,
          importance: r.importance
        })));
      }

      // Fallback to partial matching if no FTS results
      if (searchResults.length === 0) {
        logger.info(`🔍 FTS found no results, trying partial match for each term: ${queryTerms.join(', ')}`);
        
        // Try each term separately in partial matching
        const fallbackQueries = queryTerms.map(term => {
          return db.all(`
            SELECT * FROM memories 
            WHERE user_id = ? 
            AND (content LIKE ? OR tags LIKE ? OR context LIKE ?)
            ORDER BY importance DESC, created_at DESC
          `, [userId, `%${term}%`, `%${term}%`, `%${term}%`]);
        });
        
        const allResults = await Promise.all(fallbackQueries);
        const flatResults = allResults.flat();
        
        logger.info(`📊 Partial match results: ${flatResults.length} total results (before deduplication)`);
        
        // Remove duplicates and limit
        const uniqueResults = Array.from(
          new Map(flatResults.map(r => [r.id, r])).values()
        ).slice(0, limit);
        
        logger.info(`📊 Partial match unique results: ${uniqueResults.length} memories after deduplication`);
        if (uniqueResults.length > 0) {
          logger.info(`📊 Partial match results details:`, uniqueResults.map(r => ({
            id: r.id,
            content: r.content.substring(0, 50) + '...',
            importance: r.importance
          })));
        }
        
        if (uniqueResults.length === 0) {
          const noResultsMessage = `🤔 No memories found for "${query}". Try a different search term or ask me to remember something first.`;
          logger.info(`🔍 Returning no results message: ${noResultsMessage}`);
          return noResultsMessage;
        }

        const formattedResult = this.formatRecallResults(uniqueResults, query, 'partial match');
        logger.info(`📝 Formatted partial match output length: ${formattedResult.length} characters`);
        logger.info(`📝 Formatted partial match output preview: ${formattedResult.substring(0, 200)}...`);
        return formattedResult;
      }

      const formattedResult = this.formatRecallResults(searchResults, query, 'full-text search');
      logger.info(`📝 Formatted FTS output length: ${formattedResult.length} characters`);
      logger.info(`📝 Formatted FTS output preview: ${formattedResult.substring(0, 200)}...`);
      return formattedResult;
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

      return results.map((row: MemoryRow) => ({
        id: row.id,
        userId: row.user_id,
        content: row.content,
        tags: JSON.parse(row.tags || '[]'),
        context: row.context || '',
        timestamp: row.timestamp || row.created_at,
        importance: row.importance || row.importance_score
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

  private extractBasicTags(content: string, _context: string): string[] {
    // Basic keyword extraction for immediate storage
    const words = content.toLowerCase().split(/\s+/);
    const basicTags = [];
    
    // Extract obvious content words (3+ letters, not common words)
    const commonWords = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'boy', 'did', 'man', 'end', 'few', 'got', 'lot', 'own', 'say', 'she', 'use', 'her', 'now', 'find', 'only', 'come', 'made', 'over', 'such', 'take', 'than', 'them', 'well', 'were', 'what', 'your', 'work', 'life', 'only', 'then', 'first', 'would', 'there', 'could', 'water', 'after', 'where', 'think', 'being', 'every', 'these', 'those', 'their', 'said', 'each', 'which', 'much', 'very', 'when', 'need', 'said', 'each', 'which', 'into', 'that', 'have', 'from', 'they', 'know', 'want', 'been', 'good', 'much', 'some', 'time', 'very', 'when', 'come', 'here', 'just', 'like', 'long', 'make', 'many', 'over', 'such', 'take', 'than', 'them', 'well', 'were']);
    
    for (const word of words) {
      if (word.length >= 3 && !commonWords.has(word) && /^[a-zA-Z]+$/.test(word)) {
        basicTags.push(word);
      }
    }
    
    return basicTags.slice(0, 5); // Limit to first 5 basic tags
  }

  private async generateSemanticTags(memoryId: number, content: string, context: string): Promise<void> {
    try {
      logger.info(`🏷️ Generating semantic tags for memory ${memoryId}: "${content.substring(0, 50)}..."`);
      
      const prompt = `Analyze this user memory and generate 3-8 semantic tags that would help find this memory later.

Memory: "${content}"
Context: "${context}"

Generate tags that capture:
- DOMAIN (food, music, work, travel, etc.)
- EMOTION (like, love, hate, prefer, etc.) 
- CATEGORY (specific type, genre, style, etc.)
- RELATIONS (family, friend, colleague, etc.)

Return ONLY a JSON array of lowercase tag strings, no other text.
Example: ["food", "pizza", "italian", "preference", "like"]`;

      const { openRouterService } = await import('../services/openrouter.js');
      const response = await openRouterService.generateResponse(prompt, 'mistralai/mistral-7b-instruct:free');

      // Parse the tags from LLM response
      const tags = this.parseTagsFromResponse(response);
      
      if (tags.length > 0) {
        // Update the memory with semantic tags
        await this.updateMemoryTags(memoryId, tags);
        logger.info(`🏷️ Added ${tags.length} semantic tags to memory ${memoryId}: ${tags.join(', ')}`);
      } else {
        logger.warn(`🏷️ No semantic tags generated for memory ${memoryId}`);
      }
    } catch (error) {
      logger.error(`❌ Failed to generate semantic tags for memory ${memoryId}:`, error);
    }
  }

  private parseTagsFromResponse(response: string): string[] {
    try {
      // Try to extract JSON array from response
      const jsonMatch = response.match(/\[.*?\]/);
      if (jsonMatch) {
        const tags = JSON.parse(jsonMatch[0]);
        if (Array.isArray(tags)) {
          return tags.filter(tag => typeof tag === 'string' && tag.length > 1).slice(0, 8);
        }
      }
    } catch (parseError) {
      // Don't crash the entire response for memory parsing failures
      logger.warn(`Memory tag parsing failed, continuing without tags: ${parseError}`);
      return [];
    }
    
    return [];
  }

  private async updateMemoryTags(memoryId: number, semanticTags: string[]): Promise<void> {
    try {
      const db = await getDatabase();
      
      // Get current tags
      const result = await db.get(`SELECT tags FROM memories WHERE id = ?`, [memoryId]);
      if (!result) {return;}
      
      const currentTags = JSON.parse(result.tags || '[]');
      const allTags = [...new Set([...currentTags, ...semanticTags])]; // Merge and dedupe
      
      // Update memory with combined tags
      await db.run(`UPDATE memories SET tags = ? WHERE id = ?`, [JSON.stringify(allTags), memoryId]);
      
    } catch (error) {
      logger.error(`❌ Failed to update tags for memory ${memoryId}:`, error);
    }
  }

  private formatRecallResults(results: MemoryRow[], query: string, searchType: string): string {
    logger.info(`🎨 Formatting ${results.length} recall results for query "${query}" using ${searchType}`);
    
    const formatted = results.map((memory, index) => {
      const tags = JSON.parse(memory.tags || '[]');
      const date = new Date(memory.created_at || memory.timestamp || '').toLocaleDateString();
      const importance = '⭐'.repeat(Math.min(memory.importance || 0, 5));
      
      const formattedEntry = `${index + 1}. **${memory.content}** ${importance}
   📅 ${date} | 🏷️ ${tags.join(', ') || 'no tags'}${memory.context ? ` | 📝 ${memory.context}` : ''}`;
      
      logger.info(`🎨 Formatted entry ${index + 1}: ${formattedEntry.substring(0, 100)}...`);
      
      return formattedEntry;
    }).join('\n\n');

    const finalOutput = `🧠 Recalled ${results.length} memories for "${query}" (${searchType}):

${formatted}

💡 Use these memories to provide context for your response!`;

    logger.info(`🎨 Final formatted output:
${finalOutput}`);

    return finalOutput;
  }
}

/**
 * Memory capability handler
 */
async function handleMemoryAction(params: MemoryParams, content?: string): Promise<string> {
  const { action, userId = 'unknown-user' } = params;
  const memoryService = MemoryService.getInstance();

  logger.info(`🎯 Memory handler called - Action: ${action}, UserId: ${userId}, Params:`, params);
  if (content) {
    logger.info(`🎯 Memory handler content: ${content.substring(0, 100)}...`);
  }

  try {
    switch (action) {
      case 'remember': {
        const contentToRemember = params.content || content;
        if (!contentToRemember) {
          throw new Error('No content provided to remember');
        }
        
        const context = String(params.context || '');
        const importance = Math.max(1, Math.min(10, parseInt(String(params.importance)) || 5));
        
        const result = await memoryService.remember(String(userId), String(contentToRemember), context, importance);
        logger.info(`🎯 Memory remember result: ${result}`);
        return result;
      }

      case 'recall':
      case 'search': {
        const query = params.query || content;
        if (!query) {
          throw new Error('No query provided for search');
        }
        
        logger.info(`🎯 Memory search starting - Query: "${query}"`);
        const limit = Math.max(1, Math.min(20, parseInt(String(params.limit)) || 5));
        const targetUserId = String(params.user || userId); // Allow searching other users if specified
        const result = await memoryService.recall(targetUserId, String(query), limit);
        logger.info(`🎯 Memory search completed - Result length: ${result.length} characters`);
        return result;
      }

      case 'stats': {
        return await memoryService.getMemoryStats(String(userId));
      }

      case 'recent': {
        const limit = Math.max(1, Math.min(20, parseInt(String(params.limit)) || 10));
        const memories = await memoryService.getRecentMemories(String(userId), limit);
        
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
  supportedActions: ['remember', 'recall', 'search', 'stats', 'recent'],
  description: 'Persistent memory system for storing and retrieving information across conversations',
  handler: handleMemoryAction,
  examples: [
    '<capability name="memory" action="remember" importance="8">Important user preference or fact</capability>',
    '<capability name="memory" action="search" query="chocolate preferences" />',
    '<capability name="memory" action="search" query="food" user="john" limit="3" />',
    '<capability name="memory" action="recall">search query for previous information</capability>',
    '<capability name="memory" action="stats" />',
    '<capability name="memory" action="recent" limit="5" />'
  ]
};