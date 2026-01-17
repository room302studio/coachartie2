import { getSyncDb } from '@coachartie/shared';
import { logger } from '@coachartie/shared';

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

export interface CapabilityConfig {
  id?: number;
  name: string;
  version: number;
  config: Record<string, unknown>;
  description?: string;
  isEnabled: boolean;
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

interface PromptHistoryRow extends DatabaseRow {
  // Additional fields specific to history if any
}

export class PromptManager {
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

      const prompt: PromptTemplate = {
        id: row.id,
        name: row.name,
        version: row.version,
        content: row.content,
        description: row.description,
        category: row.category,
        isActive: Boolean(row.is_active),
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
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
  async getCapabilityInstructions(userMessage: string): Promise<string> {
    try {
      // First, try to get the rich system prompt
      logger.info(`🔍 Attempting to load rich system prompt from database`);
      const systemPrompt = await this.getPrompt('PROMPT_SYSTEM');
      if (systemPrompt) {
        let instructions = systemPrompt.content.replace(/\{\{USER_MESSAGE\}\}/g, userMessage);

        // Append capability format instructions
        const capabilityIntro = await this.getPrompt('CAPABILITY_PROMPT_INTRO');
        if (capabilityIntro) {
          instructions += '\n\n' + capabilityIntro.content;
          logger.info(`📝 Appended CAPABILITY_PROMPT_INTRO to PROMPT_SYSTEM`);
        }

        logger.info(`🎯 Using rich PROMPT_SYSTEM from database (v${systemPrompt.version})`);
        return instructions;
      } else {
        // Fallback to basic capability instructions
        logger.warn(`⚠️ Rich system prompt not found, trying capability_instructions`);
        const dbPrompt = await this.getPrompt('capability_instructions');
        if (dbPrompt) {
          const instructions = dbPrompt.content.replace(/\{\{USER_MESSAGE\}\}/g, userMessage);
          logger.info(
            `🎯 Using basic capability instructions from database (v${dbPrompt.version})`
          );
          return instructions;
        }
      }
    } catch (error) {
      logger.warn(`⚠️ Failed to load DB prompts, falling back to registry:`, error);
    }

    // Fallback: Use two-tier capability selector to nominate relevant capabilities
    logger.info('🎯 Using two-tier capability selector for intelligent triage');
    const { capabilitySelector } = await import('../capability/capability-selector.js');

    try {
      // TIER 1: Use FAST_MODEL to nominate 3-5 relevant capabilities
      const nominated = await capabilitySelector.selectRelevantCapabilities(userMessage);

      // TIER 2: Generate instructions for ONLY nominated capabilities
      const instructions = capabilitySelector
        .generateNominatedInstructions(nominated)
        .replace(/\{\{USER_MESSAGE\}\}/g, userMessage);

      logger.info(
        `✅ Two-tier selector: Nominated ${nominated.length} capabilities (reduced from full registry)`
      );

      return instructions;
    } catch (selectorError) {
      // Fallback if selector fails: use ALL capabilities
      logger.warn('⚠️ Capability selector failed, falling back to full registry:', selectorError);
      const { capabilityRegistry } = await import('../capability/capability-registry.js');
      const instructions = capabilityRegistry
        .generateInstructions()
        .replace(/\{\{USER_MESSAGE\}\}/g, userMessage);
      logger.info(
        `🎯 Using fallback capability instructions from registry (${capabilityRegistry.size()} capabilities)`
      );

      return instructions;
    }
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

      const result = db.run(
        `INSERT INTO prompts (name, content, description, category, is_active, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          prompt.name,
          prompt.content,
          prompt.description || null,
          prompt.category,
          prompt.isActive ? 1 : 0,
          JSON.stringify(prompt.metadata),
        ]
      );

      logger.info(`✅ Created new prompt '${prompt.name}' with ID ${result.lastInsertRowid}`);

      // Return the created prompt
      const created = await this.getPrompt(prompt.name, true);
      if (!created) {
        throw new Error(`Failed to retrieve created prompt '${prompt.name}'`);
      }

      return created;
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

      return rows.map((row: DatabaseRow) => ({
        id: row.id,
        name: row.name,
        version: row.version,
        content: row.content,
        description: row.description,
        category: row.category,
        isActive: Boolean(row.is_active),
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
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

      return rows.map((row: DatabaseRow) => ({
        id: row.id,
        name: row.name,
        version: row.version,
        content: row.content,
        description: row.description,
        category: row.category,
        isActive: Boolean(row.is_active),
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
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
export const promptManager = new PromptManager();
