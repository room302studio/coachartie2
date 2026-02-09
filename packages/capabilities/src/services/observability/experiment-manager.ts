/**
 * Experiment Manager - A/B Testing for LLM configurations
 *
 * Manages experiments to test different:
 * - Models (e.g., Claude vs GPT-4)
 * - Prompts (system prompt variations)
 * - Parameters (temperature, max tokens)
 * - Features (enable/disable memories, rules, etc.)
 *
 * Uses consistent hashing to ensure users get the same variant
 * throughout an experiment's duration.
 *
 * Part of the Context Alchemy observability stack.
 */

import { logger, getSyncDb } from '@coachartie/shared';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

// Environment configuration
const ENABLE_EXPERIMENTS = process.env.ENABLE_EXPERIMENTS !== 'false';

export type VariantType = 'model' | 'prompt' | 'parameter' | 'feature';
export type ExperimentStatus = 'draft' | 'active' | 'completed' | 'cancelled';
export type TargetType = 'global' | 'guild' | 'user';

export interface VariantConfig {
  // Model overrides
  smartModel?: string;
  fastModel?: string;
  managerModel?: string;

  // Prompt overrides
  systemPromptOverride?: string;
  systemPromptAppend?: string;

  // Parameter overrides
  temperature?: number;
  maxTokens?: number;
  topP?: number;

  // Feature flags
  enableMemories?: boolean;
  enableRules?: boolean;
  enableCapabilities?: boolean;
  enableStreaming?: boolean;
}

export interface ExperimentDefinition {
  name: string;
  hypothesis?: string;
  targetType: TargetType;
  targetIds?: string[];
  trafficPercent?: number;
  variants: Array<{
    name: string;
    variantType: VariantType;
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
  totalImpressions: number;
  totalFeedback: number;
  variants: Array<{
    id: string;
    name: string;
    impressions: number;
    positiveCount: number;
    negativeCount: number;
    positiveRate: number;
    significanceVsControl?: number; // z-score vs control variant
  }>;
  winner?: string; // Variant name with best performance
  isSignificant: boolean;
}

class ExperimentManager {
  private static instance: ExperimentManager;
  private activeExperimentsCache: Map<string, any> = new Map();
  private cacheExpiry = 0;
  private readonly CACHE_TTL = 60000; // 1 minute

  static getInstance(): ExperimentManager {
    if (!ExperimentManager.instance) {
      ExperimentManager.instance = new ExperimentManager();
    }
    return ExperimentManager.instance;
  }

  /**
   * Check if experiments are enabled
   */
  isEnabled(): boolean {
    return ENABLE_EXPERIMENTS;
  }

  /**
   * Get the experiment variant for a user
   * Uses consistent hashing to ensure stable assignment
   */
  async getVariantForUser(
    userId: string,
    guildId?: string
  ): Promise<{
    experimentId: string | null;
    variantId: string | null;
    config: VariantConfig;
  }> {
    if (!ENABLE_EXPERIMENTS) {
      return { experimentId: null, variantId: null, config: {} };
    }

    try {
      // Get active experiments (cached)
      const experiments = await this.getActiveExperiments();
      if (experiments.length === 0) {
        return { experimentId: null, variantId: null, config: {} };
      }

      // Find the first matching experiment
      for (const experiment of experiments) {
        if (!this.userMatchesTarget(userId, guildId, experiment)) {
          continue;
        }

        // Check traffic percent (consistent hash for stability)
        const trafficHash = this.hashForBucket(`${experiment.id}:traffic:${userId}`, 100);
        if (trafficHash >= experiment.traffic_percent) {
          continue; // User not in traffic allocation
        }

        // Get variant assignment (consistent)
        const variant = await this.assignVariant(experiment.id, userId);
        if (variant) {
          // Increment impressions
          this.incrementImpressions(variant.id);

          return {
            experimentId: experiment.id,
            variantId: variant.id,
            config: JSON.parse(variant.variant_config) as VariantConfig,
          };
        }
      }

      return { experimentId: null, variantId: null, config: {} };
    } catch (error) {
      logger.error('Failed to get variant for user:', error);
      return { experimentId: null, variantId: null, config: {} };
    }
  }

  /**
   * Create a new experiment
   */
  async createExperiment(definition: ExperimentDefinition): Promise<string> {
    try {
      const db = getSyncDb();
      const experimentId = uuidv4();
      const now = new Date().toISOString();

      // Insert experiment
      db.run(
        `INSERT INTO experiments (id, name, hypothesis, target_type, target_ids, status, traffic_percent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
        [
          experimentId,
          definition.name,
          definition.hypothesis || null,
          definition.targetType,
          JSON.stringify(definition.targetIds || []),
          definition.trafficPercent || 100,
          now,
          now,
        ]
      );

      // Insert variants
      for (const variant of definition.variants) {
        const variantId = uuidv4();
        db.run(
          `INSERT INTO experiment_variants (id, experiment_id, name, variant_type, variant_config, weight)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            variantId,
            experimentId,
            variant.name,
            variant.variantType,
            JSON.stringify(variant.config),
            variant.weight || 50,
          ]
        );
      }

      logger.info(`🧪 Created experiment: ${definition.name} (${experimentId})`);
      this.invalidateCache();

      return experimentId;
    } catch (error) {
      logger.error('Failed to create experiment:', error);
      throw error;
    }
  }

  /**
   * Start an experiment
   */
  async startExperiment(experimentId: string): Promise<void> {
    try {
      const db = getSyncDb();
      const now = new Date().toISOString();

      db.run(
        `UPDATE experiments SET status = 'active', started_at = ?, updated_at = ? WHERE id = ?`,
        [now, now, experimentId]
      );

      logger.info(`🧪 Started experiment: ${experimentId}`);
      this.invalidateCache();
    } catch (error) {
      logger.error('Failed to start experiment:', error);
      throw error;
    }
  }

  /**
   * End an experiment
   */
  async endExperiment(experimentId: string): Promise<void> {
    try {
      const db = getSyncDb();
      const now = new Date().toISOString();

      db.run(
        `UPDATE experiments SET status = 'completed', ended_at = ?, updated_at = ? WHERE id = ?`,
        [now, now, experimentId]
      );

      logger.info(`🧪 Ended experiment: ${experimentId}`);
      this.invalidateCache();
    } catch (error) {
      logger.error('Failed to end experiment:', error);
      throw error;
    }
  }

  /**
   * Cancel an experiment
   */
  async cancelExperiment(experimentId: string): Promise<void> {
    try {
      const db = getSyncDb();
      const now = new Date().toISOString();

      db.run(
        `UPDATE experiments SET status = 'cancelled', ended_at = ?, updated_at = ? WHERE id = ?`,
        [now, now, experimentId]
      );

      logger.info(`🧪 Cancelled experiment: ${experimentId}`);
      this.invalidateCache();
    } catch (error) {
      logger.error('Failed to cancel experiment:', error);
      throw error;
    }
  }

  /**
   * Get experiment results with statistical analysis
   */
  async getResults(experimentId: string): Promise<ExperimentResults | null> {
    try {
      const db = getSyncDb();

      // Get experiment
      const experiment = db.get<{
        id: string;
        name: string;
        status: string;
        started_at: string | null;
        ended_at: string | null;
      }>(
        `SELECT id, name, status, started_at, ended_at FROM experiments WHERE id = ?`,
        [experimentId]
      );

      if (!experiment) {
        return null;
      }

      // Get variants with stats
      const variants = db.all<{
        id: string;
        name: string;
        impressions: number;
        positive_count: number;
        negative_count: number;
      }>(
        `SELECT id, name, impressions, positive_count, negative_count
         FROM experiment_variants WHERE experiment_id = ?
         ORDER BY name`,
        [experimentId]
      );

      if (!variants || variants.length === 0) {
        return {
          experimentId: experiment.id,
          name: experiment.name,
          status: experiment.status as ExperimentStatus,
          startedAt: experiment.started_at,
          endedAt: experiment.ended_at,
          totalImpressions: 0,
          totalFeedback: 0,
          variants: [],
          isSignificant: false,
        };
      }

      // Calculate totals and rates
      let totalImpressions = 0;
      let totalFeedback = 0;
      const variantResults: Array<{
        id: string;
        name: string;
        impressions: number;
        positiveCount: number;
        negativeCount: number;
        positiveRate: number;
        significanceVsControl?: number;
      }> = variants.map((v) => {
        const feedbackCount = v.positive_count + v.negative_count;
        totalImpressions += v.impressions;
        totalFeedback += feedbackCount;

        return {
          id: v.id,
          name: v.name,
          impressions: v.impressions,
          positiveCount: v.positive_count,
          negativeCount: v.negative_count,
          positiveRate: feedbackCount > 0 ? v.positive_count / feedbackCount : 0,
        };
      });

      // Find control variant (usually named "control")
      const control = variantResults.find((v) => v.name.toLowerCase() === 'control') || variantResults[0];

      // Calculate significance vs control for each variant
      for (const variant of variantResults) {
        if (variant.id !== control.id) {
          variant.significanceVsControl = this.calculateZScore(
            variant.positiveCount,
            variant.positiveCount + variant.negativeCount,
            control.positiveCount,
            control.positiveCount + control.negativeCount
          );
        }
      }

      // Find winner (highest positive rate with significance)
      let winner: string | undefined;
      let bestRate = control.positiveRate;
      let isSignificant = false;

      for (const variant of variantResults) {
        if (
          variant.id !== control.id &&
          variant.positiveRate > bestRate &&
          variant.significanceVsControl &&
          Math.abs(variant.significanceVsControl) > 1.96 // 95% confidence
        ) {
          winner = variant.name;
          bestRate = variant.positiveRate;
          isSignificant = true;
        }
      }

      return {
        experimentId: experiment.id,
        name: experiment.name,
        status: experiment.status as ExperimentStatus,
        startedAt: experiment.started_at,
        endedAt: experiment.ended_at,
        totalImpressions,
        totalFeedback,
        variants: variantResults,
        winner,
        isSignificant,
      };
    } catch (error) {
      logger.error('Failed to get experiment results:', error);
      return null;
    }
  }

  /**
   * List all experiments
   */
  async listExperiments(status?: ExperimentStatus): Promise<any[]> {
    try {
      const db = getSyncDb();

      if (status) {
        return db.all(
          `SELECT * FROM experiments WHERE status = ? ORDER BY created_at DESC`,
          [status]
        ) || [];
      }

      return db.all(
        `SELECT * FROM experiments ORDER BY created_at DESC`
      ) || [];
    } catch (error) {
      logger.error('Failed to list experiments:', error);
      return [];
    }
  }

  // ============================================================================
  // PRIVATE HELPERS
  // ============================================================================

  private async getActiveExperiments(): Promise<any[]> {
    // Check cache
    if (Date.now() < this.cacheExpiry && this.activeExperimentsCache.size > 0) {
      return Array.from(this.activeExperimentsCache.values());
    }

    try {
      const db = getSyncDb();
      const experiments = db.all(
        `SELECT * FROM experiments WHERE status = 'active'`
      ) || [];

      // Update cache
      this.activeExperimentsCache.clear();
      for (const exp of experiments) {
        this.activeExperimentsCache.set(exp.id, exp);
      }
      this.cacheExpiry = Date.now() + this.CACHE_TTL;

      return experiments;
    } catch (error) {
      logger.error('Failed to get active experiments:', error);
      return [];
    }
  }

  private invalidateCache(): void {
    this.cacheExpiry = 0;
    this.activeExperimentsCache.clear();
  }

  private userMatchesTarget(userId: string, guildId: string | undefined, experiment: any): boolean {
    const targetType = experiment.target_type;
    const targetIds = JSON.parse(experiment.target_ids || '[]') as string[];

    if (targetType === 'global') {
      return true;
    }

    if (targetType === 'guild' && guildId) {
      return targetIds.length === 0 || targetIds.includes(guildId);
    }

    if (targetType === 'user') {
      return targetIds.length === 0 || targetIds.includes(userId);
    }

    return false;
  }

  private async assignVariant(experimentId: string, userId: string): Promise<any | null> {
    try {
      const db = getSyncDb();

      // Get all variants for this experiment
      const variants = db.all<{
        id: string;
        name: string;
        weight: number;
        variant_config: string;
      }>(
        `SELECT id, name, weight, variant_config FROM experiment_variants WHERE experiment_id = ?`,
        [experimentId]
      );

      if (!variants || variants.length === 0) {
        return null;
      }

      // Calculate total weight
      const totalWeight = variants.reduce((sum, v) => sum + v.weight, 0);

      // Use consistent hash to assign variant
      const bucket = this.hashForBucket(`${experimentId}:variant:${userId}`, totalWeight);

      let cumulative = 0;
      for (const variant of variants) {
        cumulative += variant.weight;
        if (bucket < cumulative) {
          return variant;
        }
      }

      // Fallback to last variant
      return variants[variants.length - 1];
    } catch (error) {
      logger.error('Failed to assign variant:', error);
      return null;
    }
  }

  private hashForBucket(input: string, buckets: number): number {
    const hash = createHash('md5').update(input).digest('hex');
    const num = parseInt(hash.substring(0, 8), 16);
    return num % buckets;
  }

  private incrementImpressions(variantId: string): void {
    try {
      const db = getSyncDb();
      db.run(
        `UPDATE experiment_variants SET impressions = impressions + 1 WHERE id = ?`,
        [variantId]
      );
    } catch (error) {
      // Fail silently
    }
  }

  /**
   * Calculate z-score for comparing two proportions
   * Used to determine statistical significance
   */
  private calculateZScore(
    successA: number,
    totalA: number,
    successB: number,
    totalB: number
  ): number {
    if (totalA === 0 || totalB === 0) {
      return 0;
    }

    const pA = successA / totalA;
    const pB = successB / totalB;
    const pPooled = (successA + successB) / (totalA + totalB);

    const se = Math.sqrt(pPooled * (1 - pPooled) * (1 / totalA + 1 / totalB));

    if (se === 0) {
      return 0;
    }

    return (pA - pB) / se;
  }
}

export const experimentManager = ExperimentManager.getInstance();
