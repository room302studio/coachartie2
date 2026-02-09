/**
 * Experiment Manager - A/B Testing for Context Alchemy
 *
 * Manages experiments to test different configurations:
 * - Model comparisons (Claude vs GPT vs local)
 * - Prompt variants
 * - Parameter tuning (temperature, max tokens)
 * - Feature flags (memories on/off, rules on/off)
 *
 * Provides consistent variant assignment per user and tracks outcomes.
 */

import { logger, getSyncDb } from '@coachartie/shared';
import { randomUUID } from 'crypto';

// Whether experiments are enabled
const ENABLE_EXPERIMENTS = process.env.ENABLE_EXPERIMENTS === 'true';

export type VariantType = 'model' | 'prompt' | 'parameter' | 'feature';

export type ExperimentStatus = 'draft' | 'active' | 'completed' | 'cancelled';

export type TargetType = 'global' | 'guild' | 'user';

export interface VariantConfig {
  // Model variants
  smartModel?: string; // Override for smart/manager model
  fastModel?: string; // Override for fast model

  // Prompt variants
  systemPromptOverride?: string;
  systemPromptAppend?: string;

  // Parameter variants
  temperature?: number;
  maxTokens?: number;

  // Feature flags
  enableMemories?: boolean;
  enableRules?: boolean;
  memoriesLimit?: number;
  rulesLimit?: number;
}

export interface ExperimentDefinition {
  name: string;
  hypothesis?: string;
  targetType: TargetType;
  targetIds?: string[];
  trafficPercent?: number;
  variants: Array<{
    name: string;
    type: VariantType;
    config: VariantConfig;
    weight?: number;
  }>;
}

export interface ExperimentResults {
  experimentId: string;
  name: string;
  status: ExperimentStatus;
  startedAt: string | null;
  endedAt: string | null;
  variants: Array<{
    id: string;
    name: string;
    impressions: number;
    positiveCount: number;
    negativeCount: number;
    positiveRate: number;
    conversionRate: number; // % of impressions that got any feedback
  }>;
  winner: string | null; // Variant name with best positive rate (if significant)
  significance: number; // Statistical confidence 0-1
}

export interface VariantAssignment {
  experimentId: string | null;
  variantId: string | null;
  config: VariantConfig;
}

export class ExperimentManager {
  private static instance: ExperimentManager;

  // Cache for user assignments (cleared periodically)
  private assignmentCache = new Map<string, { variantId: string; experimentId: string }>();
  private cacheExpiry = new Map<string, number>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  static getInstance(): ExperimentManager {
    if (!ExperimentManager.instance) {
      ExperimentManager.instance = new ExperimentManager();
    }
    return ExperimentManager.instance;
  }

  /**
   * Get the variant assignment for a user
   * Returns consistent assignment based on user ID hash
   */
  async getVariantForUser(
    userId: string,
    guildId?: string
  ): Promise<VariantAssignment> {
    const noExperiment: VariantAssignment = {
      experimentId: null,
      variantId: null,
      config: {},
    };

    if (!ENABLE_EXPERIMENTS) {
      return noExperiment;
    }

    try {
      // Check cache first
      const cacheKey = `${userId}:${guildId || 'global'}`;
      const cached = this.getCachedAssignment(cacheKey);
      if (cached) {
        return cached;
      }

      const db = getSyncDb();

      // Find active experiments that apply to this user/guild
      const experiments = db.all<{
        id: string;
        target_type: string;
        target_ids: string;
        traffic_percent: number;
      }>(
        `SELECT id, target_type, target_ids, traffic_percent
         FROM experiments
         WHERE status = 'active'
         ORDER BY created_at ASC`
      );

      if (!experiments || experiments.length === 0) {
        return noExperiment;
      }

      // Find first applicable experiment
      for (const exp of experiments) {
        if (!this.isUserEligible(exp, userId, guildId)) {
          continue;
        }

        // Check traffic allocation
        if (!this.isInTrafficSample(userId, exp.id, exp.traffic_percent)) {
          continue;
        }

        // Get variants for this experiment
        const variants = db.all<{
          id: string;
          name: string;
          variant_type: string;
          variant_config: string;
          weight: number;
        }>(
          `SELECT id, name, variant_type, variant_config, weight
           FROM experiment_variants
           WHERE experiment_id = ?`,
          [exp.id]
        );

        if (!variants || variants.length === 0) {
          continue;
        }

        // Select variant based on user hash (deterministic)
        const selectedVariant = this.selectVariantByWeight(userId, exp.id, variants);

        // Increment impressions
        db.run(`UPDATE experiment_variants SET impressions = impressions + 1 WHERE id = ?`, [
          selectedVariant.id,
        ]);

        const assignment: VariantAssignment = {
          experimentId: exp.id,
          variantId: selectedVariant.id,
          config: JSON.parse(selectedVariant.variant_config) as VariantConfig,
        };

        // Cache the assignment
        this.cacheAssignment(cacheKey, assignment);

        logger.debug(
          `[experiment] User ${userId} assigned to variant ${selectedVariant.name} in experiment ${exp.id}`
        );

        return assignment;
      }

      return noExperiment;
    } catch (error) {
      logger.error('[experiment] Failed to get variant for user:', error);
      return noExperiment;
    }
  }

  /**
   * Check if user is eligible for an experiment based on targeting
   */
  private isUserEligible(
    experiment: { target_type: string; target_ids: string },
    userId: string,
    guildId?: string
  ): boolean {
    const targetIds: string[] = JSON.parse(experiment.target_ids || '[]');

    switch (experiment.target_type) {
      case 'global':
        // Global experiments apply to everyone
        return true;

      case 'guild':
        // Guild experiments only apply to users in specified guilds
        if (!guildId) return false;
        return targetIds.length === 0 || targetIds.includes(guildId);

      case 'user':
        // User experiments only apply to specific users
        return targetIds.length === 0 || targetIds.includes(userId);

      default:
        return false;
    }
  }

  /**
   * Deterministic check if user is in traffic sample
   */
  private isInTrafficSample(userId: string, experimentId: string, trafficPercent: number): boolean {
    if (trafficPercent >= 100) return true;
    if (trafficPercent <= 0) return false;

    // Use hash to deterministically assign user to traffic sample
    const hash = this.hashString(`${userId}:${experimentId}:traffic`);
    const bucket = hash % 100;
    return bucket < trafficPercent;
  }

  /**
   * Select variant based on weights using deterministic hash
   */
  private selectVariantByWeight(
    userId: string,
    experimentId: string,
    variants: Array<{ id: string; name: string; weight: number; variant_config: string }>
  ): { id: string; name: string; variant_config: string } {
    // Calculate total weight
    const totalWeight = variants.reduce((sum, v) => sum + (v.weight || 50), 0);

    // Get deterministic bucket for user
    const hash = this.hashString(`${userId}:${experimentId}:variant`);
    const bucket = hash % totalWeight;

    // Select variant based on bucket
    let cumulative = 0;
    for (const variant of variants) {
      cumulative += variant.weight || 50;
      if (bucket < cumulative) {
        return variant;
      }
    }

    // Fallback to first variant
    return variants[0];
  }

  /**
   * Simple string hash function (djb2)
   */
  private hashString(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = (hash * 33) ^ str.charCodeAt(i);
    }
    return Math.abs(hash);
  }

  /**
   * Cache management
   */
  private getCachedAssignment(key: string): VariantAssignment | null {
    const expiry = this.cacheExpiry.get(key);
    if (!expiry || Date.now() > expiry) {
      this.assignmentCache.delete(key);
      this.cacheExpiry.delete(key);
      return null;
    }

    const cached = this.assignmentCache.get(key);
    if (!cached) return null;

    // Fetch the config from DB (cached value only has IDs)
    try {
      const db = getSyncDb();
      const variant = db.get<{ variant_config: string }>(
        `SELECT variant_config FROM experiment_variants WHERE id = ?`,
        [cached.variantId]
      );

      return {
        experimentId: cached.experimentId,
        variantId: cached.variantId,
        config: variant ? (JSON.parse(variant.variant_config) as VariantConfig) : {},
      };
    } catch {
      return null;
    }
  }

  private cacheAssignment(key: string, assignment: VariantAssignment): void {
    if (assignment.experimentId && assignment.variantId) {
      this.assignmentCache.set(key, {
        experimentId: assignment.experimentId,
        variantId: assignment.variantId,
      });
      this.cacheExpiry.set(key, Date.now() + this.CACHE_TTL_MS);
    }
  }

  /**
   * Create a new experiment
   */
  async createExperiment(definition: ExperimentDefinition): Promise<string> {
    try {
      const db = getSyncDb();
      const experimentId = randomUUID();

      db.run(
        `INSERT INTO experiments (
          id, name, hypothesis, target_type, target_ids, traffic_percent, status
        ) VALUES (?, ?, ?, ?, ?, ?, 'draft')`,
        [
          experimentId,
          definition.name,
          definition.hypothesis || null,
          definition.targetType,
          JSON.stringify(definition.targetIds || []),
          definition.trafficPercent || 100,
        ]
      );

      // Create variants
      for (const variant of definition.variants) {
        const variantId = randomUUID();
        db.run(
          `INSERT INTO experiment_variants (
            id, experiment_id, name, variant_type, variant_config, weight
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            variantId,
            experimentId,
            variant.name,
            variant.type,
            JSON.stringify(variant.config),
            variant.weight || 50,
          ]
        );
      }

      logger.info(`[experiment] Created experiment ${definition.name} (${experimentId})`);
      return experimentId;
    } catch (error) {
      logger.error('[experiment] Failed to create experiment:', error);
      throw error;
    }
  }

  /**
   * Start an experiment (move from draft to active)
   */
  async startExperiment(experimentId: string): Promise<void> {
    try {
      const db = getSyncDb();
      const startedAt = new Date().toISOString();

      const result = db.run(
        `UPDATE experiments
         SET status = 'active', started_at = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'draft'`,
        [startedAt, experimentId]
      );

      if (result.changes === 0) {
        throw new Error('Experiment not found or not in draft status');
      }

      logger.info(`[experiment] Started experiment ${experimentId}`);
    } catch (error) {
      logger.error(`[experiment] Failed to start experiment ${experimentId}:`, error);
      throw error;
    }
  }

  /**
   * End an experiment (move to completed)
   */
  async endExperiment(experimentId: string): Promise<void> {
    try {
      const db = getSyncDb();
      const endedAt = new Date().toISOString();

      const result = db.run(
        `UPDATE experiments
         SET status = 'completed', ended_at = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'active'`,
        [endedAt, experimentId]
      );

      if (result.changes === 0) {
        throw new Error('Experiment not found or not active');
      }

      // Clear cache entries for this experiment
      for (const [key, value] of this.assignmentCache.entries()) {
        if (value.experimentId === experimentId) {
          this.assignmentCache.delete(key);
          this.cacheExpiry.delete(key);
        }
      }

      logger.info(`[experiment] Ended experiment ${experimentId}`);
    } catch (error) {
      logger.error(`[experiment] Failed to end experiment ${experimentId}:`, error);
      throw error;
    }
  }

  /**
   * Cancel an experiment
   */
  async cancelExperiment(experimentId: string): Promise<void> {
    try {
      const db = getSyncDb();

      db.run(
        `UPDATE experiments
         SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [experimentId]
      );

      logger.info(`[experiment] Cancelled experiment ${experimentId}`);
    } catch (error) {
      logger.error(`[experiment] Failed to cancel experiment ${experimentId}:`, error);
      throw error;
    }
  }

  /**
   * Get experiment results
   */
  async getResults(experimentId: string): Promise<ExperimentResults | null> {
    try {
      const db = getSyncDb();

      const experiment = db.get<{
        id: string;
        name: string;
        status: string;
        started_at: string | null;
        ended_at: string | null;
      }>(`SELECT id, name, status, started_at, ended_at FROM experiments WHERE id = ?`, [
        experimentId,
      ]);

      if (!experiment) {
        return null;
      }

      const variants = db.all<{
        id: string;
        name: string;
        impressions: number;
        positive_count: number;
        negative_count: number;
      }>(
        `SELECT id, name, impressions, positive_count, negative_count
         FROM experiment_variants
         WHERE experiment_id = ?`,
        [experimentId]
      );

      const variantResults = variants.map((v) => {
        const totalFeedback = v.positive_count + v.negative_count;
        return {
          id: v.id,
          name: v.name,
          impressions: v.impressions,
          positiveCount: v.positive_count,
          negativeCount: v.negative_count,
          positiveRate: totalFeedback > 0 ? Math.round((v.positive_count / totalFeedback) * 100) : 0,
          conversionRate:
            v.impressions > 0 ? Math.round((totalFeedback / v.impressions) * 100) : 0,
        };
      });

      // Determine winner (simple: variant with highest positive rate and min 10 feedbacks)
      let winner: string | null = null;
      let bestRate = 0;
      for (const v of variantResults) {
        const totalFeedback = v.positiveCount + v.negativeCount;
        if (totalFeedback >= 10 && v.positiveRate > bestRate) {
          bestRate = v.positiveRate;
          winner = v.name;
        }
      }

      // Simple significance calculation (placeholder for proper chi-squared test)
      const significance = this.calculateSignificance(variantResults);

      return {
        experimentId: experiment.id,
        name: experiment.name,
        status: experiment.status as ExperimentStatus,
        startedAt: experiment.started_at,
        endedAt: experiment.ended_at,
        variants: variantResults,
        winner: significance > 0.9 ? winner : null,
        significance,
      };
    } catch (error) {
      logger.error(`[experiment] Failed to get results for ${experimentId}:`, error);
      return null;
    }
  }

  /**
   * Calculate statistical significance (simplified)
   * Returns 0-1 confidence that results are not due to chance
   */
  private calculateSignificance(
    variants: Array<{ impressions: number; positiveCount: number; negativeCount: number }>
  ): number {
    if (variants.length < 2) return 0;

    // Need minimum samples for significance
    const minSamples = 30;
    const hasEnoughData = variants.every(
      (v) => v.positiveCount + v.negativeCount >= minSamples
    );

    if (!hasEnoughData) return 0;

    // Simple heuristic: larger difference in rates = higher significance
    const rates = variants.map((v) => {
      const total = v.positiveCount + v.negativeCount;
      return total > 0 ? v.positiveCount / total : 0;
    });

    const maxRate = Math.max(...rates);
    const minRate = Math.min(...rates);
    const spread = maxRate - minRate;

    // Map spread to significance (very simplified)
    // In practice, use proper statistical test (chi-squared, z-test)
    if (spread > 0.2) return 0.95;
    if (spread > 0.15) return 0.9;
    if (spread > 0.1) return 0.8;
    if (spread > 0.05) return 0.6;
    return 0.3;
  }

  /**
   * List all experiments
   */
  async listExperiments(status?: ExperimentStatus): Promise<
    Array<{
      id: string;
      name: string;
      status: ExperimentStatus;
      targetType: TargetType;
      startedAt: string | null;
    }>
  > {
    try {
      const db = getSyncDb();

      let query = `SELECT id, name, status, target_type, started_at FROM experiments`;
      const values: string[] = [];

      if (status) {
        query += ` WHERE status = ?`;
        values.push(status);
      }

      query += ` ORDER BY created_at DESC`;

      const experiments = db.all(query, values);

      return experiments.map((e: Record<string, unknown>) => ({
        id: e.id as string,
        name: e.name as string,
        status: e.status as ExperimentStatus,
        targetType: e.target_type as TargetType,
        startedAt: e.started_at as string | null,
      }));
    } catch (error) {
      logger.error('[experiment] Failed to list experiments:', error);
      return [];
    }
  }

  /**
   * Get a single experiment by ID
   */
  async getExperiment(
    experimentId: string
  ): Promise<{
    id: string;
    name: string;
    hypothesis: string | null;
    status: ExperimentStatus;
    targetType: TargetType;
    targetIds: string[];
    trafficPercent: number;
    startedAt: string | null;
    endedAt: string | null;
    variants: Array<{
      id: string;
      name: string;
      type: VariantType;
      config: VariantConfig;
      weight: number;
    }>;
  } | null> {
    try {
      const db = getSyncDb();

      const experiment = db.get<{
        id: string;
        name: string;
        hypothesis: string | null;
        status: string;
        target_type: string;
        target_ids: string;
        traffic_percent: number;
        started_at: string | null;
        ended_at: string | null;
      }>(`SELECT * FROM experiments WHERE id = ?`, [experimentId]);

      if (!experiment) {
        return null;
      }

      const variants = db.all<{
        id: string;
        name: string;
        variant_type: string;
        variant_config: string;
        weight: number;
      }>(`SELECT * FROM experiment_variants WHERE experiment_id = ?`, [experimentId]);

      return {
        id: experiment.id,
        name: experiment.name,
        hypothesis: experiment.hypothesis,
        status: experiment.status as ExperimentStatus,
        targetType: experiment.target_type as TargetType,
        targetIds: JSON.parse(experiment.target_ids || '[]'),
        trafficPercent: experiment.traffic_percent,
        startedAt: experiment.started_at,
        endedAt: experiment.ended_at,
        variants: variants.map((v) => ({
          id: v.id,
          name: v.name,
          type: v.variant_type as VariantType,
          config: JSON.parse(v.variant_config) as VariantConfig,
          weight: v.weight,
        })),
      };
    } catch (error) {
      logger.error(`[experiment] Failed to get experiment ${experimentId}:`, error);
      return null;
    }
  }
}

// Export singleton instance
export const experimentManager = ExperimentManager.getInstance();
