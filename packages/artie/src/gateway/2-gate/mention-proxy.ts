/**
 * Mention Proxy Service
 *
 * Manages CRUD operations for mention proxy rules.
 * Stores rules in a JSON file for persistence across restarts.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { delay, withTimeout } from '../../shared/async.js';
import * as engine from '../../engine/api.js';
import { join, dirname } from 'path';
import { logger } from '../../shared/logger.js';
import { isBlockedUser } from '../../shared/blocklist.js';
import { pathResolver } from '../path-resolver.js';
import type { Client, Message } from 'discord.js';
import { telemetry } from '../telemetry.js';
import { handleMessageAsIntent } from '../3-ask-engine/build-request.js';
import { replaceMention } from '../../shared/mentions.js';

// -----------------------------------------------------------------------------
// Rule types (folded in from mention-proxy-config.ts, wave 5)
// -----------------------------------------------------------------------------

/**
 * Mention Proxy System
 *
 * Allows Artie to act as a representative/proxy for specific users in specific contexts.
 * Examples:
 * - Answer questions when @ejfox is mentioned in Subway Builder guild
 * - Act as team representative in public servers
 * - Handle common questions for busy people
 */

type ResponseMode =
  | 'direct' // Answer directly without announcing proxy
  | 'announced' // "Answering for @user: ..."
  | 'assistant'; // "I can help while @user is away..."

type TriggerType =
  | 'any_mention' // Respond to any mention
  | 'questions_only' // Only respond to questions
  | 'keywords'; // Only respond if specific keywords present

interface MentionProxyRule {
  // Unique identifier
  id: string;

  // Who to represent
  targetUserId: string; // Discord user ID to monitor
  targetUsername: string; // For display/logging

  // Where to respond
  guildId: string; // Which guild this applies to
  guildName?: string; // Optional: for display
  channelIds?: string[]; // Optional: specific channels only

  // How to respond
  responseMode: ResponseMode;
  responseStyle?: string; // Optional: custom system prompt context

  // When to respond
  triggerType: TriggerType;
  keywords?: string[]; // For keyword-based triggers

  // Judgment layer
  useJudgment?: boolean; // Use LLM to judge if response is appropriate
  judgmentPrompt?: string; // Optional: custom judgment criteria

  // Control
  enabled: boolean;

  // Metadata
  name: string; // Human-friendly name
  description?: string; // What this rule is for
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
  createdBy?: string; // Discord user ID who created it
}

interface MentionProxyConfig {
  rules: MentionProxyRule[];
  version: string;
}

/**
 * Default empty configuration
 */
const DEFAULT_CONFIG: MentionProxyConfig = {
  rules: [],
  version: '1.0.0',
};

// -----------------------------------------------------------------------------
// The service
// -----------------------------------------------------------------------------

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
  async findMatchingRule(
    content: string,
    mentions: string[],
    guildId: string | null,
    channelId: string
  ): Promise<MentionProxyRule | null> {
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
      if (!(await this.matchesTrigger(content, rule))) {
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
  private async matchesTrigger(content: string, rule: MentionProxyRule): Promise<boolean> {
    switch (rule.triggerType) {
      case 'any_mention':
        return true;

      case 'questions_only': {
        // Basic question detection - checks for ? or question words
        // Note: The judgment layer (judgeIfShouldRespond) uses LLM for smart detection
        const lowerContent = content.toLowerCase();
        return (
          content.includes('?') ||
          lowerContent.startsWith('what ') ||
          lowerContent.startsWith('how ') ||
          lowerContent.startsWith('why ') ||
          lowerContent.startsWith('when ') ||
          lowerContent.startsWith('where ') ||
          lowerContent.startsWith('who ') ||
          lowerContent.startsWith('can ') ||
          lowerContent.startsWith('could ') ||
          lowerContent.startsWith('would ') ||
          lowerContent.startsWith('should ') ||
          lowerContent.startsWith('is ') ||
          lowerContent.startsWith('are ') ||
          lowerContent.startsWith('do ') ||
          lowerContent.startsWith('does ')
        );
      }

      case 'keywords': {
        if (!rule.keywords || rule.keywords.length === 0) {
          return true; // No keywords = match any
        }
        const contentLower = content.toLowerCase();
        return rule.keywords.some((keyword) => contentLower.includes(keyword.toLowerCase()));
      }

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
        return (
          baseContext + `Make it clear you're answering for them, then provide a helpful response.`
        );

      case 'assistant':
        return (
          baseContext +
          `Politely explain they're not available, but offer to help with their question.`
        );

      default:
        return baseContext;
    }
  }

  /**
   * Judge if we should respond based on conversation context
   * Uses LLM to determine if the target user is actively in a conversation
   */
  async judgeIfShouldRespond(message: any, rule: MentionProxyRule, client: any): Promise<boolean> {
    try {
      // Fetch recent messages from the channel (last 15 messages)
      const channel = await client.channels.fetch(message.channelId);
      if (!channel || !('messages' in channel)) {
        logger.warn('Cannot fetch messages for judgment - not a text channel - SKIP');
        return false; // FAIL CLOSED: can't see the conversation, don't speak for them
      }

      const recentMessages = await channel.messages.fetch({ limit: 15 });
      // Blocked users are stripped before this context reaches the judgment LLM.
      const messageArray = Array.from(recentMessages.values())
        .reverse()
        .filter((msg: any) => !isBlockedUser(msg.author?.id));

      // If the target user spoke recently — by TIME, not message count (a busy channel
      // pushes 5 messages in seconds) — they are RIGHT THERE. Never answer for them,
      // and don't burn an LLM call deciding.
      const PRESENCE_WINDOW_MS = 15 * 60 * 1000;
      const now = Date.now();
      const userIsPresent = messageArray.some(
        (msg: any) =>
          msg.author.id === rule.targetUserId &&
          now - (msg.createdTimestamp ?? 0) < PRESENCE_WINDOW_MS
      );
      if (userIsPresent) {
        logger.info('⚖️ Judgment: Target user spoke within the last 15 min - SKIP');
        return false;
      }

      // Check if target user has sent messages recently (last 10 messages)
      const last10Messages = messageArray.slice(-10);
      const userHasRecentActivity = last10Messages.some(
        (msg: any) => msg.author.id === rule.targetUserId
      );

      // If no recent activity from target user, definitely respond
      if (!userHasRecentActivity) {
        logger.info('⚖️ Judgment: No recent activity from target user - PROCEED');
        return true;
      }

      // Build conversation context for LLM judgment
      const conversationContext = messageArray
        .map((msg: any) => {
          const isTargetUser = msg.author.id === rule.targetUserId;
          let author: string;
          if (isTargetUser) {
            author = rule.targetUsername;
          } else {
            author = msg.author.username;
          }
          return `[${author}]: ${msg.content}`;
        })
        .join('\n');

      // Use fast LLM to judge (haiku for speed). Wave 9: the turn API is in-process
      // (engine/api.ts; was axios against :47324/chat, 5s timeout, throw on non-2xx).

      const judgmentPrompt =
        rule.judgmentPrompt ||
        `
You are analyzing a Discord conversation to decide if a bot should respond on behalf of ${rule.targetUsername}.

Recent conversation:
${conversationContext}

The latest message mentions @${rule.targetUsername}.

Question: Is ${rule.targetUsername} actively participating in this conversation right now, or is this a standalone question/mention to them?

Rules:
- If ${rule.targetUsername} sent messages in the last 5-10 messages AND is clearly engaged in back-and-forth, respond: SKIP
- If this is a standalone question, greeting, or request TO ${rule.targetUsername}, respond: RESPOND
- If ${rule.targetUsername} hasn't been active recently, respond: RESPOND

Answer with ONLY one word: either "SKIP" or "RESPOND"
`;

      const response = await withTimeout(
        engine.submitTurn({
          message: judgmentPrompt,
          userId: 'mention-proxy-judgment',
          username: 'Judgment System',
          source: 'mention-proxy',
          preferredModel: 'anthropic/claude-3-haiku',
        }),
        5000
      );
      if (!engine.isOk(response)) throw new Error(`Request failed with status code ${response.status}`);

      // KNOWN, PRESERVED AS-IS (wave 9): POST /chat answers `messageId`, never `jobId`, so
      // this has always taken the SKIP branch below (and the queued judgment turn's answer is
      // never read). Fixing it would make the proxy start speaking for people; that's EJ's
      // call, logged in BUILD-LOG, not a side effect of the one-process move.
      if (!response.body?.jobId) {
        // FAIL CLOSED: if we can't judge, don't speak for someone. Defaulting to
        // RESPOND here meant every LLM outage (e.g. out of credits) made the proxy
        // MORE trigger-happy, answering for people mid-conversation.
        logger.warn('⚖️ Judgment: No job ID returned - defaulting to SKIP');
        return false;
      }

      // Poll for result (max 3 seconds)
      for (let i = 0; i < 6; i++) {
        await delay(500);

        const statusResponse = await engine.getTurn(response.body.jobId);
        if (!engine.isOk(statusResponse)) {
          throw new Error(`Request failed with status code ${statusResponse.status}`);
        }

        if (statusResponse.body?.status === 'completed' && statusResponse.body.response) {
          const judgment = statusResponse.body.response.toUpperCase();
          // SKIP wins over RESPOND so "DO NOT RESPOND"-style answers parse correctly
          const shouldRespond = !judgment.includes('SKIP') && judgment.includes('RESPOND');

          let verdict: string;
          if (shouldRespond) {
            verdict = 'PROCEED';
          } else {
            verdict = 'SKIP';
          }
          logger.info(`⚖️ Judgment result: ${judgment} -> ${verdict}`);
          return shouldRespond;
        }
      }

      // FAIL CLOSED on timeout — see above
      logger.warn('⚖️ Judgment: Timeout - defaulting to SKIP');
      return false;
    } catch (error) {
      logger.error('⚖️ Judgment layer error:', error);
      return false; // FAIL CLOSED on error — see above
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

/**
 * on-message's mention-proxy step (moved here verbatim in wave 5): when the message mentions
 * someone Artie represents, answer for them (or deliberately skip). True when a proxy rule
 * took the message, so normal processing must stop.
 */
export async function runMentionProxy(
  message: Message,
  client: Client,
  correlationId: string,
  shortId: string
): Promise<boolean> {
  // -------------------------------------------------------------------------
  // MENTION PROXY DETECTION
  // -------------------------------------------------------------------------

  // Check if this message mentions someone we're representing
  try {
    const proxyService = getMentionProxyService();
    const mentionedUserIds = Array.from(message.mentions.users.keys());

    const matchedRule = await proxyService.findMatchingRule(
      message.content,
      mentionedUserIds,
      message.guildId,
      message.channelId
    );

    if (matchedRule) {
      logger.info(`🎭 Proxy rule matched: ${matchedRule.name} [${shortId}]`, {
        correlationId,
        targetUser: matchedRule.targetUsername,
        rule: matchedRule.id,
        hasJudgment: matchedRule.useJudgment,
      });

      // Judgment layer: Should we actually respond?
      if (matchedRule.useJudgment) {
        logger.info(`⚖️ Running judgment layer for proxy rule [${shortId}]`);

        const shouldRespond = await proxyService.judgeIfShouldRespond(
          message,
          matchedRule,
          client
        );

        if (!shouldRespond) {
          logger.info(`⚖️ Judgment layer: SKIP - Active conversation detected [${shortId}]`);
          telemetry.logEvent(
            'mention_proxy_judgment_skip',
            {
              ruleId: matchedRule.id,
              ruleName: matchedRule.name,
              targetUserId: matchedRule.targetUserId,
              guildId: message.guildId,
            },
            correlationId,
            message.author.id
          );
          return true; // Don't respond - user is in active conversation
        }

        logger.info(`⚖️ Judgment layer: PROCEED - Standalone mention [${shortId}]`);
      }

      telemetry.logEvent(
        'mention_proxy_triggered',
        {
          ruleId: matchedRule.id,
          ruleName: matchedRule.name,
          targetUserId: matchedRule.targetUserId,
          guildId: message.guildId,
          usedJudgment: matchedRule.useJudgment,
        },
        correlationId,
        message.author.id
      );

      // warn, not info: prod console level is warn, and the vitals monitor counts this line
      logger.warn(`📣 Proxying for @${matchedRule.targetUsername} [${shortId}]`);

      // Get the clean message (remove mentions)
      const cleanMessage = replaceMention(message.content, matchedRule.targetUserId, '').trim();

      // Process using existing intent handler with proxy context
      await handleMessageAsIntent(message, cleanMessage, correlationId, {
        isProxyResponse: true,
        proxyRule: matchedRule,
        proxyContext: proxyService.getSystemContext(matchedRule),
        proxyPrefix: proxyService.getResponsePrefix(matchedRule, matchedRule.targetUsername),
      });

      return true; // Don't process as normal message
    }
  } catch (error) {
    logger.warn(`Mention proxy detection failed [${shortId}]:`, error);
    // Continue with normal message processing
  }
  return false;
}
