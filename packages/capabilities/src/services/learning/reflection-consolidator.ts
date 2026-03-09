/**
 * Reflection Consolidator Service
 *
 * Periodically analyzes feedback memories and generates consolidated rules.
 * Implements the Reflexion pattern: Attempt → Evaluate → Reflect → Store → Apply
 *
 * Key concepts:
 * - Ephemeral feedback (individual reactions) → Persistent rules (learned patterns)
 * - Guild-specific vs system-wide learnings
 * - Confidence-based rule activation
 * - Automatic rule retirement when evidence contradicts
 */

import { logger, getSyncDb } from '@coachartie/shared';

// Minimum confidence threshold for a rule to be active
const MIN_RULE_CONFIDENCE = parseFloat(process.env.REFLECTION_MIN_CONFIDENCE || '0.6');

// Minimum feedback items needed to generate a rule
const MIN_FEEDBACK_FOR_RULE = 3;

// Max age of feedback to consider (in hours)
const FEEDBACK_WINDOW_HOURS = 168; // 1 week

interface FeedbackMemory {
  id: number;
  content: string;
  tags: string;
  guildId: string | null;
  channelId: string | null;
  createdAt: string;
  importance: number;
}

interface GeneratedRule {
  ruleText: string;
  sourceTag: string;
  confidence: number;
  sourceCount: number;
  examples: string[];
}

interface RuleReviewResult {
  ruleId: number;
  recommendation: 'keep' | 'modify' | 'retire';
  reason: string;
  updatedRuleText?: string;
  updatedConfidence?: number;
}

export class ReflectionConsolidator {
  private static instance: ReflectionConsolidator;
  private isRunning = false;

  static getInstance(): ReflectionConsolidator {
    if (!ReflectionConsolidator.instance) {
      ReflectionConsolidator.instance = new ReflectionConsolidator();
    }
    return ReflectionConsolidator.instance;
  }

  /**
   * Run daily consolidation - analyzes recent feedback and generates/updates rules
   */
  async runDailyConsolidation(): Promise<{
    rulesCreated: number;
    rulesUpdated: number;
    guildsProcessed: number;
  }> {
    if (this.isRunning) {
      logger.warn('[reflection] Already running, skipping');
      return { rulesCreated: 0, rulesUpdated: 0, guildsProcessed: 0 };
    }

    this.isRunning = true;
    logger.info('[reflection] Starting daily consolidation');

    try {
      const stats = { rulesCreated: 0, rulesUpdated: 0, guildsProcessed: 0 };

      // Get distinct guilds with recent feedback
      const guildsWithFeedback = await this.getGuildsWithRecentFeedback();

      // Process each guild
      for (const guildId of guildsWithFeedback) {
        const guildStats = await this.consolidateGuildLearnings(guildId);
        stats.rulesCreated += guildStats.rulesCreated;
        stats.rulesUpdated += guildStats.rulesUpdated;
        stats.guildsProcessed++;
      }

      // Also consolidate system-wide learnings
      const systemStats = await this.consolidateSystemLearnings();
      stats.rulesCreated += systemStats.rulesCreated;
      stats.rulesUpdated += systemStats.rulesUpdated;

      logger.info(
        `[reflection] Complete: +${stats.rulesCreated} rules, ~${stats.rulesUpdated} updated, ${stats.guildsProcessed} guilds`
      );

      return stats;
    } catch (error) {
      logger.error('[reflection] Daily consolidation failed:', error);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Consolidate learnings for a specific guild
   */
  async consolidateGuildLearnings(
    guildId: string
  ): Promise<{ rulesCreated: number; rulesUpdated: number }> {
    try {
      // Get positive and negative feedback for this guild
      const positiveFeedback = await this.getFeedbackMemories(guildId, 'positive');
      const negativeFeedback = await this.getFeedbackMemories(guildId, 'negative');

      logger.debug(
        `[reflection] Guild ${guildId}: ${positiveFeedback.length}+ ${negativeFeedback.length}- feedback`
      );

      const stats = { rulesCreated: 0, rulesUpdated: 0 };

      // Generate rules from negative feedback (things to avoid)
      if (negativeFeedback.length >= MIN_FEEDBACK_FOR_RULE) {
        const avoidRules = await this.generateRulesFromFeedback(negativeFeedback, 'avoid');
        for (const rule of avoidRules) {
          const created = await this.storeOrUpdateRule('guild', guildId, rule);
          if (created) stats.rulesCreated++;
          else stats.rulesUpdated++;
        }
      }

      // Generate rules from positive feedback (things that work)
      if (positiveFeedback.length >= MIN_FEEDBACK_FOR_RULE) {
        const doRules = await this.generateRulesFromFeedback(positiveFeedback, 'do');
        for (const rule of doRules) {
          const created = await this.storeOrUpdateRule('guild', guildId, rule);
          if (created) stats.rulesCreated++;
          else stats.rulesUpdated++;
        }
      }

      return stats;
    } catch (error) {
      logger.error(`[reflection] Guild ${guildId} consolidation failed:`, error);
      return { rulesCreated: 0, rulesUpdated: 0 };
    }
  }

  /**
   * Consolidate system-wide learnings (patterns that apply across all guilds)
   */
  async consolidateSystemLearnings(): Promise<{
    rulesCreated: number;
    rulesUpdated: number;
  }> {
    try {
      // Get all feedback across guilds
      const positiveFeedback = await this.getFeedbackMemories(null, 'positive');
      const negativeFeedback = await this.getFeedbackMemories(null, 'negative');

      logger.debug(
        `[reflection] System-wide: ${positiveFeedback.length}+ ${negativeFeedback.length}- feedback`
      );

      const stats = { rulesCreated: 0, rulesUpdated: 0 };

      // Only create system rules if we have enough cross-guild evidence
      const minSystemEvidence = MIN_FEEDBACK_FOR_RULE * 2;

      if (negativeFeedback.length >= minSystemEvidence) {
        const avoidRules = await this.generateRulesFromFeedback(negativeFeedback, 'avoid');
        for (const rule of avoidRules) {
          const created = await this.storeOrUpdateRule('system', null, rule);
          if (created) stats.rulesCreated++;
          else stats.rulesUpdated++;
        }
      }

      if (positiveFeedback.length >= minSystemEvidence) {
        const doRules = await this.generateRulesFromFeedback(positiveFeedback, 'do');
        for (const rule of doRules) {
          const created = await this.storeOrUpdateRule('system', null, rule);
          if (created) stats.rulesCreated++;
          else stats.rulesUpdated++;
        }
      }

      return stats;
    } catch (error) {
      logger.error('[reflection] System consolidation failed:', error);
      return { rulesCreated: 0, rulesUpdated: 0 };
    }
  }

  /**
   * Weekly review and pruning of existing rules
   * Checks if rules are still valid based on recent feedback
   */
  async reviewAndPruneRules(): Promise<{
    kept: number;
    modified: number;
    retired: number;
  }> {
    logger.info('[reflection] Starting weekly rule review');

    try {
      const stats = { kept: 0, modified: 0, retired: 0 };
      const db = getSyncDb();

      // Get all active rules
      const activeRules = db.all<{
        id: number;
        rule_type: string;
        scope_id: string | null;
        rule_text: string;
        confidence: number;
        source_count: number;
        created_at: string;
      }>(`SELECT * FROM learned_rules WHERE is_active = 1`);

      if (!activeRules || activeRules.length === 0) {
        logger.debug('[reflection] No active rules to review');
        return stats;
      }

      for (const rule of activeRules) {
        const review = await this.reviewRule(rule);

        switch (review.recommendation) {
          case 'keep':
            stats.kept++;
            break;

          case 'modify':
            await this.updateRule(rule.id, {
              ruleText: review.updatedRuleText || rule.rule_text,
              confidence: review.updatedConfidence || rule.confidence,
              changeType: 'updated',
              changeReason: review.reason,
            });
            stats.modified++;
            break;

          case 'retire':
            await this.retireRule(rule.id, review.reason);
            stats.retired++;
            break;
        }
      }

      logger.info(
        `[reflection] Review complete: ${stats.kept} kept, ${stats.modified} modified, ${stats.retired} retired`
      );

      return stats;
    } catch (error) {
      logger.error('[reflection] Rule review failed:', error);
      throw error;
    }
  }

  /**
   * Emergency reflection triggered when negative feedback threshold is crossed
   */
  async triggerEmergencyReflection(
    guildId: string,
    reason: string
  ): Promise<{ rulesCreated: number }> {
    logger.warn(`[reflection] Emergency: guild=${guildId} reason="${reason}"`);

    try {
      // Get recent negative feedback (last hour only for emergency)
      const recentNegative = await this.getRecentNegativeFeedback(guildId, 1);

      if (recentNegative.length < 3) {
        logger.debug('[reflection] Not enough negative feedback for emergency rules');
        return { rulesCreated: 0 };
      }

      // Generate emergency rules with higher urgency
      const rules = await this.generateRulesFromFeedback(recentNegative, 'avoid', true);

      let rulesCreated = 0;
      for (const rule of rules) {
        // Emergency rules get slightly higher confidence due to concentrated feedback
        rule.confidence = Math.min(1.0, rule.confidence + 0.1);
        const created = await this.storeOrUpdateRule('guild', guildId, rule);
        if (created) rulesCreated++;
      }

      if (rulesCreated > 0) {
        logger.info(`[reflection] Emergency: +${rulesCreated} rules for guild ${guildId}`);
      }

      return { rulesCreated };
    } catch (error) {
      logger.error('[reflection] Emergency reflection failed:', error);
      return { rulesCreated: 0 };
    }
  }

  /**
   * Get active rules for a specific scope
   */
  async getActiveRules(
    ruleType: 'system' | 'guild' | 'channel',
    scopeId?: string
  ): Promise<
    Array<{
      id: number;
      ruleText: string;
      sourceTag: string;
      confidence: number;
    }>
  > {
    try {
      const db = getSyncDb();

      let query: string;
      let params: (string | null)[];

      if (ruleType === 'system') {
        query = `
          SELECT id, rule_text, source_tag, confidence
          FROM learned_rules
          WHERE rule_type = 'system'
            AND is_active = 1
            AND confidence >= ?
          ORDER BY confidence DESC
        `;
        params = [String(MIN_RULE_CONFIDENCE)];
      } else {
        query = `
          SELECT id, rule_text, source_tag, confidence
          FROM learned_rules
          WHERE rule_type = ?
            AND scope_id = ?
            AND is_active = 1
            AND confidence >= ?
          ORDER BY confidence DESC
        `;
        params = [ruleType, scopeId || null, String(MIN_RULE_CONFIDENCE)];
      }

      const rules = db.all<{
        id: number;
        rule_text: string;
        source_tag: string | null;
        confidence: number;
      }>(query, params);

      return (rules || []).map((r) => ({
        id: r.id,
        ruleText: r.rule_text,
        sourceTag: r.source_tag || 'general',
        confidence: r.confidence,
      }));
    } catch (error) {
      logger.error('[reflection] Failed to get active rules:', error);
      return [];
    }
  }

  // ============================================================================
  // PRIVATE HELPER METHODS
  // ============================================================================

  private async getGuildsWithRecentFeedback(): Promise<string[]> {
    const db = getSyncDb();
    const cutoff = new Date(Date.now() - FEEDBACK_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

    const results = db.all<{ guild_id: string }>(
      `
      SELECT DISTINCT guild_id
      FROM memories
      WHERE user_id = 'reaction-feedback-system'
        AND guild_id IS NOT NULL
        AND created_at > ?
    `,
      [cutoff]
    );

    return (results || []).map((r) => r.guild_id).filter(Boolean);
  }

  private async getFeedbackMemories(
    guildId: string | null,
    sentiment: 'positive' | 'negative'
  ): Promise<FeedbackMemory[]> {
    const db = getSyncDb();
    const cutoff = new Date(Date.now() - FEEDBACK_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

    let query: string;
    let params: (string | null)[];

    if (guildId) {
      query = `
        SELECT id, content, tags, guild_id, channel_id, created_at, importance
        FROM memories
        WHERE user_id = 'reaction-feedback-system'
          AND guild_id = ?
          AND tags LIKE ?
          AND created_at > ?
        ORDER BY created_at DESC
        LIMIT 100
      `;
      params = [guildId, `%${sentiment}%`, cutoff];
    } else {
      query = `
        SELECT id, content, tags, guild_id, channel_id, created_at, importance
        FROM memories
        WHERE user_id = 'reaction-feedback-system'
          AND tags LIKE ?
          AND created_at > ?
        ORDER BY created_at DESC
        LIMIT 200
      `;
      params = [`%${sentiment}%`, cutoff];
    }

    const results = db.all<{
      id: number;
      content: string;
      tags: string;
      guild_id: string | null;
      channel_id: string | null;
      created_at: string;
      importance: number;
    }>(query, params);

    return (results || []).map((r) => ({
      id: r.id,
      content: r.content,
      tags: r.tags,
      guildId: r.guild_id,
      channelId: r.channel_id,
      createdAt: r.created_at,
      importance: r.importance,
    }));
  }

  private async getRecentNegativeFeedback(
    guildId: string,
    hours: number
  ): Promise<FeedbackMemory[]> {
    const db = getSyncDb();
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    const results = db.all<{
      id: number;
      content: string;
      tags: string;
      guild_id: string | null;
      channel_id: string | null;
      created_at: string;
      importance: number;
    }>(
      `
      SELECT id, content, tags, guild_id, channel_id, created_at, importance
      FROM memories
      WHERE user_id = 'reaction-feedback-system'
        AND guild_id = ?
        AND tags LIKE '%negative%'
        AND created_at > ?
      ORDER BY created_at DESC
    `,
      [guildId, cutoff]
    );

    return (results || []).map((r) => ({
      id: r.id,
      content: r.content,
      tags: r.tags,
      guildId: r.guild_id,
      channelId: r.channel_id,
      createdAt: r.created_at,
      importance: r.importance,
    }));
  }

  /**
   * Generate rules from a collection of feedback items using LLM
   */
  private async generateRulesFromFeedback(
    feedback: FeedbackMemory[],
    ruleDirection: 'do' | 'avoid',
    isEmergency = false
  ): Promise<GeneratedRule[]> {
    if (feedback.length === 0) return [];

    try {
      // Format feedback for LLM analysis
      const feedbackSummary = feedback
        .slice(0, 20)
        .map((f) => {
          // Extract the response snippet from the feedback content
          const responseMatch = f.content.match(/response was: ["'](.+?)["']/);
          const response = responseMatch ? responseMatch[1] : f.content;
          return `- "${response}"`;
        })
        .join('\n');

      const prompt = this.buildConsolidationPrompt(feedbackSummary, ruleDirection, isEmergency);

      // Use the LLM to generate rules
      const { openRouterService } = await import('../llm/openrouter.js');

      const messages = [
        {
          role: 'system' as const,
          content: `You are a learning system that extracts actionable rules from user feedback patterns.
Your job is to identify clear, specific patterns and convert them into rules the AI can follow.
Rules should be concise (1-2 sentences) and actionable.`,
        },
        { role: 'user' as const, content: prompt },
      ];

      const response = await openRouterService.generateFromMessageChain(
        messages,
        'reflection-consolidator',
        undefined,
        process.env.FAST_MODEL || 'openai/gpt-4o-mini' // Use fast model for cost efficiency
      );

      // Parse the response
      return this.parseRulesFromResponse(response, feedback.length);
    } catch (error) {
      logger.error('[reflection] Failed to generate rules:', error);
      return [];
    }
  }

  private buildConsolidationPrompt(
    feedbackSummary: string,
    ruleDirection: 'do' | 'avoid',
    isEmergency: boolean
  ): string {
    const directionText =
      ruleDirection === 'avoid'
        ? 'NEGATIVE reactions (things to AVOID)'
        : 'POSITIVE reactions (things that WORK WELL)';

    const urgencyNote = isEmergency
      ? '\n\n⚠️ EMERGENCY: This feedback is from concentrated recent negative reactions. Be specific about what to avoid.'
      : '';

    return `Review these community ${directionText}:

${feedbackSummary}
${urgencyNote}

Generate 0-3 actionable rules based on clear patterns. For each rule:
1. State the rule clearly (what to ${ruleDirection === 'avoid' ? 'avoid' : 'do'})
2. Explain what feedback pattern it addresses
3. Rate confidence (0.0-1.0) based on how clear the pattern is

Return ONLY a JSON array (no other text):
[
  {
    "rule": "Clear actionable instruction",
    "addresses": "What feedback pattern this addresses",
    "confidence": 0.8,
    "tag": "response-style|format|tone|content"
  }
]

If no clear patterns emerge, return empty array: []`;
  }

  private parseRulesFromResponse(response: string, feedbackCount: number): GeneratedRule[] {
    try {
      // Extract JSON array from response
      const jsonMatch = response.match(/\[[\s\S]*?\]/);
      if (!jsonMatch) {
        logger.debug('[reflection] No JSON array in LLM response');
        return [];
      }

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter((r: any) => r.rule && typeof r.rule === 'string')
        .map((r: any) => ({
          ruleText: String(r.rule).trim(),
          sourceTag: String(r.tag || 'general').trim(),
          confidence: Math.max(0, Math.min(1, parseFloat(r.confidence) || 0.5)),
          sourceCount: feedbackCount,
          examples: r.addresses ? [String(r.addresses)] : [],
        }))
        .slice(0, 3); // Max 3 rules per consolidation
    } catch (error) {
      logger.warn('[reflection] Failed to parse rules from response:', error);
      return [];
    }
  }

  private async storeOrUpdateRule(
    ruleType: 'guild' | 'system' | 'channel',
    scopeId: string | null,
    rule: GeneratedRule
  ): Promise<boolean> {
    const db = getSyncDb();

    // Check if a similar rule already exists
    const existing = db.get<{ id: number; confidence: number; source_count: number }>(
      `
      SELECT id, confidence, source_count
      FROM learned_rules
      WHERE rule_type = ?
        AND (scope_id = ? OR (scope_id IS NULL AND ? IS NULL))
        AND source_tag = ?
        AND is_active = 1
      LIMIT 1
    `,
      [ruleType, scopeId, scopeId, rule.sourceTag]
    );

    const now = new Date().toISOString();
    const metadata = JSON.stringify({ examples: rule.examples });

    if (existing) {
      // Update existing rule - increase confidence and source count
      const newConfidence = Math.min(1.0, (existing.confidence + rule.confidence) / 2);
      const newSourceCount = existing.source_count + rule.sourceCount;

      db.run(
        `
        UPDATE learned_rules
        SET rule_text = ?,
            confidence = ?,
            source_count = ?,
            metadata = ?,
            updated_at = ?
        WHERE id = ?
      `,
        [rule.ruleText, newConfidence, newSourceCount, metadata, now, existing.id]
      );

      // Record history
      db.run(
        `
        INSERT INTO learned_rules_history
          (rule_id, rule_text, confidence, source_count, change_type, change_reason, created_at)
        VALUES (?, ?, ?, ?, 'updated', 'Daily consolidation update', ?)
      `,
        [existing.id, rule.ruleText, newConfidence, newSourceCount, now]
      );

      logger.debug(`[reflection] Updated rule #${existing.id}`);
      return false; // Not a new rule
    } else {
      // Create new rule
      const result = db.run(
        `
        INSERT INTO learned_rules
          (rule_type, scope_id, rule_text, source_tag, confidence, source_count, is_active, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `,
        [
          ruleType,
          scopeId,
          rule.ruleText,
          rule.sourceTag,
          rule.confidence,
          rule.sourceCount,
          metadata,
          now,
          now,
        ]
      );

      const ruleId = result.lastInsertRowid;

      // Record history
      db.run(
        `
        INSERT INTO learned_rules_history
          (rule_id, rule_text, confidence, source_count, change_type, change_reason, created_at)
        VALUES (?, ?, ?, ?, 'created', 'Generated from feedback consolidation', ?)
      `,
        [ruleId, rule.ruleText, rule.confidence, rule.sourceCount, now]
      );

      logger.debug(
        `[reflection] Created ${ruleType} rule #${ruleId} (conf=${rule.confidence.toFixed(2)})`
      );
      return true; // New rule created
    }
  }

  private async reviewRule(rule: {
    id: number;
    rule_type: string;
    scope_id: string | null;
    rule_text: string;
    confidence: number;
    source_count: number;
    created_at: string;
  }): Promise<RuleReviewResult> {
    // Get feedback since rule was created
    const db = getSyncDb();

    // Count positive vs negative feedback that might relate to this rule
    const recentFeedback = db.all<{ tags: string; content: string }>(
      `
      SELECT tags, content
      FROM memories
      WHERE user_id = 'reaction-feedback-system'
        AND created_at > ?
        ${rule.scope_id ? 'AND guild_id = ?' : ''}
      LIMIT 50
    `,
      rule.scope_id ? [rule.created_at, rule.scope_id] : [rule.created_at]
    );

    if (!recentFeedback || recentFeedback.length < 5) {
      // Not enough recent data to review
      return {
        ruleId: rule.id,
        recommendation: 'keep',
        reason: 'Insufficient recent feedback to evaluate',
      };
    }

    // Simple heuristic: if rule is about avoiding something and we still see negative feedback
    // with similar content, the rule might need modification
    const positiveCount = recentFeedback.filter((f) => f.tags?.includes('positive')).length;
    const negativeCount = recentFeedback.filter((f) => f.tags?.includes('negative')).length;

    const ratio = positiveCount / (positiveCount + negativeCount || 1);

    if (ratio > 0.7) {
      // Mostly positive feedback - rule is working
      return {
        ruleId: rule.id,
        recommendation: 'keep',
        reason: `Rule appears effective (${Math.round(ratio * 100)}% positive feedback)`,
        updatedConfidence: Math.min(1.0, rule.confidence + 0.05),
      };
    } else if (ratio < 0.3) {
      // Mostly negative feedback - rule might need work
      if (rule.confidence < 0.5) {
        return {
          ruleId: rule.id,
          recommendation: 'retire',
          reason: `Low effectiveness and confidence (${Math.round(ratio * 100)}% positive, ${rule.confidence} confidence)`,
        };
      } else {
        return {
          ruleId: rule.id,
          recommendation: 'modify',
          reason: `Mixed results despite high confidence (${Math.round(ratio * 100)}% positive)`,
          updatedConfidence: Math.max(0.3, rule.confidence - 0.1),
        };
      }
    } else {
      // Mixed feedback - keep but lower confidence
      return {
        ruleId: rule.id,
        recommendation: 'keep',
        reason: `Mixed feedback (${Math.round(ratio * 100)}% positive)`,
        updatedConfidence: Math.max(0.4, rule.confidence - 0.05),
      };
    }
  }

  private async updateRule(
    ruleId: number,
    updates: {
      ruleText: string;
      confidence: number;
      changeType: string;
      changeReason: string;
    }
  ): Promise<void> {
    const db = getSyncDb();
    const now = new Date().toISOString();

    db.run(
      `
      UPDATE learned_rules
      SET rule_text = ?, confidence = ?, updated_at = ?
      WHERE id = ?
    `,
      [updates.ruleText, updates.confidence, now, ruleId]
    );

    db.run(
      `
      INSERT INTO learned_rules_history
        (rule_id, rule_text, confidence, change_type, change_reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      [ruleId, updates.ruleText, updates.confidence, updates.changeType, updates.changeReason, now]
    );
  }

  private async retireRule(ruleId: number, reason: string): Promise<void> {
    const db = getSyncDb();
    const now = new Date().toISOString();

    // Get current rule text for history
    const rule = db.get<{ rule_text: string; confidence: number }>(
      `SELECT rule_text, confidence FROM learned_rules WHERE id = ?`,
      [ruleId]
    );

    if (!rule) return;

    db.run(
      `
      UPDATE learned_rules
      SET is_active = 0, updated_at = ?
      WHERE id = ?
    `,
      [now, ruleId]
    );

    db.run(
      `
      INSERT INTO learned_rules_history
        (rule_id, rule_text, confidence, change_type, change_reason, created_at)
      VALUES (?, ?, ?, 'retired', ?, ?)
    `,
      [ruleId, rule.rule_text, rule.confidence, reason, now]
    );

    logger.debug(`[reflection] Retired rule #${ruleId}`);
  }
}

// Export singleton instance
export const reflectionConsolidator = ReflectionConsolidator.getInstance();

/**
 * Count recent negative feedback for threshold checking
 */
export async function countRecentNegativeFeedback(guildId: string, hours: number): Promise<number> {
  const db = getSyncDb();
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const result = db.get<{ count: number }>(
    `
    SELECT COUNT(*) as count
    FROM memories
    WHERE user_id = 'reaction-feedback-system'
      AND guild_id = ?
      AND tags LIKE '%negative%'
      AND created_at > ?
  `,
    [guildId, cutoff]
  );

  return result?.count || 0;
}
