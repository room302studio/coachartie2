import { Router, Request, Response } from 'express';
import { logger } from '../../shared/logger.js';
import { type ApiResult, sendResult } from '../../shared/api-result.js';
import { getErrorMessage } from '../../shared/errors.js';

// Wave 9: the handler body is an exported function returning the status + JSON it used to
// send; the route sends it and engine/api.ts calls it in-process for the gateway.
const reply = (status: number, body: any): ApiResult => ({ status, body });
import { getDb, desc, sql, countDistinct, getSyncDb } from '../../shared/db/client.js';
import { memories, messages } from '../../shared/db/schema.js';
import { errorPatternTracker } from '../capabilities/error-patterns.js';
import { traceManager } from '../2-turn/trace.js';
import { experimentManager } from '../3-context/experiments.js';
import type { ExperimentDefinition } from '../3-context/experiments.js';
import { memoryStore } from '../memory/store.js';
import { percentOf } from '../../shared/numbers.js';


export const observabilityRouter: ReturnType<typeof Router> = Router();

// ============================================================================
// CORE API ENDPOINTS
// ============================================================================

// GET /api/memories - Browse memories
observabilityRouter.get('/memories', async (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const result = await db
      .select({
        id: memories.id,
        user_id: memories.userId,
        content: memories.content,
        metadata: memories.metadata,
        created_at: memories.createdAt,
        updated_at: memories.updatedAt,
      })
      .from(memories)
      .orderBy(desc(memories.createdAt))
      .limit(50);

    res.json({
      memories: result,
      total: result.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('❌ Error fetching memories:', error);
    res.status(500).json({
      error: 'Failed to fetch memories',
      message: getErrorMessage(error),
    });
  }
});

// GET /api/messages - Browse messages
observabilityRouter.get('/messages', async (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const result = await db
      .select({
        id: messages.id,
        user_id: messages.userId,
        message: messages.value,
        role: messages.role,
        created_at: messages.createdAt,
      })
      .from(messages)
      .orderBy(desc(messages.createdAt))
      .limit(50);

    res.json({
      messages: result,
      total: result.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('❌ Error fetching messages:', error);
    res.status(500).json({
      error: 'Failed to fetch messages',
      message: getErrorMessage(error),
    });
  }
});

// GET /api/stats - General statistics
observabilityRouter.get('/stats', async (_req: Request, res: Response) => {
  try {
    const db = getDb();

    const [memoriesCount] = await db.select({ count: sql<number>`COUNT(*)` }).from(memories);
    const [messagesCount] = await db.select({ count: sql<number>`COUNT(*)` }).from(messages);
    const [usersCount] = await db.select({ count: countDistinct(messages.userId) }).from(messages);

    const stats = {
      memories: memoriesCount?.count || 0,
      messages: messagesCount?.count || 0,
      users: usersCount?.count || 0,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };

    res.json({ stats });
  } catch (error) {
    logger.error('❌ Error generating stats:', error);
    res.status(500).json({
      error: 'Failed to generate stats',
      message: getErrorMessage(error),
    });
  }
});

// GET /api/error-analytics/user/:userId - User error statistics
observabilityRouter.get('/error-analytics/user/:userId', (req: Request, res: Response) => {
  const { userId } = req.params;
  const stats = errorPatternTracker.getUserErrorStats(userId);
  const preventionTips = errorPatternTracker.getPreventionTips(userId);

  res.json({
    userId,
    stats,
    preventionTips: preventionTips || 'No error patterns recorded yet',
  });
});

// GET /api/error-analytics/global - Global error statistics
observabilityRouter.get('/error-analytics/global', (_req: Request, res: Response) => {
  const stats = errorPatternTracker.getGlobalErrorStats();

  res.json({
    timestamp: new Date().toISOString(),
    ...stats,
  });
});

// ============================================================================
// CONTEXT ALCHEMY - TRACE ENDPOINTS
// ============================================================================

// POST /api/traces/link-discord - Link Discord message ID to trace
observabilityRouter.post('/traces/link-discord', async (req: Request, res: Response) =>
  sendResult(res, await linkDiscordMessage(req.body))
);

// GET /api/traces - Query traces with filtering
observabilityRouter.get('/traces', async (req: Request, res: Response) => {
  try {
    const query = req.query as {
      guildId?: string;
      userId?: string;
      sentiment?: string;
      modelUsed?: string;
      experimentId?: string;
      limit?: string;
      offset?: string;
    };

    let limit: number;
    if (query.limit) {
      limit = parseInt(query.limit, 10);
    } else {
      limit = 50;
    }
    let offset: number;
    if (query.offset) {
      offset = parseInt(query.offset, 10);
    } else {
      offset = 0;
    }

    const traces = await traceManager.queryTraces({
      guildId: query.guildId,
      userId: query.userId,
      sentiment: query.sentiment as 'positive' | 'negative' | undefined,
      modelUsed: query.modelUsed,
      experimentId: query.experimentId,
      limit,
      offset,
    });

    res.json({
      traces,
      count: traces.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to query traces:', error);
    res.status(500).json({
      error: 'Failed to query traces',
      message: getErrorMessage(error),
    });
  }
});

// GET /api/traces/stats - Aggregate trace statistics
observabilityRouter.get('/traces/stats', async (req: Request, res: Response) => {
  try {
    const query = req.query as {
      guildId?: string;
      startDate?: string;
      endDate?: string;
    };

    const stats = await traceManager.getStats({
      guildId: query.guildId,
      startDate: query.startDate,
      endDate: query.endDate,
    });

    res.json({
      ...stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to get trace stats:', error);
    res.status(500).json({
      error: 'Failed to get trace stats',
      message: getErrorMessage(error),
    });
  }
});

// GET /api/traces/:id - Get a single trace with full details
observabilityRouter.get('/traces/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const trace = await traceManager.getTrace(id);

    if (!trace) {
      res.status(404).json({ error: 'Trace not found' });
      return;
    }

    res.json({ trace });
  } catch (error) {
    logger.error('Failed to get trace:', error);
    res.status(500).json({
      error: 'Failed to get trace',
      message: getErrorMessage(error),
    });
  }
});

// POST /api/traces/feedback - Record feedback for a trace
observabilityRouter.post('/traces/feedback', async (req: Request, res: Response) =>
  sendResult(res, await recordTraceFeedback(req.body))
);

// ============================================================================
// CONTEXT ALCHEMY - EXPERIMENT ENDPOINTS
// ============================================================================

// GET /api/experiments - List all experiments
observabilityRouter.get('/experiments', async (req: Request, res: Response) => {
  try {
    const query = req.query as { status?: string };
    const experiments = await experimentManager.listExperiments(
      query.status as 'draft' | 'active' | 'completed' | 'cancelled' | undefined
    );

    res.json({
      experiments,
      count: experiments.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to list experiments:', error);
    res.status(500).json({
      error: 'Failed to list experiments',
      message: getErrorMessage(error),
    });
  }
});

// GET /api/experiments/:id - Get a single experiment
observabilityRouter.get('/experiments/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const experiment = await experimentManager.getExperiment(id);

    if (!experiment) {
      res.status(404).json({ error: 'Experiment not found' });
      return;
    }

    res.json({ experiment });
  } catch (error) {
    logger.error('Failed to get experiment:', error);
    res.status(500).json({
      error: 'Failed to get experiment',
      message: getErrorMessage(error),
    });
  }
});

// POST /api/experiments - Create a new experiment
observabilityRouter.post('/experiments', async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      name?: string;
      hypothesis?: string;
      targetType?: string;
      targetIds?: string[];
      trafficPercent?: number;
      variants?: Array<{
        name: string;
        type?: string;
        variantType?: string; // Accept both for API flexibility
        config: Record<string, unknown>;
        weight?: number;
      }>;
    };

    if (!body.name || !body.targetType || !body.variants?.length) {
      res.status(400).json({
        error: 'Missing required fields: name, targetType, variants',
      });
      return;
    }

    // Normalize variants: accept both 'type' and 'variantType'
    const definition: ExperimentDefinition = {
      name: body.name,
      hypothesis: body.hypothesis,
      targetType: body.targetType as 'global' | 'guild' | 'user',
      targetIds: body.targetIds,
      trafficPercent: body.trafficPercent,
      variants: body.variants.map((v) => ({
        name: v.name,
        type: (v.type || v.variantType || 'feature') as
          | 'model'
          | 'prompt'
          | 'parameter'
          | 'feature',
        config: v.config as any,
        weight: v.weight,
      })),
    };

    const experimentId = await experimentManager.createExperiment(definition);

    res.json({
      success: true,
      experimentId,
      message: 'Experiment created in draft status. Use POST /experiments/:id/start to activate.',
    });
  } catch (error) {
    logger.error('Failed to create experiment:', error);
    res.status(500).json({
      error: 'Failed to create experiment',
      message: getErrorMessage(error),
    });
  }
});

// POST /api/experiments/:id/start - Start an experiment
observabilityRouter.post('/experiments/:id/start', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await experimentManager.startExperiment(id);

    res.json({ success: true, message: 'Experiment started' });
  } catch (error) {
    logger.error('Failed to start experiment:', error);
    res.status(500).json({
      error: 'Failed to start experiment',
      message: getErrorMessage(error),
    });
  }
});

// POST /api/experiments/:id/end - End an experiment
observabilityRouter.post('/experiments/:id/end', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await experimentManager.endExperiment(id);

    res.json({ success: true, message: 'Experiment ended' });
  } catch (error) {
    logger.error('Failed to end experiment:', error);
    res.status(500).json({
      error: 'Failed to end experiment',
      message: getErrorMessage(error),
    });
  }
});

// GET /api/experiments/:id/results - Get experiment results
observabilityRouter.get('/experiments/:id/results', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const results = await experimentManager.getResults(id);

    if (!results) {
      res.status(404).json({ error: 'Experiment not found' });
      return;
    }

    res.json({ results });
  } catch (error) {
    logger.error('Failed to get experiment results:', error);
    res.status(500).json({
      error: 'Failed to get experiment results',
      message: getErrorMessage(error),
    });
  }
});

// ============================================================================
// CONTEXT ALCHEMY - ANALYSIS ENDPOINTS
// ============================================================================

// GET /api/analysis/feedback-by-model - Feedback rates by model
observabilityRouter.get('/analysis/feedback-by-model', async (req: Request, res: Response) => {
  try {
    const query = req.query as { startDate?: string; endDate?: string };
    const db = getSyncDb();

    const conditions: string[] = ['model_used IS NOT NULL'];
    const values: string[] = [];

    if (query.startDate) {
      conditions.push('started_at >= ?');
      values.push(query.startDate);
    }
    if (query.endDate) {
      conditions.push('started_at <= ?');
      values.push(query.endDate);
    }

    const results = db.all(
      `SELECT
        model_used as model,
        COUNT(*) as total,
        AVG(memories_retrieved_count) as avg_memories,
        AVG(rules_applied_count) as avg_rules,
        SUM(CASE WHEN feedback_sentiment = 'positive' THEN 1 ELSE 0 END) as positive,
        SUM(CASE WHEN feedback_sentiment = 'negative' THEN 1 ELSE 0 END) as negative,
        SUM(CASE WHEN feedback_sentiment IS NOT NULL THEN 1 ELSE 0 END) as with_feedback
      FROM generation_traces
      WHERE ${conditions.join(' AND ')}
      GROUP BY model_used
      ORDER BY total DESC`,
      values
    );

    const analysis = results.map((r: Record<string, unknown>) => ({
      model: r.model,
      total: r.total,
      avgMemories: Math.round(((r.avg_memories as number) || 0) * 10) / 10,
      avgRules: Math.round(((r.avg_rules as number) || 0) * 10) / 10,
      positive: r.positive || 0,
      negative: r.negative || 0,
      withFeedback: r.with_feedback || 0,
      positiveRate: percentOf(
        r.positive as number,
        r.with_feedback as number
      ),
    }));

    res.json({
      analysis,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to analyze feedback by model:', error);
    res.status(500).json({
      error: 'Failed to analyze feedback by model',
      message: getErrorMessage(error),
    });
  }
});

// GET /api/analysis/feedback-by-memory-count - Correlation between memory count and feedback
observabilityRouter.get('/analysis/feedback-by-memory-count', async (_req: Request, res: Response) => {
  try {
    const db = getSyncDb();

    const results = db.all(
      `SELECT
        CASE
          WHEN memories_retrieved_count = 0 THEN '0'
          WHEN memories_retrieved_count BETWEEN 1 AND 3 THEN '1-3'
          WHEN memories_retrieved_count BETWEEN 4 AND 7 THEN '4-7'
          ELSE '8+'
        END as memory_bucket,
        COUNT(*) as total,
        SUM(CASE WHEN feedback_sentiment = 'positive' THEN 1 ELSE 0 END) as positive,
        SUM(CASE WHEN feedback_sentiment = 'negative' THEN 1 ELSE 0 END) as negative,
        SUM(CASE WHEN feedback_sentiment IS NOT NULL THEN 1 ELSE 0 END) as with_feedback
      FROM generation_traces
      WHERE started_at > datetime('now', '-30 days')
      GROUP BY memory_bucket
      ORDER BY memories_retrieved_count`
    );

    const analysis = results.map((r: Record<string, unknown>) => ({
      memoryBucket: r.memory_bucket,
      total: r.total,
      positive: r.positive || 0,
      negative: r.negative || 0,
      withFeedback: r.with_feedback || 0,
      positiveRate: percentOf(
        r.positive as number,
        r.with_feedback as number
      ),
    }));

    res.json({
      analysis,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to analyze feedback by memory count:', error);
    res.status(500).json({
      error: 'Failed to analyze feedback by memory count',
      message: getErrorMessage(error),
    });
  }
});

// GET /api/analysis/rule-effectiveness - How effective are learned rules
observabilityRouter.get('/analysis/rule-effectiveness', async (_req: Request, res: Response) => {
  try {
    const db = getSyncDb();

    // This is a more complex query that joins with learned_rules
    // For now, we'll analyze by rules_applied_count buckets
    const results = db.all(
      `SELECT
        CASE
          WHEN rules_applied_count = 0 THEN '0 rules'
          WHEN rules_applied_count BETWEEN 1 AND 2 THEN '1-2 rules'
          WHEN rules_applied_count BETWEEN 3 AND 5 THEN '3-5 rules'
          ELSE '6+ rules'
        END as rules_bucket,
        COUNT(*) as total,
        SUM(CASE WHEN feedback_sentiment = 'positive' THEN 1 ELSE 0 END) as positive,
        SUM(CASE WHEN feedback_sentiment = 'negative' THEN 1 ELSE 0 END) as negative,
        SUM(CASE WHEN feedback_sentiment IS NOT NULL THEN 1 ELSE 0 END) as with_feedback
      FROM generation_traces
      WHERE started_at > datetime('now', '-30 days')
      GROUP BY rules_bucket
      ORDER BY rules_applied_count`
    );

    const analysis = results.map((r: Record<string, unknown>) => ({
      rulesBucket: r.rules_bucket,
      total: r.total,
      positive: r.positive || 0,
      negative: r.negative || 0,
      withFeedback: r.with_feedback || 0,
      positiveRate: percentOf(
        r.positive as number,
        r.with_feedback as number
      ),
    }));

    res.json({
      analysis,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to analyze rule effectiveness:', error);
    res.status(500).json({
      error: 'Failed to analyze rule effectiveness',
      message: getErrorMessage(error),
    });
  }
});

// ============================================================================
// MEMORY RECALL ANALYTICS
// ============================================================================

// GET /api/memories/most-recalled - Get most frequently accessed memories
observabilityRouter.get('/memories/most-recalled', (_req: Request, res: Response) => {
  try {
    const limit = parseInt(_req.query.limit as string) || 20;
    const memories = memoryStore.getMostRecalledMemories(limit);

    res.json({
      memories,
      count: memories.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to get most recalled memories:', error);
    res.status(500).json({
      error: 'Failed to get most recalled memories',
      message: getErrorMessage(error),
    });
  }
});

// GET /api/memories/:id/recall-stats - Get recall statistics for a specific memory
observabilityRouter.get('/memories/:id/recall-stats', (req: Request, res: Response) => {
  try {
    const memoryId = parseInt(req.params.id);
    const stats = memoryStore.getMemoryRecallStats(memoryId);

    if (!stats) {
      res.status(404).json({ error: 'Memory not found' });
      return;
    }

    res.json({
      memoryId,
      ...stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to get memory recall stats:', error);
    res.status(500).json({
      error: 'Failed to get memory recall stats',
      message: getErrorMessage(error),
    });
  }
});

// GET /api/memories/recall-history - Get recent recall events
observabilityRouter.get('/memories/recall-history', (_req: Request, res: Response) => {
  try {
    const limit = parseInt(_req.query.limit as string) || 50;
    const db = getSyncDb();

    const recalls =
      db.all(
        `SELECT mr.*, m.content as memory_preview
       FROM memory_recalls mr
       JOIN memories m ON mr.memory_id = m.id
       ORDER BY mr.recalled_at DESC
       LIMIT ?`,
        [limit]
      ) || [];

    res.json({
      recalls: recalls.map((r: Record<string, unknown>) => {
        let memoryPreview: string;
        if (typeof r.memory_preview === 'string') {
          memoryPreview = r.memory_preview.substring(0, 100);
        } else {
          memoryPreview = '';
        }
        return {
          id: r.id,
          memoryId: r.memory_id,
          memoryPreview,
          recalledAt: r.recalled_at,
          context: r.context,
          userId: r.user_id,
          guildId: r.guild_id,
        };
      }),
      count: recalls.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to get recall history:', error);
    res.status(500).json({
      error: 'Failed to get recall history',
      message: getErrorMessage(error),
    });
  }
});

// ============================================================================
// EXTENDED OBSERVABILITY - Sessions, Capabilities, Errors
// ============================================================================

// GET /api/analytics/sessions/daily-active-users - DAU over time
observabilityRouter.get('/analytics/sessions/daily-active-users', (_req: Request, res: Response) => {
  try {
    const days = parseInt(_req.query.days as string) || 30;
    const db = getSyncDb();

    const results = db.all(
      `SELECT
        DATE(started_at) as date,
        COUNT(DISTINCT user_id) as dau,
        COUNT(*) as sessions,
        SUM(message_count) as total_messages
      FROM user_sessions
      WHERE started_at > datetime('now', '-' || ? || ' days')
      GROUP BY DATE(started_at)
      ORDER BY date DESC`,
      [days]
    ) || [];

    res.json({
      data: results,
      days,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to get DAU:', error);
    res.status(500).json({
      error: 'Failed to get DAU',
      message: getErrorMessage(error),
    });
  }
});

// GET /api/analytics/sessions/duration-distribution - Session length distribution
observabilityRouter.get('/analytics/sessions/duration-distribution', (_req: Request, res: Response) => {
  try {
    const db = getSyncDb();

    const results = db.all(
      `SELECT
        CASE
          WHEN total_duration_ms < 60000 THEN '<1min'
          WHEN total_duration_ms < 300000 THEN '1-5min'
          WHEN total_duration_ms < 900000 THEN '5-15min'
          WHEN total_duration_ms < 1800000 THEN '15-30min'
          ELSE '>30min'
        END as duration_bucket,
        COUNT(*) as sessions,
        AVG(message_count) as avg_messages
      FROM user_sessions
      WHERE ended_at IS NOT NULL
        AND started_at > datetime('now', '-7 days')
      GROUP BY duration_bucket
      ORDER BY
        CASE duration_bucket
          WHEN '<1min' THEN 1
          WHEN '1-5min' THEN 2
          WHEN '5-15min' THEN 3
          WHEN '15-30min' THEN 4
          ELSE 5
        END`
    ) || [];

    res.json({
      distribution: results,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to get session distribution:', error);
    res.status(500).json({
      error: 'Failed to get session distribution',
      message: getErrorMessage(error),
    });
  }
});

// GET /api/analytics/capabilities/usage - Capability usage statistics
observabilityRouter.get('/analytics/capabilities/usage', (_req: Request, res: Response) => {
  try {
    const days = parseInt(_req.query.days as string) || 7;
    const db = getSyncDb();

    const results = db.all(
      `SELECT
        capability_name,
        action,
        COUNT(*) as total,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures,
        ROUND(AVG(duration_ms), 0) as avg_duration_ms,
        MAX(duration_ms) as max_duration_ms
      FROM capability_invocations
      WHERE started_at > datetime('now', '-' || ? || ' days')
      GROUP BY capability_name, action
      ORDER BY total DESC
      LIMIT 50`,
      [days]
    ) || [];

    res.json({
      capabilities: results.map((r: Record<string, unknown>) => ({
        name: r.capability_name,
        action: r.action,
        total: r.total,
        failures: r.failures || 0,
        failureRate: percentOf(
          r.failures as number || 0,
          r.total as number
        ),
        avgDurationMs: r.avg_duration_ms,
        maxDurationMs: r.max_duration_ms,
      })),
      days,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to get capability usage:', error);
    res.status(500).json({
      error: 'Failed to get capability usage',
      message: getErrorMessage(error),
    });
  }
});

// GET /api/analytics/errors/by-type - Error breakdown by type
observabilityRouter.get('/analytics/errors/by-type', (_req: Request, res: Response) => {
  try {
    const days = parseInt(_req.query.days as string) || 7;
    const db = getSyncDb();

    const results = db.all(
      `SELECT
        error_type,
        service,
        severity,
        COUNT(*) as count,
        SUM(CASE WHEN recovered = 1 THEN 1 ELSE 0 END) as recovered
      FROM error_events
      WHERE created_at > datetime('now', '-' || ? || ' days')
      GROUP BY error_type, service, severity
      ORDER BY count DESC`,
      [days]
    ) || [];

    res.json({
      errors: results,
      days,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to get errors by type:', error);
    res.status(500).json({
      error: 'Failed to get errors by type',
      message: getErrorMessage(error),
    });
  }
});

// GET /api/analytics/errors/recent - Recent errors
observabilityRouter.get('/analytics/errors/recent', (_req: Request, res: Response) => {
  try {
    const limit = parseInt(_req.query.limit as string) || 50;
    const db = getSyncDb();

    const results = db.all(
      `SELECT
        id, error_type, error_code, severity, service,
        message, recovered, recovery_action, retry_count,
        created_at, trace_id, user_id
      FROM error_events
      ORDER BY created_at DESC
      LIMIT ?`,
      [limit]
    ) || [];

    res.json({
      errors: results,
      count: results.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to get recent errors:', error);
    res.status(500).json({
      error: 'Failed to get recent errors',
      message: getErrorMessage(error),
    });
  }
});

// GET /api/analytics/traces/with-text - Get traces with input/response text for debugging
observabilityRouter.get('/analytics/traces/with-text', (_req: Request, res: Response) => {
  try {
    const limit = parseInt(_req.query.limit as string) || 20;
    const sentiment = _req.query.sentiment as string;
    const db = getSyncDb();

    let query = `SELECT
      id, user_id, guild_id, started_at, duration_ms,
      model_used, success, error_type,
      feedback_sentiment, feedback_emoji,
      input_text, response_text
    FROM generation_traces
    WHERE input_text IS NOT NULL OR response_text IS NOT NULL`;

    const values: unknown[] = [];
    if (sentiment === 'positive' || sentiment === 'negative') {
      query += ` AND feedback_sentiment = ?`;
      values.push(sentiment);
    }

    query += ` ORDER BY started_at DESC LIMIT ?`;
    values.push(limit);

    const results = db.all(query, values) || [];

    res.json({
      traces: results.map((r: Record<string, unknown>) => ({
        id: r.id,
        userId: r.user_id,
        guildId: r.guild_id,
        startedAt: r.started_at,
        durationMs: r.duration_ms,
        modelUsed: r.model_used,
        success: r.success,
        errorType: r.error_type,
        feedbackSentiment: r.feedback_sentiment,
        feedbackEmoji: r.feedback_emoji,
        inputText: r.input_text,
        responseText: r.response_text,
      })),
      count: results.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to get traces with text:', error);
    res.status(500).json({
      error: 'Failed to get traces with text',
      message: getErrorMessage(error),
    });
  }
});

// GET /api/analytics/delivery/stats - Delivery attempt statistics
observabilityRouter.get('/analytics/delivery/stats', async (_req: Request, res: Response) => {
  try {
    const { deliveryManager } = await import('../proactive/delivery.js');
    const days = parseInt(_req.query.days as string) || 7;
    const stats = await deliveryManager.getStats(days);

    res.json({
      ...stats,
      period: `${days} days`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to get delivery stats:', error);
    res.status(500).json({
      error: 'Failed to get delivery stats',
      message: getErrorMessage(error),
    });
  }
});

// GET /api/analytics/delivery/recent - Recent delivery attempts
observabilityRouter.get('/analytics/delivery/recent', (_req: Request, res: Response) => {
  try {
    const limit = parseInt(_req.query.limit as string) || 50;
    const status = _req.query.status as string;
    const db = getSyncDb();

    let query = `SELECT * FROM delivery_attempts`;
    const values: unknown[] = [];

    if (status) {
      query += ` WHERE status = ?`;
      values.push(status);
    }

    query += ` ORDER BY created_at DESC LIMIT ?`;
    values.push(limit);

    const results = db.all(query, values) || [];

    res.json({
      attempts: results,
      count: results.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to get recent delivery attempts:', error);
    res.status(500).json({
      error: 'Failed to get recent delivery attempts',
      message: getErrorMessage(error),
    });
  }
});

/** POST /api/traces/link-discord's body: tie the Discord reply's id to its generation trace. */
export async function linkDiscordMessage(body: any): Promise<ApiResult> {
  try {
    const { jobId, discordMessageId } = body as {
      jobId: string;
      discordMessageId: string;
    };

    if (!jobId || !discordMessageId) {
      return reply(400, {
        error: 'Missing required fields: jobId and discordMessageId',
      });
    }

    // The jobId is the messageId used when creating the trace
    // We need to find the trace by messageId and update it
    const db = getSyncDb();
    const result = db.run(
      `UPDATE generation_traces SET discord_message_id = ? WHERE message_id = ?`,
      [discordMessageId, jobId]
    );

    if (result.changes > 0) {
      logger.debug(`Linked Discord message ${discordMessageId} to job ${jobId.slice(-8)}`);
      return reply(200, { success: true });
    } else {
      // Trace might not exist yet (tracing disabled) - not an error
      logger.debug(`No trace found for job ${jobId.slice(-8)} (tracing may be disabled)`);
      return reply(200, { success: true, note: 'No trace found' });
    }
  } catch (error) {
    logger.error('Failed to link Discord message:', error);
    return reply(500, {
      error: 'Failed to link Discord message',
      message: getErrorMessage(error),
    });
  }
}

/** POST /api/traces/feedback's body: record a 👍/👎 reaction against the reply's trace. */
export async function recordTraceFeedback(body: any): Promise<ApiResult> {
  try {
    const { discordMessageId, sentiment, emoji } = body as {
      discordMessageId: string;
      sentiment: 'positive' | 'negative';
      emoji: string;
    };

    if (!discordMessageId || !sentiment || !emoji) {
      return reply(400, {
        error: 'Missing required fields: discordMessageId, sentiment, emoji',
      });
    }

    const success = await traceManager.recordFeedback(discordMessageId, sentiment, emoji);

    if (success) {
      return reply(200, { success: true });
    } else {
      return reply(404, {
        error: 'No trace found for this Discord message',
      });
    }
  } catch (error) {
    logger.error('Failed to record feedback:', error);
    return reply(500, {
      error: 'Failed to record feedback',
      message: getErrorMessage(error),
    });
  }
}
