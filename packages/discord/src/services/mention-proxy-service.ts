/**
 * Mention Proxy Service
 *
 * Manages CRUD operations for mention proxy rules.
 * Stores rules in a JSON file for persistence across restarts.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { logger } from '@coachartie/shared';
import {
  MentionProxyRule,
  MentionProxyConfig,
  DEFAULT_CONFIG,
  TriggerType,
  ResponseMode,
} from '../config/mention-proxy.js';
import { pathResolver } from '../utils/path-resolver.js';

class MentionProxyService {
  private config: MentionProxyConfig;
  private configPath: string;

  constructor() {
    // Store in data directory alongside other persistent data
    this.configPath = join(pathResolver.getDataDir(), 'mention-proxy-rules.json');
    this.config = this.loadConfig();
  }

  /**
   * Load configuration from disk
   */
  private loadConfig(): MentionProxyConfig {
    try {
      // Ensure data directory exists
      const dataDir = dirname(this.configPath);
      if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
      }

      if (existsSync(this.configPath)) {
        const data = readFileSync(this.configPath, 'utf-8');
        const config = JSON.parse(data) as MentionProxyConfig;
        logger.info(`Loaded ${config.rules.length} mention proxy rules from ${this.configPath}`);
        return config;
      }

      // No config file, create default
      logger.info('No mention proxy config found, creating default');
      this.saveConfig(DEFAULT_CONFIG);
      return DEFAULT_CONFIG;
    } catch (error) {
      logger.error('Failed to load mention proxy config:', error);
      return DEFAULT_CONFIG;
    }
  }

  /**
   * Save configuration to disk
   */
  private saveConfig(config: MentionProxyConfig): void {
    try {
      writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
      logger.info(`Saved ${config.rules.length} mention proxy rules to ${this.configPath}`);
    } catch (error) {
      logger.error('Failed to save mention proxy config:', error);
      throw error;
    }
  }

  /**
   * Generate a unique ID for a rule
   */
  private generateId(): string {
    return `proxy-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  // =============================================================================
  // CRUD OPERATIONS
  // =============================================================================

  /**
   * Create a new mention proxy rule
   */
  createRule(
    targetUserId: string,
    targetUsername: string,
    guildId: string,
    name: string,
    options: {
      guildName?: string;
      channelIds?: string[];
      responseMode?: ResponseMode;
      responseStyle?: string;
      triggerType?: TriggerType;
      keywords?: string[];
      description?: string;
      createdBy?: string;
    } = {}
  ): MentionProxyRule {
    const rule: MentionProxyRule = {
      id: this.generateId(),
      targetUserId,
      targetUsername,
      guildId,
      guildName: options.guildName,
      channelIds: options.channelIds,
      responseMode: options.responseMode || 'direct',
      responseStyle: options.responseStyle,
      triggerType: options.triggerType || 'any_mention',
      keywords: options.keywords,
      enabled: true,
      name,
      description: options.description,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: options.createdBy,
    };

    this.config.rules.push(rule);
    this.saveConfig(this.config);

    logger.info(`Created mention proxy rule: ${name} (${rule.id})`);
    return rule;
  }

  /**
   * Get all rules
   */
  getAllRules(): MentionProxyRule[] {
    return [...this.config.rules];
  }

  /**
   * Get a specific rule by ID
   */
  getRule(id: string): MentionProxyRule | null {
    return this.config.rules.find((r) => r.id === id) || null;
  }

  /**
   * Get rules for a specific guild
   */
  getRulesForGuild(guildId: string): MentionProxyRule[] {
    return this.config.rules.filter((r) => r.guildId === guildId && r.enabled);
  }

  /**
   * Get rules for a specific user
   */
  getRulesForUser(userId: string): MentionProxyRule[] {
    return this.config.rules.filter((r) => r.targetUserId === userId && r.enabled);
  }

  /**
   * Update a rule
   */
  updateRule(
    id: string,
    updates: Partial<Omit<MentionProxyRule, 'id' | 'createdAt'>>
  ): MentionProxyRule | null {
    const index = this.config.rules.findIndex((r) => r.id === id);
    if (index === -1) {
      logger.warn(`Attempted to update non-existent rule: ${id}`);
      return null;
    }

    this.config.rules[index] = {
      ...this.config.rules[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    this.saveConfig(this.config);
    logger.info(`Updated mention proxy rule: ${id}`);
    return this.config.rules[index];
  }

  /**
   * Delete a rule
   */
  deleteRule(id: string): boolean {
    const index = this.config.rules.findIndex((r) => r.id === id);
    if (index === -1) {
      logger.warn(`Attempted to delete non-existent rule: ${id}`);
      return false;
    }

    const rule = this.config.rules[index];
    this.config.rules.splice(index, 1);
    this.saveConfig(this.config);

    logger.info(`Deleted mention proxy rule: ${rule.name} (${id})`);
    return true;
  }

  /**
   * Enable/disable a rule
   */
  setRuleEnabled(id: string, enabled: boolean): boolean {
    const rule = this.updateRule(id, { enabled });
    return rule !== null;
  }

  // =============================================================================
  // MATCHING LOGIC
  // =============================================================================

  /**
   * Check if a message matches any proxy rules
   *
   * @param content - Message content
   * @param mentions - Array of mentioned user IDs
   * @param guildId - Guild where message was sent
   * @param channelId - Channel where message was sent
   * @returns Matching rule, or null
   */
  findMatchingRule(
    content: string,
    mentions: string[],
    guildId: string | null,
    channelId: string
  ): MentionProxyRule | null {
    if (!guildId) return null;

    // Get enabled rules for this guild
    const guildRules = this.getRulesForGuild(guildId);

    for (const rule of guildRules) {
      // Check if target user is mentioned
      if (!mentions.includes(rule.targetUserId)) {
        continue;
      }

      // Check channel restriction if specified
      if (rule.channelIds && !rule.channelIds.includes(channelId)) {
        continue;
      }

      // Check trigger type
      if (!this.matchesTrigger(content, rule)) {
        continue;
      }

      logger.info(`Matched mention proxy rule: ${rule.name} (${rule.id})`);
      return rule;
    }

    return null;
  }

  /**
   * Check if message content matches the rule's trigger conditions
   */
  private matchesTrigger(content: string, rule: MentionProxyRule): boolean {
    switch (rule.triggerType) {
      case 'any_mention':
        return true;

      case 'questions_only':
        // Simple question detection: just check for ?
        return content.includes('?');

      case 'keywords':
        if (!rule.keywords || rule.keywords.length === 0) {
          return true; // No keywords = match any
        }
        const contentLower = content.toLowerCase();
        return rule.keywords.some((keyword) => contentLower.includes(keyword.toLowerCase()));

      default:
        return false;
    }
  }

  /**
   * Get response prefix based on rule's response mode
   */
  getResponsePrefix(rule: MentionProxyRule, targetUsername: string): string {
    switch (rule.responseMode) {
      case 'announced':
        return `Answering for @${targetUsername}: `;

      case 'assistant':
        return `@${targetUsername} isn't available right now, but I can help: `;

      case 'direct':
      default:
        return '';
    }
  }

  /**
   * Get system prompt context for a proxy rule
   */
  getSystemContext(rule: MentionProxyRule): string {
    const baseContext = `You are responding on behalf of ${rule.targetUsername} in ${rule.guildName || 'a Discord server'}. `;

    if (rule.responseStyle) {
      return baseContext + rule.responseStyle;
    }

    switch (rule.responseMode) {
      case 'direct':
        return baseContext + `Respond naturally as if you are their representative.`;

      case 'announced':
        return baseContext + `Make it clear you're answering for them, then provide a helpful response.`;

      case 'assistant':
        return (
          baseContext + `Politely explain they're not available, but offer to help with their question.`
        );

      default:
        return baseContext;
    }
  }
}

// Singleton instance
let proxyService: MentionProxyService | null = null;

export function getMentionProxyService(): MentionProxyService {
  if (!proxyService) {
    proxyService = new MentionProxyService();
  }
  return proxyService;
}

export function initializeMentionProxyService(): void {
  proxyService = new MentionProxyService();
  logger.info('Mention proxy service initialized');
}
