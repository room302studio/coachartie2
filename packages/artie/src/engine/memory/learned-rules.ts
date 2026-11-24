/**
 * Learned rules reader.
 *
 * Active rows in learned_rules are still read into prompts (3-context/sources/memories.ts) and
 * counted by routes/reflection.ts. The writer side (daily consolidation, weekly review,
 * emergency reflection, ENABLE_REFLECTION_CONSOLIDATION) is gone; existing rows and the
 * learned_rules / learned_rules_history tables stay as they are.
 */

import { logger } from '../../shared/logger.js';
import { getSyncDb } from '../../shared/db/client.js';

// Minimum confidence threshold for a rule to be active
const MIN_RULE_CONFIDENCE = parseFloat(process.env.REFLECTION_MIN_CONFIDENCE || '0.6');

class LearnedRulesReader {
  private static instance: LearnedRulesReader;

  static getInstance(): LearnedRulesReader {
    if (!LearnedRulesReader.instance) {
      LearnedRulesReader.instance = new LearnedRulesReader();
    }
    return LearnedRulesReader.instance;
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
}

// Export singleton instance
export const learnedRulesReader = LearnedRulesReader.getInstance();
