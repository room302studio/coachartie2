import { getSyncDb } from '../../shared/db/client.js';
import { logger } from '../../shared/logger.js';
import { stripUserMessagePlaceholder } from './prompt-cache.js';

/** Base prompt when the DB has no PROMPT_SYSTEM row (native mode; tests, a fresh DB). */
const NATIVE_FALLBACK_BASE_PROMPT =
  'You are Coach Artie, an assistant who hangs out on Discord and helps people with whatever they need.';

export interface PromptTemplate {
  id?: number;
  name: string;
  version: number;
  content: string;
  description?: string;
  category: string;
  isActive: boolean;
  metadata: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

interface DatabaseRow {
  id: number;
  name: string;
  version: number;
  content: string;
  description?: string;
  category: string;
  is_active: number;
  metadata: string | Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface _PromptHistoryRow extends DatabaseRow {
  // Additional fields specific to history if any
}

class PromptStore {
  private cache = new Map<string, PromptTemplate>();
  private cacheTimestamps = new Map<string, number>();
  private cacheExpiryMs = 30000; // 30 seconds cache
  private lastCacheUpdate = 0;

  /**
   * Get prompt by name with hot-reloading support 🔥
   */
  async getPrompt(name: string, forceRefresh = false): Promise<PromptTemplate | null> {
    const cacheKey = `prompt:${name}`;
    const now = Date.now();
    const lastUpdate = this.cacheTimestamps.get(cacheKey) || 0;

    // Check cache first (unless force refresh)
    if (!forceRefresh && this.cache.has(cacheKey) && now - lastUpdate < this.cacheExpiryMs) {
      return this.cache.get(cacheKey) || null;
    }

    try {
      const db = getSyncDb();
      const row = db.get(
        `SELECT * FROM prompts 
         WHERE name = ? AND is_active = 1 
         ORDER BY version DESC LIMIT 1`,
        [name]
      );

      if (!row) {
        // Not a warning - prompts are optional and have fallbacks
        logger.debug(`Prompt '${name}' not in database, using fallback`);
        return null;
      }

      let metadata: any;
      if (typeof row.metadata === 'string') {
        metadata = JSON.parse(row.metadata);
      } else {
        metadata = row.metadata;
      }

      const prompt: PromptTemplate = {
        id: row.id,
        name: row.name,
        version: row.version,
        content: row.content,
        description: row.description,
        category: row.category,
        isActive: Boolean(row.is_active),
        metadata,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };

      // Update cache
      this.cache.set(cacheKey, prompt);
      this.cacheTimestamps.set(cacheKey, now);

      return prompt;
    } catch (error) {
      logger.error(`❌ Failed to get prompt '${name}':`, error);
      throw error;
    }
  }

  /**
   * Get capability instructions - DB first, registry fallback 🚀
   */
  async getCapabilityInstructions(_userMessage: string): Promise<string> {
    try {
      // First, try to get the rich system prompt
      logger.info(`🔍 Attempting to load rich system prompt from database`);
      const systemPrompt = await this.getPrompt('PROMPT_SYSTEM');
      if (systemPrompt) {
        // Never substitute the user message here: this text becomes the cached system prefix,
        // and a per-request byte in it means no cache hit ever (see prompt-cache.ts).
        const instructions = stripUserMessagePlaceholder(systemPrompt.content);

        // Tools describe themselves on the wire, so no format teaching and no roster.
        // assemble.ts strips any XML teaching left in the DB prompts and adds the one native line.
        logger.info(`🎯 Using rich PROMPT_SYSTEM from database (v${systemPrompt.version}), native tools`);
        return instructions;
      } else {
        // Fallback to basic capability instructions
        logger.warn(`⚠️ Rich system prompt not found, trying capability_instructions`);
        const dbPrompt = await this.getPrompt('capability_instructions');
        if (dbPrompt) {
          const instructions = stripUserMessagePlaceholder(dbPrompt.content);
          logger.info(
            `🎯 Using basic capability instructions from database (v${dbPrompt.version})`
          );
          return instructions;
        }
      }
    } catch (error) {
      logger.warn(`⚠️ Failed to load DB prompts, falling back to registry:`, error);
    }

    // The tool list rides on the request, so there is no selector or roster to build.
    logger.warn('⚠️ No PROMPT_SYSTEM or capability_instructions in the DB; using the minimal native base prompt');
    return NATIVE_FALLBACK_BASE_PROMPT;
  }

  /**
   * Update prompt content (creates new version) ✨
   */
  async updatePrompt(
    name: string,
    content: string,
    _changedBy = 'system',
    _changeReason = 'Content updated'
  ): Promise<PromptTemplate> {
    try {
      const db = getSyncDb();

      // Update the prompt (trigger will handle versioning)
      db.run(
        `UPDATE prompts 
         SET content = ?, updated_at = CURRENT_TIMESTAMP 
         WHERE name = ? AND is_active = 1`,
        [content, name]
      );

      // Clear cache for this prompt
      const cacheKey = `prompt:${name}`;
      this.cache.delete(cacheKey);
      this.cacheTimestamps.delete(cacheKey);

      logger.info(`✅ Prompt '${name}' updated successfully`);

      // Return updated prompt
      const updated = await this.getPrompt(name, true);
      if (!updated) {
        throw new Error(`Failed to retrieve updated prompt '${name}'`);
      }

      return updated;
    } catch (error) {
      logger.error(`❌ Failed to update prompt '${name}':`, error);
      throw error;
    }
  }

  /**
   * Create new prompt 🎪
   */
  async createPrompt(
    prompt: Omit<PromptTemplate, 'id' | 'version' | 'createdAt' | 'updatedAt'>
  ): Promise<PromptTemplate> {
    try {
      const db = getSyncDb();

      let isActiveValue = 0;
      if (prompt.isActive) {
        isActiveValue = 1;
      }

      const result = db.run(
        `INSERT INTO prompts (name, content, description, category, is_active, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          prompt.name,
          prompt.content,
          prompt.description || null,
          prompt.category,
          isActiveValue,
          JSON.stringify(prompt.metadata),
        ]
      );

      logger.info(`✅ Created new prompt '${prompt.name}' with ID ${result.lastInsertRowid}`);

      // Return the row just written, by id: getPrompt only sees active prompts, so creating an
      // inactive one used to succeed and then throw (Codex crew 2026-11-18).
      const row = db.get(`SELECT * FROM prompts WHERE id = ?`, [Number(result.lastInsertRowid)]);
      if (!row) {
        throw new Error(`Failed to retrieve created prompt '${prompt.name}'`);
      }
      let metadata: any = row.metadata;
      if (typeof row.metadata === 'string') metadata = JSON.parse(row.metadata);
      return {
        id: row.id,
        name: row.name,
        version: row.version,
        content: row.content,
        description: row.description,
        category: row.category,
        isActive: Boolean(row.is_active),
        metadata,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    } catch (error) {
      logger.error(`❌ Failed to create prompt '${prompt.name}':`, error);
      throw error;
    }
  }

  /**
   * List all prompts with optional filtering 📋
   */
  async listPrompts(category?: string, activeOnly = true): Promise<PromptTemplate[]> {
    try {
      const db = getSyncDb();

      let query = 'SELECT * FROM prompts WHERE 1=1';
      const params: (string | number)[] = [];

      if (activeOnly) {
        query += ' AND is_active = 1';
      }

      if (category) {
        query += ' AND category = ?';
        params.push(category);
      }

      query += ' ORDER BY category, name, version DESC';

      const rows = db.all(query, params);

      return rows.map((row: DatabaseRow) => {
        let metadata: any;
        if (typeof row.metadata === 'string') {
          metadata = JSON.parse(row.metadata);
        } else {
          metadata = row.metadata;
        }

        return {
          id: row.id,
          name: row.name,
          version: row.version,
          content: row.content,
          description: row.description,
          category: row.category,
          isActive: Boolean(row.is_active),
          metadata,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      });
    } catch (error) {
      logger.error('❌ Failed to list prompts:', error);
      throw error;
    }
  }

  /**
   * Get prompt history for versioning 📚
   */
  async getPromptHistory(name: string): Promise<PromptTemplate[]> {
    try {
      const db = getSyncDb();

      const rows = db.all(
        `
        SELECT ph.*, p.name
        FROM prompt_history ph
        JOIN prompts p ON ph.prompt_id = p.id
        WHERE p.name = ?
        ORDER BY ph.version DESC
      `,
        [name]
      );

      return rows.map((row: DatabaseRow) => {
        let metadata: any;
        if (typeof row.metadata === 'string') {
          metadata = JSON.parse(row.metadata);
        } else {
          metadata = row.metadata;
        }

        return {
          id: row.id,
          name: row.name,
          version: row.version,
          content: row.content,
          description: row.description,
          category: row.category,
          isActive: Boolean(row.is_active),
          metadata,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      });
    } catch (error) {
      logger.error(`❌ Failed to get prompt history for '${name}':`, error);
      throw error;
    }
  }

  /**
   * Clear the cache (for testing or manual refresh) 🧹
   */
  clearCache(): void {
    this.cache.clear();
    this.lastCacheUpdate = 0;
    logger.info('🧹 Prompt cache cleared');
  }

  /**
   * Get cache statistics 📊
   */
  getCacheStats(): { size: number; lastUpdate: number; expiryMs: number } {
    return {
      size: this.cache.size,
      lastUpdate: this.lastCacheUpdate,
      expiryMs: this.cacheExpiryMs,
    };
  }
}

// Export singleton instance
export const promptStore = new PromptStore();
