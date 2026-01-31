import { logger, getSyncDb } from '@coachartie/shared';
import { RegisteredCapability } from '../../services/capability/capability-registry.js';
import { hybridDataLayer, MemoryRecord } from '../../runtime/hybrid-data-layer.js';

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
  private useHybridLayer = true; // FLAG: Use high-performance hybrid layer
  public lastRecallMemoryIds: number[] = []; // 🔍 For debugging memory ID tracking

  static getInstance(): MemoryService {
    if (!MemoryService.instance) {
      MemoryService.instance = new MemoryService();
    }
    return MemoryService.instance;
  }

  // Legacy initializeDatabase deleted - hybrid layer handles schema

  async remember(
    userId: string,
    content: string,
    context: string = '',
    importance: number = 5,
    relatedMessageId?: number,
    explicitTags?: string[]
  ): Promise<string> {
    if (this.useHybridLayer) {
      // FAST PATH: Use hybrid data layer for instant storage + background persistence
      try {
        const basicTags = this.extractBasicTags(content, context);
        // Merge explicit tags with extracted tags (explicit tags first for priority)
        const allTags = explicitTags ? [...new Set([...explicitTags, ...basicTags])] : basicTags;

        const memory = {
          user_id: userId,
          content,
          tags: JSON.stringify(allTags),
          context,
          timestamp: new Date().toISOString(),
          importance,
          metadata: JSON.stringify({}),
          related_message_id: relatedMessageId ? String(relatedMessageId) : null,
        };

        // Instant hot cache storage + async SQLite persistence
        const memoryId = await hybridDataLayer.storeMemory(memory);

        logger.info(`💾 [HYBRID] Stored memory for user ${userId}: ${content.substring(0, 50)}...`);
        if (explicitTags && explicitTags.length > 0) {
          logger.info(`🏷️ [HYBRID] Explicit tags: ${explicitTags.join(', ')}`);
        }

        // Generate semantic tags asynchronously (non-blocking)
        this.generateSemanticTagsHybrid(memoryId, content, context).catch((error) => {
          logger.error('❌ Failed to generate semantic tags:', error);
        });

        const relationshipNote = relatedMessageId ? ` linked to message ${relatedMessageId}` : '';
        return `✅ Remembered: "${content}" (ID: ${memoryId}, importance: ${importance}/10, tags: ${allTags.join(', ')}${relationshipNote})`;
      } catch (error) {
        logger.error('❌ [HYBRID] Failed to store memory, falling back to legacy:', error);
        this.useHybridLayer = false; // Fallback to legacy
      }
    }

    // Legacy system removed - hybrid layer handles all memory operations
    throw new Error('Legacy memory system disabled - use hybrid layer');
  }

  async recall(userId: string, query: string, limit: number = 5): Promise<string> {
    if (this.useHybridLayer) {
      // FAST PATH: Use hybrid layer for instant search
      try {
        logger.info(`🔍 [HYBRID] Memory recall started - User: ${userId}, Query: "${query}"`);

        const memories = await hybridDataLayer.searchMemories(userId, query, limit);

        logger.info(`📊 [HYBRID] Search results: ${memories.length} memories found`);

        if (memories.length === 0) {
          return `🤔 No memories found for "${query}". Try a different search term or ask me to remember something first.`;
        }

        const formatted = this.formatHybridRecallResults(memories, query);
        // 🔍 Store memory IDs for debugging
        this.lastRecallMemoryIds = memories.map((m) => m.id);
        logger.info(`📝 [HYBRID] Formatted output length: ${formatted.length} characters`);
        logger.info(`🔍 [HYBRID] Memory IDs: [${this.lastRecallMemoryIds.join(', ')}]`);
        return formatted;
      } catch (error) {
        logger.error('❌ [HYBRID] Failed to recall memories:', error);
        throw new Error(
          `Memory recall failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Legacy system removed - hybrid layer is the only supported memory system
    throw new Error('Memory recall failed - hybrid layer disabled');
  }

  /**
   * Recall memories filtered by specific tags (for capability-specific retrieval)
   */
  async recallByTags(userId: string, tags: string[], limit: number = 5): Promise<MemoryEntry[]> {
    if (this.useHybridLayer) {
      try {
        logger.info(
          `🏷️ [HYBRID] Recalling memories with tags: ${tags.join(', ')} for user ${userId}`
        );

        const allMemories = await hybridDataLayer.getRecentMemories(userId, 1000);

        // Filter memories that have ANY of the requested tags
        const matchingMemories = allMemories.filter((memory) => {
          const memoryTags = memory.tags ? JSON.parse(memory.tags) : [];
          return tags.some((tag) => memoryTags.includes(tag));
        });

        logger.info(`📊 [HYBRID] Found ${matchingMemories.length} memories with matching tags`);

        // Sort by importance (descending) and take the limit
        const sortedMemories = matchingMemories
          .sort((a, b) => {
            const importanceA = a.importance || 5;
            const importanceB = b.importance || 5;
            return importanceB - importanceA;
          })
          .slice(0, limit);

        return sortedMemories.map((memory) => ({
          id: memory.id,
          userId: memory.user_id,
          content: memory.content,
          tags: memory.tags ? JSON.parse(memory.tags) : [],
          context: memory.context || '',
          timestamp: memory.timestamp,
          importance: memory.importance || 5,
        }));
      } catch (error) {
        logger.error('❌ [HYBRID] Failed to recall memories by tags:', error);
        return [];
      }
    }

    return [];
  }

  /**
   * Pin a memory by setting its importance to 10 (maximum)
   * Pinned memories are prioritized in retrieval
   */
  async pinMemory(userId: string, memoryId: number): Promise<string> {
    if (this.useHybridLayer) {
      try {
        logger.info(`📌 [HYBRID] Pinning memory ${memoryId} for user ${userId}`);

        const memory = await hybridDataLayer.getMemory(memoryId);

        if (!memory) {
          return `❌ Memory not found: ${memoryId}`;
        }

        // Security: Verify memory belongs to this user
        if (memory.user_id !== userId) {
          return `❌ Unauthorized: You can only pin your own memories`;
        }

        // Update importance to 10 (pinned)
        const updatedMemory = {
          ...memory,
          importance: 10,
        };

        await hybridDataLayer.updateMemory(updatedMemory);

        logger.info(`📌 [HYBRID] Successfully pinned memory ${memoryId}`);
        return `📌 Pinned memory: "${memory.content.substring(0, 50)}..." (now importance 10/10)`;
      } catch (error) {
        logger.error('❌ [HYBRID] Failed to pin memory:', error);
        return `❌ Failed to pin memory: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    return '❌ Hybrid layer disabled';
  }

  async getRecentMemories(userId: string, limit: number = 10): Promise<MemoryEntry[]> {
    if (this.useHybridLayer) {
      // FAST PATH: Use hybrid layer
      try {
        const memories = await hybridDataLayer.getRecentMemories(userId, limit);

        return memories.map((memory) => ({
          id: memory.id,
          userId: memory.user_id,
          content: memory.content,
          tags: memory.tags ? JSON.parse(memory.tags) : [],
          context: memory.context || '',
          timestamp: memory.timestamp,
          importance: memory.importance || 5,
        }));
      } catch (error) {
        logger.error('❌ [HYBRID] Failed to get recent memories:', error);
        throw error;
      }
    }

    // Legacy fallback removed
    return [];
  }

  async getMemoryStats(userId: string): Promise<string> {
    // Use hybrid layer for stats
    try {
      const recentMemories = await hybridDataLayer.getRecentMemories(userId, 1000);
      const totalCount = recentMemories.length;
      const recentCount = recentMemories.filter((m) => {
        const daysDiff = (Date.now() - new Date(m.timestamp).getTime()) / (1000 * 60 * 60 * 24);
        return daysDiff <= 7;
      }).length;

      return `📊 Memory Stats for ${userId}:
• Total memories: ${totalCount}
• Recent (7 days): ${recentCount}
• Storage: Hybrid layer (in-memory + SQLite)`;
    } catch (error) {
      throw new Error(
        `Could not retrieve memory statistics: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private extractBasicTags(content: string, _context: string): string[] {
    // Basic keyword extraction for immediate storage
    const words = content.toLowerCase().split(/\s+/);
    const basicTags = [];

    // Extract obvious content words (3+ letters, not common words)
    const commonWords = new Set([
      'the',
      'and',
      'for',
      'are',
      'but',
      'not',
      'you',
      'all',
      'can',
      'had',
      'her',
      'was',
      'one',
      'our',
      'out',
      'day',
      'get',
      'has',
      'him',
      'his',
      'how',
      'its',
      'may',
      'new',
      'now',
      'old',
      'see',
      'two',
      'way',
      'who',
      'boy',
      'did',
      'man',
      'end',
      'few',
      'got',
      'lot',
      'own',
      'say',
      'she',
      'use',
      'her',
      'now',
      'find',
      'only',
      'come',
      'made',
      'over',
      'such',
      'take',
      'than',
      'them',
      'well',
      'were',
      'what',
      'your',
      'work',
      'life',
      'only',
      'then',
      'first',
      'would',
      'there',
      'could',
      'water',
      'after',
      'where',
      'think',
      'being',
      'every',
      'these',
      'those',
      'their',
      'said',
      'each',
      'which',
      'much',
      'very',
      'when',
      'need',
      'said',
      'each',
      'which',
      'into',
      'that',
      'have',
      'from',
      'they',
      'know',
      'want',
      'been',
      'good',
      'much',
      'some',
      'time',
      'very',
      'when',
      'come',
      'here',
      'just',
      'like',
      'long',
      'make',
      'many',
      'over',
      'such',
      'take',
      'than',
      'them',
      'well',
      'were',
    ]);

    for (const word of words) {
      if (word.length >= 3 && !commonWords.has(word) && /^[a-zA-Z]+$/.test(word)) {
        basicTags.push(word);
      }
    }

    return basicTags.slice(0, 5); // Limit to first 5 basic tags
  }

  private formatHybridRecallResults(memories: MemoryRecord[], query: string): string {
    const formatted = memories
      .map((memory, index) => {
        const tags = memory.tags ? JSON.parse(memory.tags) : [];
        const context = memory.context || '';
        const importance = memory.importance || 5;

        const date = new Date(memory.timestamp).toLocaleDateString();
        const stars = '⭐'.repeat(Math.min(importance, 5));

        return `${index + 1}. **${memory.content}** ${stars}
   📅 ${date} | 🏷️ ${tags.join(', ') || 'no tags'}${context ? ` | 📝 ${context}` : ''}`;
      })
      .join('\n\n');

    return `🧠 Recalled ${memories.length} memories for "${query}" (hybrid search):

${formatted}

💡 Use these memories to provide context for your response!`;
  }

  private async generateSemanticTagsHybrid(
    memoryId: number,
    content: string,
    context: string
  ): Promise<void> {
    try {
      logger.info(
        `🏷️ [HYBRID] Generating semantic tags for memory ${memoryId}: "${content.substring(0, 50)}..."`
      );

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

      const { openRouterService } = await import('../../services/llm/openrouter.js');
      const { contextAlchemy } = await import('../../services/llm/context-alchemy.js');
      const { promptManager } = await import('../../services/llm/prompt-manager.js');

      const baseSystemPrompt = await promptManager.getCapabilityInstructions(prompt);
      const { messages } = await contextAlchemy.buildMessageChain(
        prompt,
        'memory-tagging-system',
        baseSystemPrompt
      );

      const response = await openRouterService.generateFromMessageChain(
        messages,
        'memory-tagging-system'
      );
      const tags = this.parseTagsFromResponse(response);

      if (tags.length > 0) {
        // Update memory in hybrid layer
        const memory = await hybridDataLayer.getMemory(memoryId);
        if (memory) {
          const existingTags = memory.tags ? JSON.parse(memory.tags) : [];
          const allTags = [...new Set([...existingTags, ...tags])];

          const updatedMemory = {
            ...memory,
            tags: JSON.stringify(allTags),
          };

          await hybridDataLayer.updateMemory(updatedMemory); // Update with new tags
          logger.info(
            `🏷️ [HYBRID] Added ${tags.length} semantic tags to memory ${memoryId}: ${tags.join(', ')}`
          );
        }
      }
    } catch (error) {
      logger.error(`❌ [HYBRID] Failed to generate semantic tags for memory ${memoryId}:`, error);
    }
  }

  private async generateSemanticTags(
    memoryId: number,
    content: string,
    context: string
  ): Promise<void> {
    try {
      logger.info(
        `🏷️ Generating semantic tags for memory ${memoryId}: "${content.substring(0, 50)}..."`
      );

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

      const { openRouterService } = await import('../../services/llm/openrouter.js');
      const { contextAlchemy } = await import('../../services/llm/context-alchemy.js');
      const { promptManager } = await import('../../services/llm/prompt-manager.js');

      const baseSystemPrompt = await promptManager.getCapabilityInstructions(prompt);
      const { messages } = await contextAlchemy.buildMessageChain(
        prompt,
        'memory-tagging-system',
        baseSystemPrompt
      );

      const response = await openRouterService.generateFromMessageChain(
        messages,
        'memory-tagging-system'
      );

      // Parse the tags from LLM response
      const tags = this.parseTagsFromResponse(response);

      if (tags.length > 0) {
        // Update the memory with semantic tags
        await this.updateMemoryTags(memoryId, tags);
        logger.info(
          `🏷️ Added ${tags.length} semantic tags to memory ${memoryId}: ${tags.join(', ')}`
        );
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
          return tags.filter((tag) => typeof tag === 'string' && tag.length > 1).slice(0, 8);
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
      const db = getSyncDb();

      // Get current tags
      const result = db.get<{ tags: string }>(`SELECT tags FROM memories WHERE id = ?`, [memoryId]);
      if (!result) {
        return;
      }

      const currentTags = JSON.parse(result.tags || '[]');
      const allTags = [...new Set([...currentTags, ...semanticTags])]; // Merge and dedupe

      // Update memory with combined tags
      db.run(`UPDATE memories SET tags = ? WHERE id = ?`, [JSON.stringify(allTags), memoryId]);
    } catch (error) {
      logger.error(`❌ Failed to update tags for memory ${memoryId}:`, error);
    }
  }

  private formatRecallResults(results: MemoryRow[], query: string, searchType: string): string {
    logger.info(
      `🎨 Formatting ${results.length} recall results for query "${query}" using ${searchType}`
    );

    const formatted = results
      .map((memory, index) => {
        const tags = JSON.parse(memory.tags || '[]');
        const date = new Date(memory.created_at || memory.timestamp || '').toLocaleDateString();
        const importance = '⭐'.repeat(Math.min(memory.importance || 0, 5));

        const formattedEntry = `${index + 1}. **${memory.content}** ${importance}
   📅 ${date} | 🏷️ ${tags.join(', ') || 'no tags'}${memory.context ? ` | 📝 ${memory.context}` : ''}`;

        logger.info(`🎨 Formatted entry ${index + 1}: ${formattedEntry.substring(0, 100)}...`);

        return formattedEntry;
      })
      .join('\n\n');

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

        // Get messageId from params (set by capability orchestrator)
        const relatedMessageId = params.messageId ? parseInt(String(params.messageId)) : undefined;

        const result = await memoryService.remember(
          String(userId),
          String(contentToRemember),
          context,
          importance,
          relatedMessageId
        );
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

        const formatted = memories
          .map((memory, index) => {
            const date = new Date(memory.timestamp).toLocaleDateString();
            const importance = '⭐'.repeat(Math.min(memory.importance, 5));
            const pinnedMark = memory.importance === 10 ? ' 📌' : '';
            return `${index + 1}. **${memory.content}** ${importance}${pinnedMark} (${date})`;
          })
          .join('\n');

        return `📚 Your ${memories.length} most recent memories:\n\n${formatted}`;
      }

      case 'pin': {
        const memoryId = params.memoryId || params.id || content;
        if (!memoryId) {
          throw new Error('No memory ID provided to pin. Use the memory ID from recall results.');
        }

        logger.info(`📌 Pinning memory ${memoryId} for user ${userId}`);
        const result = await memoryService.pinMemory(String(userId), parseInt(String(memoryId)));
        logger.info(`📌 Pin result: ${result}`);
        return result;
      }

      default:
        throw new Error(
          `Unknown memory action: ${action}. Supported actions: remember, recall, search, stats, recent, pin`
        );
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
  emoji: '🧠',
  supportedActions: ['remember', 'recall', 'search', 'stats', 'recent', 'pin'],
  description:
    'Persistent memory system for storing and retrieving information across conversations. Use "pin" action to mark important tool learnings (sets importance to 10).',
  handler: handleMemoryAction,
  examples: [
    '<capability name="memory" action="remember" importance="8">Important user preference or fact</capability>',
    '<capability name="memory" action="search" query="chocolate preferences" />',
    '<capability name="memory" action="search" query="food" user="john" limit="3" />',
    '<capability name="memory" action="recall">search query for previous information</capability>',
    '<capability name="memory" action="stats" />',
    '<capability name="memory" action="recent" limit="5" />',
    '<capability name="memory" action="pin" memoryId="abc123">Pin an important tool learning from recent memories</capability>',
  ],
};
