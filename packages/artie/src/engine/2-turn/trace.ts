/**
 * Trace Manager - Core observability for Context Alchemy
 *
 * Manages the lifecycle of generation traces:
 * - Creates traces at message start
 * - Updates traces with context metrics during processing
 * - Links Discord message IDs for feedback correlation
 * - Records feedback when reactions are received
 * - Captures full context snapshots for sampled traces
 *
 * Part of the Context Alchemy observability system.
 */

import { logger, getSyncDb } from '@coachartie/shared';
import { randomUUID } from 'crypto';

// Sampling rate for full context snapshots (0.01 = 1%)
const SNAPSHOT_SAMPLE_RATE = parseFloat(process.env.SNAPSHOT_SAMPLE_RATE || '0.01');

// Whether to capture all snapshots (for debugging)
const CAPTURE_ALL_SNAPSHOTS = process.env.CAPTURE_ALL_SNAPSHOTS === 'true';

// Whether tracing is enabled
const ENABLE_TRACING = process.env.ENABLE_TRACING !== 'false'; // Default to true

export interface TraceCreateData {
  messageId: string;
  userId: string;
  guildId?: string;
  channelId?: string;
}

export interface TraceUpdateData {
  completedAt?: string;
  durationMs?: number;
  modelUsed?: string;
  modelTier?: string;
  contextTokenCount?: number;
  memoriesRetrievedCount?: number;
  rulesAppliedCount?: number;
  rulesAppliedIds?: string; // JSON array
  responseLength?: number;
  responseTokens?: number;
  estimatedCost?: number;
  responseText?: string; // Full response for debugging
  inputText?: string; // User's original message
  experimentId?: string;
  variantId?: string;
  success?: boolean;
  errorType?: string;
}

export interface ContextSnapshotData {
  systemPrompt: string;
  contextSources: unknown[]; // ContextSource[]
  messageChain: unknown[]; // Message[]
  response: string | null;
}

export interface TraceFeedback {
  sentiment: 'positive' | 'negative';
  emoji: string;
}

export class TraceManager {
  private static instance: TraceManager;

  static getInstance(): TraceManager {
    if (!TraceManager.instance) {
      TraceManager.instance = new TraceManager();
    }
    return TraceManager.instance;
  }

  /**
   * Create a new generation trace at the start of message processing
   * Returns the trace ID for use throughout the request lifecycle
   */
  async createTrace(data: TraceCreateData): Promise<string | null> {
    if (!ENABLE_TRACING) {
      return null;
    }

    const traceId = randomUUID();
    const startedAt = new Date().toISOString();

    try {
      const db = getSyncDb();

      db.run(
        `INSERT INTO generation_traces (
          id, message_id, user_id, guild_id, channel_id,
          started_at, success
        ) VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [
          traceId,
          data.messageId,
          data.userId,
          data.guildId || null,
          data.channelId || null,
          startedAt,
        ]
      );

      logger.debug(
        `[trace] Created trace ${traceId.substring(0, 8)} for message ${data.messageId}`
      );
      return traceId;
    } catch (error) {
      logger.error('[trace] Failed to create trace:', error);
      // Don't fail the request if tracing fails
      return null;
    }
  }

  /**
   * Update an existing trace with additional data
   * Called throughout the request lifecycle as information becomes available
   */
  async updateTrace(traceId: string | null, updates: TraceUpdateData): Promise<void> {
    if (!traceId || !ENABLE_TRACING) {
      return;
    }

    try {
      const db = getSyncDb();

      // Build dynamic UPDATE statement based on provided fields
      const setClauses: string[] = [];
      const values: unknown[] = [];

      if (updates.completedAt !== undefined) {
        setClauses.push('completed_at = ?');
        values.push(updates.completedAt);
      }
      if (updates.durationMs !== undefined) {
        setClauses.push('duration_ms = ?');
        values.push(updates.durationMs);
      }
      if (updates.modelUsed !== undefined) {
        setClauses.push('model_used = ?');
        values.push(updates.modelUsed);
      }
      if (updates.modelTier !== undefined) {
        setClauses.push('model_tier = ?');
        values.push(updates.modelTier);
      }
      if (updates.contextTokenCount !== undefined) {
        setClauses.push('context_token_count = ?');
        values.push(updates.contextTokenCount);
      }
      if (updates.memoriesRetrievedCount !== undefined) {
        setClauses.push('memories_retrieved_count = ?');
        values.push(updates.memoriesRetrievedCount);
      }
      if (updates.rulesAppliedCount !== undefined) {
        setClauses.push('rules_applied_count = ?');
        values.push(updates.rulesAppliedCount);
      }
      if (updates.rulesAppliedIds !== undefined) {
        setClauses.push('rules_applied_ids = ?');
        values.push(updates.rulesAppliedIds);
      }
      if (updates.responseLength !== undefined) {
        setClauses.push('response_length = ?');
        values.push(updates.responseLength);
      }
      if (updates.responseTokens !== undefined) {
        setClauses.push('response_tokens = ?');
        values.push(updates.responseTokens);
      }
      if (updates.estimatedCost !== undefined) {
        setClauses.push('estimated_cost = ?');
        values.push(updates.estimatedCost);
      }
      if (updates.experimentId !== undefined) {
        setClauses.push('experiment_id = ?');
        values.push(updates.experimentId);
      }
      if (updates.variantId !== undefined) {
        setClauses.push('variant_id = ?');
        values.push(updates.variantId);
      }
      if (updates.success !== undefined) {
        setClauses.push('success = ?');
        values.push(updates.success ? 1 : 0);
      }
      if (updates.errorType !== undefined) {
        setClauses.push('error_type = ?');
        values.push(updates.errorType);
      }
      if (updates.responseText !== undefined) {
        setClauses.push('response_text = ?');
        // Truncate to 10KB max
        values.push(updates.responseText.slice(0, 10000));
      }
      if (updates.inputText !== undefined) {
        setClauses.push('input_text = ?');
        // Truncate to 4KB max
        values.push(updates.inputText.slice(0, 4000));
      }

      if (setClauses.length === 0) {
        return;
      }

      values.push(traceId);
      db.run(`UPDATE generation_traces SET ${setClauses.join(', ')} WHERE id = ?`, values);

      logger.debug(
        `[trace] Updated trace ${traceId.substring(0, 8)}: ${Object.keys(updates).join(', ')}`
      );
    } catch (error) {
      logger.error(`[trace] Failed to update trace ${traceId}:`, error);
    }
  }

  /**
   * Link a Discord message ID to a trace for feedback correlation
   * Called after the bot sends its response to Discord
   */
  async linkDiscordMessage(traceId: string | null, discordMessageId: string): Promise<void> {
    if (!traceId || !ENABLE_TRACING) {
      return;
    }

    try {
      const db = getSyncDb();
      db.run(`UPDATE generation_traces SET discord_message_id = ? WHERE id = ?`, [
        discordMessageId,
        traceId,
      ]);

      logger.debug(
        `[trace] Linked trace ${traceId.substring(0, 8)} to Discord message ${discordMessageId}`
      );
    } catch (error) {
      logger.error(`[trace] Failed to link Discord message:`, error);
    }
  }

  /**
   * Record feedback for a trace based on a Discord reaction
   * Called when a user reacts to Artie's message with 👍/👎 etc.
   */
  async recordFeedback(
    discordMessageId: string,
    sentiment: 'positive' | 'negative',
    emoji: string
  ): Promise<boolean> {
    if (!ENABLE_TRACING) {
      return false;
    }

    try {
      const db = getSyncDb();
      const feedbackAt = new Date().toISOString();

      // Find and update the trace
      const result = db.run(
        `UPDATE generation_traces
         SET feedback_sentiment = ?, feedback_emoji = ?, feedback_at = ?
         WHERE discord_message_id = ?`,
        [sentiment, emoji, feedbackAt, discordMessageId]
      );

      if (result.changes > 0) {
        logger.debug(
          `[trace] Recorded ${sentiment} feedback (${emoji}) for Discord message ${discordMessageId}`
        );

        // Also update experiment variant stats if applicable
        await this.updateExperimentStats(discordMessageId, sentiment);
        return true;
      }

      return false;
    } catch (error) {
      logger.error(`[trace] Failed to record feedback:`, error);
      return false;
    }
  }

  /**
   * Update experiment variant statistics when feedback is received
   */
  private async updateExperimentStats(
    discordMessageId: string,
    sentiment: 'positive' | 'negative'
  ): Promise<void> {
    try {
      const db = getSyncDb();

      // Get the experiment/variant from the trace
      const trace = db.get<{ experiment_id: string | null; variant_id: string | null }>(
        `SELECT experiment_id, variant_id FROM generation_traces WHERE discord_message_id = ?`,
        [discordMessageId]
      );

      if (!trace?.variant_id) {
        return;
      }

      // Update variant stats
      const column = sentiment === 'positive' ? 'positive_count' : 'negative_count';
      db.run(`UPDATE experiment_variants SET ${column} = ${column} + 1 WHERE id = ?`, [
        trace.variant_id,
      ]);

      logger.debug(`[trace] Updated experiment variant ${trace.variant_id} stats: +1 ${sentiment}`);
    } catch (error) {
      logger.error('[trace] Failed to update experiment stats:', error);
    }
  }

  /**
   * Capture a full context snapshot for deep debugging
   * Only called for sampled traces (default 1%)
   */
  async captureSnapshot(traceId: string | null, data: ContextSnapshotData): Promise<void> {
    if (!traceId || !ENABLE_TRACING) {
      return;
    }

    // Check if we should sample this trace
    if (!CAPTURE_ALL_SNAPSHOTS && Math.random() > SNAPSHOT_SAMPLE_RATE) {
      return;
    }

    try {
      const db = getSyncDb();

      db.run(
        `INSERT INTO context_snapshots (
          trace_id, system_prompt, context_sources_json, message_chain_json, full_response
        ) VALUES (?, ?, ?, ?, ?)`,
        [
          traceId,
          data.systemPrompt,
          JSON.stringify(data.contextSources),
          JSON.stringify(data.messageChain),
          data.response,
        ]
      );

      logger.debug(`[trace] Captured context snapshot for trace ${traceId.substring(0, 8)}`);
    } catch (error) {
      logger.error(`[trace] Failed to capture snapshot:`, error);
    }
  }

  /**
   * Update the snapshot with the final response (called after LLM responds)
   */
  async updateSnapshotResponse(traceId: string | null, response: string): Promise<void> {
    if (!traceId || !ENABLE_TRACING) {
      return;
    }

    try {
      const db = getSyncDb();
      db.run(`UPDATE context_snapshots SET full_response = ? WHERE trace_id = ?`, [
        response,
        traceId,
      ]);
    } catch (error) {
      logger.error(`[trace] Failed to update snapshot response:`, error);
    }
  }

  /**
   * Get a trace by ID (for debugging/analysis)
   */
  async getTrace(traceId: string): Promise<{
    id: string;
    messageId: string;
    discordMessageId: string | null;
    userId: string;
    guildId: string | null;
    startedAt: string;
    completedAt: string | null;
    durationMs: number | null;
    modelUsed: string | null;
    modelTier: string | null;
    contextTokenCount: number | null;
    memoriesRetrievedCount: number;
    rulesAppliedCount: number;
    feedbackSentiment: string | null;
    feedbackEmoji: string | null;
    success: boolean;
    errorType: string | null;
  } | null> {
    try {
      const db = getSyncDb();
      const trace = db.get(
        `SELECT
          id, message_id, discord_message_id, user_id, guild_id,
          started_at, completed_at, duration_ms, model_used, model_tier,
          context_token_count, memories_retrieved_count, rules_applied_count,
          feedback_sentiment, feedback_emoji, success, error_type
         FROM generation_traces WHERE id = ?`,
        [traceId]
      );

      if (!trace) {
        return null;
      }

      return {
        id: trace.id as string,
        messageId: trace.message_id as string,
        discordMessageId: trace.discord_message_id as string | null,
        userId: trace.user_id as string,
        guildId: trace.guild_id as string | null,
        startedAt: trace.started_at as string,
        completedAt: trace.completed_at as string | null,
        durationMs: trace.duration_ms as number | null,
        modelUsed: trace.model_used as string | null,
        modelTier: trace.model_tier as string | null,
        contextTokenCount: trace.context_token_count as number | null,
        memoriesRetrievedCount: (trace.memories_retrieved_count as number) || 0,
        rulesAppliedCount: (trace.rules_applied_count as number) || 0,
        feedbackSentiment: trace.feedback_sentiment as string | null,
        feedbackEmoji: trace.feedback_emoji as string | null,
        success: Boolean(trace.success),
        errorType: trace.error_type as string | null,
      };
    } catch (error) {
      logger.error(`[trace] Failed to get trace ${traceId}:`, error);
      return null;
    }
  }

  /**
   * Get trace by Discord message ID (for feedback correlation)
   */
  async getTraceByDiscordMessage(discordMessageId: string): Promise<string | null> {
    try {
      const db = getSyncDb();
      const result = db.get<{ id: string }>(
        `SELECT id FROM generation_traces WHERE discord_message_id = ?`,
        [discordMessageId]
      );
      return result?.id || null;
    } catch (error) {
      logger.error(`[trace] Failed to get trace by Discord message:`, error);
      return null;
    }
  }

  /**
   * Query traces with filtering (for analysis)
   */
  async queryTraces(options: {
    guildId?: string;
    userId?: string;
    sentiment?: 'positive' | 'negative' | null;
    modelUsed?: string;
    experimentId?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
    offset?: number;
  }): Promise<
    Array<{
      id: string;
      messageId: string;
      userId: string;
      guildId: string | null;
      startedAt: string;
      durationMs: number | null;
      modelUsed: string | null;
      memoriesRetrievedCount: number;
      rulesAppliedCount: number;
      feedbackSentiment: string | null;
      success: boolean;
    }>
  > {
    try {
      const db = getSyncDb();
      const conditions: string[] = ['1=1'];
      const values: unknown[] = [];

      if (options.guildId) {
        conditions.push('guild_id = ?');
        values.push(options.guildId);
      }
      if (options.userId) {
        conditions.push('user_id = ?');
        values.push(options.userId);
      }
      if (options.sentiment !== undefined) {
        if (options.sentiment === null) {
          conditions.push('feedback_sentiment IS NULL');
        } else {
          conditions.push('feedback_sentiment = ?');
          values.push(options.sentiment);
        }
      }
      if (options.modelUsed) {
        conditions.push('model_used = ?');
        values.push(options.modelUsed);
      }
      if (options.experimentId) {
        conditions.push('experiment_id = ?');
        values.push(options.experimentId);
      }
      if (options.startDate) {
        conditions.push('started_at >= ?');
        values.push(options.startDate);
      }
      if (options.endDate) {
        conditions.push('started_at <= ?');
        values.push(options.endDate);
      }

      const limit = options.limit || 50;
      const offset = options.offset || 0;

      values.push(limit, offset);

      const traces = db.all(
        `SELECT
          id, message_id, user_id, guild_id, started_at, duration_ms,
          model_used, memories_retrieved_count, rules_applied_count,
          feedback_sentiment, success
         FROM generation_traces
         WHERE ${conditions.join(' AND ')}
         ORDER BY started_at DESC
         LIMIT ? OFFSET ?`,
        values
      );

      return traces.map((t: Record<string, unknown>) => ({
        id: t.id as string,
        messageId: t.message_id as string,
        userId: t.user_id as string,
        guildId: t.guild_id as string | null,
        startedAt: t.started_at as string,
        durationMs: t.duration_ms as number | null,
        modelUsed: t.model_used as string | null,
        memoriesRetrievedCount: (t.memories_retrieved_count as number) || 0,
        rulesAppliedCount: (t.rules_applied_count as number) || 0,
        feedbackSentiment: t.feedback_sentiment as string | null,
        success: Boolean(t.success),
      }));
    } catch (error) {
      logger.error('[trace] Failed to query traces:', error);
      return [];
    }
  }

  /**
   * Get aggregate statistics for analysis
   */
  async getStats(options: { guildId?: string; startDate?: string; endDate?: string }): Promise<{
    totalTraces: number;
    successRate: number;
    avgDurationMs: number;
    avgMemories: number;
    avgRules: number;
    positiveRate: number;
    negativeRate: number;
    modelBreakdown: Record<string, { count: number; positiveRate: number }>;
  }> {
    try {
      const db = getSyncDb();
      const conditions: string[] = ['1=1'];
      const values: unknown[] = [];

      if (options.guildId) {
        conditions.push('guild_id = ?');
        values.push(options.guildId);
      }
      if (options.startDate) {
        conditions.push('started_at >= ?');
        values.push(options.startDate);
      }
      if (options.endDate) {
        conditions.push('started_at <= ?');
        values.push(options.endDate);
      }

      const whereClause = conditions.join(' AND ');

      // Basic stats
      const basic = db.get(
        `SELECT
          COUNT(*) as total,
          AVG(CASE WHEN success = 1 THEN 100.0 ELSE 0.0 END) as success_rate,
          AVG(duration_ms) as avg_duration,
          AVG(memories_retrieved_count) as avg_memories,
          AVG(rules_applied_count) as avg_rules,
          SUM(CASE WHEN feedback_sentiment = 'positive' THEN 1 ELSE 0 END) as positive_count,
          SUM(CASE WHEN feedback_sentiment = 'negative' THEN 1 ELSE 0 END) as negative_count,
          SUM(CASE WHEN feedback_sentiment IS NOT NULL THEN 1 ELSE 0 END) as feedback_count
         FROM generation_traces
         WHERE ${whereClause}`,
        values
      );

      const totalFeedback = (basic?.feedback_count as number) || 0;
      const positiveCount = (basic?.positive_count as number) || 0;
      const negativeCount = (basic?.negative_count as number) || 0;

      // Model breakdown
      const models = db.all(
        `SELECT
          model_used,
          COUNT(*) as count,
          SUM(CASE WHEN feedback_sentiment = 'positive' THEN 1 ELSE 0 END) as positive,
          SUM(CASE WHEN feedback_sentiment IS NOT NULL THEN 1 ELSE 0 END) as with_feedback
         FROM generation_traces
         WHERE ${whereClause} AND model_used IS NOT NULL
         GROUP BY model_used`,
        values
      );

      const modelBreakdown: Record<string, { count: number; positiveRate: number }> = {};
      for (const m of models) {
        const model = m as {
          model_used: string;
          count: number;
          positive: number;
          with_feedback: number;
        };
        modelBreakdown[model.model_used] = {
          count: model.count,
          positiveRate:
            model.with_feedback > 0 ? Math.round((model.positive / model.with_feedback) * 100) : 0,
        };
      }

      return {
        totalTraces: (basic?.total as number) || 0,
        successRate: Math.round((basic?.success_rate as number) || 0),
        avgDurationMs: Math.round((basic?.avg_duration as number) || 0),
        avgMemories: Math.round(((basic?.avg_memories as number) || 0) * 10) / 10,
        avgRules: Math.round(((basic?.avg_rules as number) || 0) * 10) / 10,
        positiveRate: totalFeedback > 0 ? Math.round((positiveCount / totalFeedback) * 100) : 0,
        negativeRate: totalFeedback > 0 ? Math.round((negativeCount / totalFeedback) * 100) : 0,
        modelBreakdown,
      };
    } catch (error) {
      logger.error('[trace] Failed to get stats:', error);
      return {
        totalTraces: 0,
        successRate: 0,
        avgDurationMs: 0,
        avgMemories: 0,
        avgRules: 0,
        positiveRate: 0,
        negativeRate: 0,
        modelBreakdown: {},
      };
    }
  }
}

// Export singleton instance
export const traceManager = TraceManager.getInstance();
