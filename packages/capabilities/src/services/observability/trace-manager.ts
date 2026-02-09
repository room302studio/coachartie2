/**
 * Trace Manager - Core observability for LLM generations
 *
 * Tracks every LLM call with:
 * - Timing metrics (start, end, duration)
 * - Context assembly metrics (memories, rules, tokens)
 * - Model selection and cost
 * - Experiment assignment
 * - Feedback correlation (via Discord message ID)
 *
 * Part of the Context Alchemy observability stack.
 */

import { logger, getSyncDb } from '@coachartie/shared';
import { v4 as uuidv4 } from 'uuid';

// Environment configuration
const ENABLE_TRACING = process.env.ENABLE_TRACING !== 'false';
const SNAPSHOT_SAMPLE_RATE = parseFloat(process.env.SNAPSHOT_SAMPLE_RATE || '0.01'); // 1% default
const CAPTURE_ALL_SNAPSHOTS = process.env.CAPTURE_ALL_SNAPSHOTS === 'true';

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
  modelTier?: 'fast' | 'smart' | 'manager';
  contextTokenCount?: number;
  memoriesRetrievedCount?: number;
  rulesAppliedCount?: number;
  rulesAppliedIds?: string; // JSON array
  responseLength?: number;
  responseTokens?: number;
  estimatedCost?: number;
  experimentId?: string;
  variantId?: string;
  success?: boolean;
  errorType?: string;
  discordMessageId?: string;
}

export interface ContextSource {
  source: string;
  content: string;
  tokenCount?: number;
}

export interface SnapshotData {
  systemPrompt: string;
  contextSources: ContextSource[];
  messageChain: Array<{ role: string; content: string }>;
  response?: string;
}

class TraceManager {
  private static instance: TraceManager;

  static getInstance(): TraceManager {
    if (!TraceManager.instance) {
      TraceManager.instance = new TraceManager();
    }
    return TraceManager.instance;
  }

  /**
   * Check if tracing is enabled
   */
  isEnabled(): boolean {
    return ENABLE_TRACING;
  }

  /**
   * Create a new trace for an LLM generation
   * Returns the trace ID to be passed through the generation pipeline
   */
  async createTrace(data: TraceCreateData): Promise<string> {
    if (!ENABLE_TRACING) {
      return ''; // Return empty string when tracing is disabled
    }

    const traceId = uuidv4();
    const startedAt = new Date().toISOString();

    try {
      const db = getSyncDb();
      db.run(
        `INSERT INTO generation_traces (id, message_id, user_id, guild_id, channel_id, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [traceId, data.messageId, data.userId, data.guildId || null, data.channelId || null, startedAt]
      );

      logger.debug(`📊 Trace created: ${traceId.slice(0, 8)}... for message ${data.messageId}`);
      return traceId;
    } catch (error) {
      logger.error('Failed to create trace:', error);
      return ''; // Fail silently - tracing shouldn't break the main flow
    }
  }

  /**
   * Update an existing trace with additional data
   * Called multiple times during generation to add metrics incrementally
   */
  async updateTrace(traceId: string, updates: TraceUpdateData): Promise<void> {
    if (!ENABLE_TRACING || !traceId) {
      return;
    }

    try {
      const db = getSyncDb();

      // Build dynamic update query
      const setClauses: string[] = [];
      const values: (string | number | null)[] = [];

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
      if (updates.discordMessageId !== undefined) {
        setClauses.push('discord_message_id = ?');
        values.push(updates.discordMessageId);
      }

      if (setClauses.length === 0) {
        return; // Nothing to update
      }

      values.push(traceId);

      db.run(
        `UPDATE generation_traces SET ${setClauses.join(', ')} WHERE id = ?`,
        values
      );

      logger.debug(`📊 Trace updated: ${traceId.slice(0, 8)}...`);
    } catch (error) {
      logger.error('Failed to update trace:', error);
      // Fail silently
    }
  }

  /**
   * Link a Discord message ID to a trace for feedback correlation
   * Called after the response is sent to Discord
   */
  async linkDiscordMessage(traceId: string, discordMessageId: string): Promise<void> {
    if (!ENABLE_TRACING || !traceId || !discordMessageId) {
      return;
    }

    try {
      const db = getSyncDb();
      db.run(
        `UPDATE generation_traces SET discord_message_id = ? WHERE id = ?`,
        [discordMessageId, traceId]
      );

      logger.debug(`📊 Trace ${traceId.slice(0, 8)}... linked to Discord message ${discordMessageId}`);
    } catch (error) {
      logger.error('Failed to link Discord message:', error);
    }
  }

  /**
   * Record feedback on a trace (called when user reacts to a message)
   * Looks up the trace by Discord message ID
   */
  async recordFeedback(
    discordMessageId: string,
    sentiment: 'positive' | 'negative',
    emoji: string
  ): Promise<void> {
    if (!ENABLE_TRACING || !discordMessageId) {
      return;
    }

    try {
      const db = getSyncDb();
      const feedbackAt = new Date().toISOString();

      const result = db.run(
        `UPDATE generation_traces
         SET feedback_sentiment = ?, feedback_emoji = ?, feedback_at = ?
         WHERE discord_message_id = ?`,
        [sentiment, emoji, feedbackAt, discordMessageId]
      );

      if (result.changes > 0) {
        logger.info(`📊 Feedback recorded: ${sentiment} (${emoji}) for message ${discordMessageId}`);

        // Also update experiment variant stats if applicable
        const trace = db.get<{ experiment_id: string | null; variant_id: string | null }>(
          `SELECT experiment_id, variant_id FROM generation_traces WHERE discord_message_id = ?`,
          [discordMessageId]
        );

        if (trace?.experiment_id && trace.variant_id) {
          const column = sentiment === 'positive' ? 'positive_count' : 'negative_count';
          db.run(
            `UPDATE experiment_variants SET ${column} = ${column} + 1 WHERE id = ?`,
            [trace.variant_id]
          );
          logger.debug(`📊 Updated experiment ${trace.experiment_id} variant ${trace.variant_id} ${sentiment} count`);
        }
      }
    } catch (error) {
      logger.error('Failed to record feedback:', error);
    }
  }

  /**
   * Capture a full context snapshot for a trace (sampled)
   * Only captures based on sample rate to manage storage
   */
  async captureSnapshot(traceId: string, data: SnapshotData): Promise<void> {
    if (!ENABLE_TRACING || !traceId) {
      return;
    }

    // Check if we should capture this snapshot
    const shouldCapture = CAPTURE_ALL_SNAPSHOTS || Math.random() < SNAPSHOT_SAMPLE_RATE;
    if (!shouldCapture) {
      return;
    }

    try {
      const db = getSyncDb();

      db.run(
        `INSERT INTO context_snapshots (trace_id, system_prompt, context_sources_json, message_chain_json, full_response)
         VALUES (?, ?, ?, ?, ?)`,
        [
          traceId,
          data.systemPrompt,
          JSON.stringify(data.contextSources),
          JSON.stringify(data.messageChain),
          data.response || null,
        ]
      );

      logger.debug(`📊 Context snapshot captured for trace ${traceId.slice(0, 8)}...`);
    } catch (error) {
      logger.error('Failed to capture snapshot:', error);
    }
  }

  /**
   * Update snapshot with the final response
   */
  async updateSnapshotResponse(traceId: string, response: string): Promise<void> {
    if (!ENABLE_TRACING || !traceId) {
      return;
    }

    try {
      const db = getSyncDb();
      db.run(
        `UPDATE context_snapshots SET full_response = ? WHERE trace_id = ?`,
        [response, traceId]
      );
    } catch (error) {
      logger.error('Failed to update snapshot response:', error);
    }
  }

  /**
   * Get a trace by ID
   */
  async getTrace(traceId: string): Promise<any | null> {
    try {
      const db = getSyncDb();
      return db.get(
        `SELECT * FROM generation_traces WHERE id = ?`,
        [traceId]
      );
    } catch (error) {
      logger.error('Failed to get trace:', error);
      return null;
    }
  }

  /**
   * Get traces with optional filtering
   */
  async getTraces(options: {
    guildId?: string;
    userId?: string;
    sentiment?: 'positive' | 'negative' | null;
    experimentId?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<any[]> {
    try {
      const db = getSyncDb();
      const conditions: string[] = [];
      const values: (string | number | null)[] = [];

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
      if (options.experimentId) {
        conditions.push('experiment_id = ?');
        values.push(options.experimentId);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = options.limit || 50;
      const offset = options.offset || 0;

      return db.all(
        `SELECT * FROM generation_traces ${whereClause} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
        [...values, limit, offset]
      ) || [];
    } catch (error) {
      logger.error('Failed to get traces:', error);
      return [];
    }
  }

  /**
   * Get analytics summary for a time period
   */
  async getAnalyticsSummary(options: {
    guildId?: string;
    days?: number;
  } = {}): Promise<{
    totalGenerations: number;
    feedbackRate: number;
    positiveRate: number;
    avgDurationMs: number;
    avgTokens: number;
    totalCost: number;
    byModel: Record<string, { count: number; positiveRate: number }>;
  }> {
    try {
      const db = getSyncDb();
      const days = options.days || 7;
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      const conditions = ['started_at > ?'];
      const values: (string | number)[] = [cutoff];

      if (options.guildId) {
        conditions.push('guild_id = ?');
        values.push(options.guildId);
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      // Overall stats
      const overall = db.get<{
        total: number;
        with_feedback: number;
        positive: number;
        avg_duration: number;
        avg_tokens: number;
        total_cost: number;
      }>(
        `SELECT
          COUNT(*) as total,
          SUM(CASE WHEN feedback_sentiment IS NOT NULL THEN 1 ELSE 0 END) as with_feedback,
          SUM(CASE WHEN feedback_sentiment = 'positive' THEN 1 ELSE 0 END) as positive,
          AVG(duration_ms) as avg_duration,
          AVG(response_tokens) as avg_tokens,
          SUM(estimated_cost) as total_cost
         FROM generation_traces ${whereClause}`,
        values
      );

      // By model
      const byModelRows = db.all<{
        model_used: string;
        count: number;
        positive: number;
        with_feedback: number;
      }>(
        `SELECT
          model_used,
          COUNT(*) as count,
          SUM(CASE WHEN feedback_sentiment = 'positive' THEN 1 ELSE 0 END) as positive,
          SUM(CASE WHEN feedback_sentiment IS NOT NULL THEN 1 ELSE 0 END) as with_feedback
         FROM generation_traces ${whereClause}
         GROUP BY model_used`,
        values
      );

      const byModel: Record<string, { count: number; positiveRate: number }> = {};
      for (const row of byModelRows || []) {
        if (row.model_used) {
          byModel[row.model_used] = {
            count: row.count,
            positiveRate: row.with_feedback > 0 ? row.positive / row.with_feedback : 0,
          };
        }
      }

      return {
        totalGenerations: overall?.total || 0,
        feedbackRate: overall?.total ? (overall.with_feedback || 0) / overall.total : 0,
        positiveRate: overall?.with_feedback ? (overall.positive || 0) / overall.with_feedback : 0,
        avgDurationMs: overall?.avg_duration || 0,
        avgTokens: overall?.avg_tokens || 0,
        totalCost: overall?.total_cost || 0,
        byModel,
      };
    } catch (error) {
      logger.error('Failed to get analytics summary:', error);
      return {
        totalGenerations: 0,
        feedbackRate: 0,
        positiveRate: 0,
        avgDurationMs: 0,
        avgTokens: 0,
        totalCost: 0,
        byModel: {},
      };
    }
  }
}

export const traceManager = TraceManager.getInstance();
