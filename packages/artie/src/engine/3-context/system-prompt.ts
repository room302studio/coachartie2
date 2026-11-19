import { getSyncDb } from '../../shared/db/client.js';
import { logger } from '../../shared/logger.js';
import { stripUserMessagePlaceholder } from './prompt-cache.js';
import { toolLoopMode } from '../5-tool-loop/mode.js';

/** Base prompt when the DB has no PROMPT_SYSTEM row (native mode; tests, a fresh DB). */
export const NATIVE_FALLBACK_BASE_PROMPT =
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

interface _PromptHistoryRow extends DatabaseRow {
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
  async getCapabilityInstructions(userMessage: string): Promise<string> {
    try {
      // First, try to get the rich system prompt
      logger.info(`🔍 Attempting to load rich system prompt from database`);
      const systemPrompt = await this.getPrompt('PROMPT_SYSTEM');
      if (systemPrompt) {
        // Never substitute the user message here: this text becomes the cached system prefix,
        // and a per-request byte in it means no cache hit ever (see prompt-cache.ts).
        let instructions = stripUserMessagePlaceholder(systemPrompt.content);

        // Native tools (the default): tools describe themselves on the wire, so no XML format
        // teaching and no roster. assemble.ts strips any XML teaching left in the DB prompts
        // and adds the one native line.
        if (toolLoopMode() === 'native') {
          logger.info(`🎯 Using rich PROMPT_SYSTEM from database (v${systemPrompt.version}), native tools`);
          return instructions;
        }

        // XML-LOOP: delete after v3 soak (TOOL_LOOP=xml) — the intro and roster below.
        // Append capability format instructions
        const capabilityIntro = await this.getPrompt('CAPABILITY_PROMPT_INTRO');
        if (capabilityIntro) {
          instructions += '\n\n' + capabilityIntro.content;
          logger.info(`📝 Appended CAPABILITY_PROMPT_INTRO to PROMPT_SYSTEM`);
        }

        // Append the live capability roster. CAPABILITY_PROMPT_INTRO teaches the
        // XML format but only name-drops three example tools — on this (the
        // production) path the registry was never consulted, so the model had no
        // idea what capabilities exist unless the user typed their exact names.
        // Compact one-liners keep it ~2k tokens for the full registry.
        instructions += '\n\n' + (await this.buildCapabilityRoster());

        logger.info(`🎯 Using rich PROMPT_SYSTEM from database (v${systemPrompt.version})`);
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

    // Native tools need no selector: the tool list rides on the request. (The selector costs a
    // FAST_MODEL call and writes XML instructions.)
    if (toolLoopMode() === 'native') {
      logger.warn('⚠️ No PROMPT_SYSTEM or capability_instructions in the DB; using the minimal native base prompt');
      return NATIVE_FALLBACK_BASE_PROMPT;
    }

    // XML-LOOP: delete after v3 soak (TOOL_LOOP=xml) — the selector fallbacks below.
    // Fallback: Use two-tier capability selector to nominate relevant capabilities
    logger.info('🎯 Using two-tier capability selector for intelligent triage');
    const { capabilitySelector } = await import('./pick-tools.js');

    try {
      // TIER 1: Use FAST_MODEL to nominate 3-5 relevant capabilities
      const nominated = await capabilitySelector.selectRelevantCapabilities(userMessage);

      // TIER 2: Generate instructions for ONLY nominated capabilities
      const instructions = stripUserMessagePlaceholder(
        capabilitySelector.generateNominatedInstructions(nominated)
      );

      logger.info(
        `✅ Two-tier selector: Nominated ${nominated.length} capabilities (reduced from full registry)`
      );

      return instructions;
    } catch (selectorError) {
      // Fallback if selector fails: use ALL capabilities, as the one roster (wave 6: this
      // used to be a separate, longer listing built by the registry).
      logger.warn('⚠️ Capability selector failed, falling back to full registry:', selectorError);
      const { capabilityRegistry } = await import('../5-tool-loop/registry.js');
      const instructions = await this.buildCapabilityRoster();
      logger.info(
        `🎯 Using fallback capability instructions from registry (${capabilityRegistry.size()} capabilities)`
      );

      return instructions;
    }
  }

  /**
   * XML-LOOP: delete after v3 soak (TOOL_LOOP=xml). Native mode lists tools on the wire.
   * Compact roster of every registered capability: name, actions, and the first
   * line of its description. This just makes the tools discoverable.
   *
   * The ONLY capability roster (wave 6). Context assembly used to add a second, compressed
   * listing built by the registry (a 'capability_context' source) into the same cached
   * system message, so every first turn carried the roster twice.
   */
  async buildCapabilityRoster(): Promise<string> {
    const { capabilityRegistry } = await import('../5-tool-loop/registry.js');
    // Sorted, not registration-ordered. This roster sits inside the cached system prefix, and
    // prompt caching is a byte-exact prefix match — if registration order shifts between
    // restarts (it has: see the double-registration fix in b46d9814f) the whole prefix stops
    // matching and silently re-bills at full price. Sorting costs nothing and pins the bytes.
    const lines = [...capabilityRegistry.list()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((cap) => {
        const firstLine = (cap.description || '').split('\n')[0].slice(0, 140);
        return `- ${cap.name} [${[...cap.supportedActions].sort().join(', ')}]: ${firstLine}`;
      });
    return `## Your capability roster\nThese are the ONLY capabilities that exist. Invoke with the XML format above (name + action must match exactly):\n${lines.join('\n')}`;
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
export const promptManager = new PromptManager();
