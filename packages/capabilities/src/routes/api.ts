import { Router, Request, Response } from 'express';
import { logger, getDb, memories, messages, desc, sql, countDistinct, getSyncDb } from '@coachartie/shared';
import { errorPatternTracker } from '../services/llm/llm-error-pattern-tracker.js';
import { traceManager, experimentManager } from '../services/context-alchemy/index.js';
import type { ExperimentDefinition } from '../services/context-alchemy/experiment-manager.js';
import { evalHarness } from '../services/observability/eval-harness.js';
import { evalSuite, DEFAULT_TEST_SET, type Condition } from '../services/observability/eval-suite.js';

export const apiRouter = Router();

// ============================================================================
// CORE API ENDPOINTS
// ============================================================================

// GET /api/memories - Browse memories
apiRouter.get('/memories', async (_req: Request, res: Response) => {
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
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/messages - Browse messages
apiRouter.get('/messages', async (_req: Request, res: Response) => {
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
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/stats - General statistics
apiRouter.get('/stats', async (_req: Request, res: Response) => {
  try {
    const db = getDb();

    const [memoriesCount] = await db.select({ count: sql<number>`COUNT(*)` }).from(memories);
    const [messagesCount] = await db.select({ count: sql<number>`COUNT(*)` }).from(messages);
    const [usersCount] = await db
      .select({ count: countDistinct(messages.userId) })
      .from(messages);

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
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/error-analytics/user/:userId - User error statistics
apiRouter.get('/error-analytics/user/:userId', (req: Request, res: Response) => {
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
apiRouter.get('/error-analytics/global', (_req: Request, res: Response) => {
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
apiRouter.post('/traces/link-discord', async (req: Request, res: Response) => {
  try {
    const { jobId, discordMessageId } = req.body as {
      jobId: string;
      discordMessageId: string;
    };

    if (!jobId || !discordMessageId) {
      res.status(400).json({
        error: 'Missing required fields: jobId and discordMessageId',
      });
      return;
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
      res.json({ success: true });
    } else {
      // Trace might not exist yet (tracing disabled) - not an error
      logger.debug(`No trace found for job ${jobId.slice(-8)} (tracing may be disabled)`);
      res.json({ success: true, note: 'No trace found' });
    }
  } catch (error) {
    logger.error('Failed to link Discord message:', error);
    res.status(500).json({
      error: 'Failed to link Discord message',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/traces - Query traces with filtering
apiRouter.get('/traces', async (req: Request, res: Response) => {
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

    const traces = await traceManager.queryTraces({
      guildId: query.guildId,
      userId: query.userId,
      sentiment: query.sentiment as 'positive' | 'negative' | undefined,
      modelUsed: query.modelUsed,
      experimentId: query.experimentId,
      limit: query.limit ? parseInt(query.limit, 10) : 50,
      offset: query.offset ? parseInt(query.offset, 10) : 0,
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
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/traces/stats - Aggregate trace statistics
apiRouter.get('/traces/stats', async (req: Request, res: Response) => {
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
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/traces/:id - Get a single trace with full details
apiRouter.get('/traces/:id', async (req: Request, res: Response) => {
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
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/traces/feedback - Record feedback for a trace
apiRouter.post('/traces/feedback', async (req: Request, res: Response) => {
  try {
    const { discordMessageId, sentiment, emoji } = req.body as {
      discordMessageId: string;
      sentiment: 'positive' | 'negative';
      emoji: string;
    };

    if (!discordMessageId || !sentiment || !emoji) {
      res.status(400).json({
        error: 'Missing required fields: discordMessageId, sentiment, emoji',
      });
      return;
    }

    const success = await traceManager.recordFeedback(discordMessageId, sentiment, emoji);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({
        error: 'No trace found for this Discord message',
      });
    }
  } catch (error) {
    logger.error('Failed to record feedback:', error);
    res.status(500).json({
      error: 'Failed to record feedback',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================================================
// CONTEXT ALCHEMY - EXPERIMENT ENDPOINTS
// ============================================================================

// GET /api/experiments - List all experiments
apiRouter.get('/experiments', async (req: Request, res: Response) => {
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
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/experiments/:id - Get a single experiment
apiRouter.get('/experiments/:id', async (req: Request, res: Response) => {
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
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/experiments - Create a new experiment
apiRouter.post('/experiments', async (req: Request, res: Response) => {
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
      variants: body.variants.map(v => ({
        name: v.name,
        type: (v.type || v.variantType || 'feature') as 'model' | 'prompt' | 'parameter' | 'feature',
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
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/experiments/:id/start - Start an experiment
apiRouter.post('/experiments/:id/start', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await experimentManager.startExperiment(id);

    res.json({ success: true, message: 'Experiment started' });
  } catch (error) {
    logger.error('Failed to start experiment:', error);
    res.status(500).json({
      error: 'Failed to start experiment',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/experiments/:id/end - End an experiment
apiRouter.post('/experiments/:id/end', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await experimentManager.endExperiment(id);

    res.json({ success: true, message: 'Experiment ended' });
  } catch (error) {
    logger.error('Failed to end experiment:', error);
    res.status(500).json({
      error: 'Failed to end experiment',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/experiments/:id/results - Get experiment results
apiRouter.get('/experiments/:id/results', async (req: Request, res: Response) => {
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
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================================================
// CONTEXT ALCHEMY - ANALYSIS ENDPOINTS
// ============================================================================

// GET /api/analysis/feedback-by-model - Feedback rates by model
apiRouter.get('/analysis/feedback-by-model', async (req: Request, res: Response) => {
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
      positiveRate:
        (r.with_feedback as number) > 0
          ? Math.round(((r.positive as number) / (r.with_feedback as number)) * 100)
          : 0,
    }));

    res.json({
      analysis,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to analyze feedback by model:', error);
    res.status(500).json({
      error: 'Failed to analyze feedback by model',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/analysis/feedback-by-memory-count - Correlation between memory count and feedback
apiRouter.get('/analysis/feedback-by-memory-count', async (_req: Request, res: Response) => {
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
      positiveRate:
        (r.with_feedback as number) > 0
          ? Math.round(((r.positive as number) / (r.with_feedback as number)) * 100)
          : 0,
    }));

    res.json({
      analysis,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to analyze feedback by memory count:', error);
    res.status(500).json({
      error: 'Failed to analyze feedback by memory count',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/analysis/rule-effectiveness - How effective are learned rules
apiRouter.get('/analysis/rule-effectiveness', async (_req: Request, res: Response) => {
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
      positiveRate:
        (r.with_feedback as number) > 0
          ? Math.round(((r.positive as number) / (r.with_feedback as number)) * 100)
          : 0,
    }));

    res.json({
      analysis,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to analyze rule effectiveness:', error);
    res.status(500).json({
      error: 'Failed to analyze rule effectiveness',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================================================
// EVALUATION HARNESS - LLM-as-Judge Endpoints
// ============================================================================

// POST /api/eval/response - Evaluate a single response
apiRouter.post('/eval/response', async (req: Request, res: Response) => {
  try {
    const { traceId, userMessage, response, experimentId, variantId } = req.body as {
      traceId: string;
      userMessage: string;
      response: string;
      experimentId?: string;
      variantId?: string;
    };

    if (!traceId || !userMessage || !response) {
      res.status(400).json({
        error: 'Missing required fields: traceId, userMessage, response',
      });
      return;
    }

    const result = await evalHarness.evaluateResponse(
      traceId,
      userMessage,
      response,
      experimentId,
      variantId
    );

    res.json({ success: true, result });
  } catch (error) {
    logger.error('Failed to evaluate response:', error);
    res.status(500).json({
      error: 'Failed to evaluate response',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/eval/compare - Pairwise comparison of two responses
apiRouter.post('/eval/compare', async (req: Request, res: Response) => {
  try {
    const {
      experimentId,
      traceIdA, traceIdB,
      variantIdA, variantIdB,
      userMessage,
      responseA, responseB
    } = req.body as {
      experimentId: string;
      traceIdA: string;
      traceIdB: string;
      variantIdA: string;
      variantIdB: string;
      userMessage: string;
      responseA: string;
      responseB: string;
    };

    if (!experimentId || !traceIdA || !traceIdB || !userMessage || !responseA || !responseB) {
      res.status(400).json({
        error: 'Missing required fields',
      });
      return;
    }

    const result = await evalHarness.comparePair(
      experimentId,
      traceIdA, traceIdB,
      variantIdA, variantIdB,
      userMessage,
      responseA, responseB
    );

    res.json({ success: true, result });
  } catch (error) {
    logger.error('Failed to compare responses:', error);
    res.status(500).json({
      error: 'Failed to compare responses',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/eval/experiment/:id - Run evaluation on experiment traces
apiRouter.post('/eval/experiment/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { limit } = req.body as { limit?: number };

    const results = await evalHarness.evaluateExperiment(id, limit || 50);

    res.json({
      success: true,
      experimentId: id,
      ...results,
    });
  } catch (error) {
    logger.error('Failed to evaluate experiment:', error);
    res.status(500).json({
      error: 'Failed to evaluate experiment',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/eval/experiment/:id/stats - Get evaluation statistics
apiRouter.get('/eval/experiment/:id/stats', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const stats = await evalHarness.getExperimentStats(id);

    res.json({
      success: true,
      experimentId: id,
      ...stats,
    });
  } catch (error) {
    logger.error('Failed to get eval stats:', error);
    res.status(500).json({
      error: 'Failed to get evaluation statistics',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/eval/leaderboard - Compare variants across all experiments
apiRouter.get('/eval/leaderboard', async (_req: Request, res: Response) => {
  try {
    const db = getSyncDb();

    // Get aggregate scores by variant across all experiments
    const leaderboard = db.all(
      `SELECT
        ev.experiment_id,
        ev.variant_id,
        e.name as experiment_name,
        COUNT(*) as eval_count,
        ROUND(AVG(ev.overall_score), 2) as avg_score,
        ROUND(AVG(ev.helpfulness), 2) as avg_helpfulness,
        ROUND(AVG(ev.accuracy), 2) as avg_accuracy,
        ROUND(AVG(ev.coherence), 2) as avg_coherence
      FROM eval_results ev
      JOIN experiments e ON ev.experiment_id = e.id
      GROUP BY ev.experiment_id, ev.variant_id
      ORDER BY avg_score DESC`
    ) || [];

    // Get pairwise win rates
    const winRates = db.all(
      `SELECT
        winner_variant_id,
        COUNT(*) as wins,
        (SELECT COUNT(*) FROM pairwise_results WHERE experiment_id = pr.experiment_id) as total
      FROM pairwise_results pr
      WHERE winner_variant_id IS NOT NULL
      GROUP BY experiment_id, winner_variant_id`
    ) || [];

    res.json({
      leaderboard,
      winRates,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to get leaderboard:', error);
    res.status(500).json({
      error: 'Failed to get leaderboard',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================================================
// PROACTIVE EVAL SUITE - Scientific A/B Testing
// ============================================================================

// GET /api/eval/suite/runs - List all proactive eval runs
apiRouter.get('/eval/suite/runs', async (_req: Request, res: Response) => {
  try {
    const runs = await evalSuite.listRuns();
    res.json({
      runs,
      count: runs.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to list eval runs:', error);
    res.status(500).json({
      error: 'Failed to list eval runs',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/eval/suite/runs/:id - Get results for a specific run
apiRouter.get('/eval/suite/runs/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const results = await evalSuite.getRunResults(id);

    if (!results) {
      res.status(404).json({ error: 'Eval run not found' });
      return;
    }

    res.json({ results });
  } catch (error) {
    logger.error('Failed to get eval run results:', error);
    res.status(500).json({
      error: 'Failed to get eval run results',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/eval/suite/test-set - Get the default test set prompts
apiRouter.get('/eval/suite/test-set', (_req: Request, res: Response) => {
  res.json({
    testSet: DEFAULT_TEST_SET,
    count: DEFAULT_TEST_SET.length,
    categories: [...new Set(DEFAULT_TEST_SET.map(p => p.category))],
  });
});

// POST /api/eval/suite/run - Start a new proactive evaluation
apiRouter.post('/eval/suite/run', async (req: Request, res: Response) => {
  try {
    const {
      name,
      conditions,
      testSet,
      judgeModel,
      generationsPerPrompt
    } = req.body as {
      name: string;
      conditions: Condition[];
      testSet?: typeof DEFAULT_TEST_SET;
      judgeModel?: string;
      generationsPerPrompt?: number;
    };

    if (!name || !conditions?.length) {
      res.status(400).json({
        error: 'Missing required fields: name, conditions (array of {id, name, config})',
      });
      return;
    }

    // Validate conditions have required fields
    for (const cond of conditions) {
      if (!cond.id || !cond.name) {
        res.status(400).json({
          error: 'Each condition must have id and name',
        });
        return;
      }
    }

    // Run the eval (this can take a while - for now, synchronous)
    // TODO: Make this async with a job queue
    const summary = await evalSuite.runEval(
      name,
      conditions,
      testSet || DEFAULT_TEST_SET,
      {
        judgeModel,
        generationsPerPrompt,
      }
    );

    res.json({
      success: true,
      summary,
    });
  } catch (error) {
    logger.error('Failed to run eval suite:', error);
    res.status(500).json({
      error: 'Failed to run eval suite',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/eval/suite/quick - Quick 2-condition comparison with defaults
apiRouter.post('/eval/suite/quick', async (req: Request, res: Response) => {
  try {
    const {
      name,
      modelA,
      modelB,
      promptCount,
      judgeModel
    } = req.body as {
      name?: string;
      modelA: string;
      modelB: string;
      promptCount?: number;
      judgeModel?: string;
    };

    if (!modelA || !modelB) {
      res.status(400).json({
        error: 'Missing required fields: modelA, modelB',
        example: {
          modelA: 'anthropic/claude-3-5-sonnet',
          modelB: 'google/gemini-flash-1.5',
          promptCount: 6,
        },
      });
      return;
    }

    const conditions: Condition[] = [
      {
        id: 'model-a',
        name: modelA.split('/').pop() || modelA,
        description: `Using ${modelA}`,
        config: { model: modelA },
      },
      {
        id: 'model-b',
        name: modelB.split('/').pop() || modelB,
        description: `Using ${modelB}`,
        config: { model: modelB },
      },
    ];

    // Use subset of test set if requested
    const testSet = promptCount
      ? DEFAULT_TEST_SET.slice(0, promptCount)
      : DEFAULT_TEST_SET;

    const evalName = name || `${conditions[0].name} vs ${conditions[1].name}`;

    const summary = await evalSuite.runEval(
      evalName,
      conditions,
      testSet,
      { judgeModel }
    );

    res.json({
      success: true,
      summary,
    });
  } catch (error) {
    logger.error('Failed to run quick eval:', error);
    res.status(500).json({
      error: 'Failed to run quick eval',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================================================
// TEST SET MANAGEMENT - Versioned Prompt Sets
// ============================================================================

// GET /api/eval/suite/test-sets - List all test sets
apiRouter.get('/eval/suite/test-sets', async (_req: Request, res: Response) => {
  try {
    const testSets = await evalSuite.listTestSets();
    res.json({
      testSets,
      count: testSets.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to list test sets:', error);
    res.status(500).json({
      error: 'Failed to list test sets',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/eval/suite/test-sets/:id - Get a specific test set with prompts
apiRouter.get('/eval/suite/test-sets/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await evalSuite.getTestSet(id);

    if (!result) {
      res.status(404).json({ error: 'Test set not found' });
      return;
    }

    res.json({
      testSet: result.set,
      prompts: result.prompts,
      count: result.prompts.length,
    });
  } catch (error) {
    logger.error('Failed to get test set:', error);
    res.status(500).json({
      error: 'Failed to get test set',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/eval/suite/test-sets - Create a new test set
apiRouter.post('/eval/suite/test-sets', async (req: Request, res: Response) => {
  try {
    const { name, description, prompts, isDefault } = req.body as {
      name: string;
      description?: string;
      prompts: Array<{
        id: string;
        category: string;
        difficulty?: string;
        prompt: string;
        context?: string;
      }>;
      isDefault?: boolean;
    };

    if (!name || !prompts?.length) {
      res.status(400).json({
        error: 'Missing required fields: name, prompts',
        example: {
          name: 'My Test Set',
          description: 'A custom test set',
          prompts: [
            { id: 'test-1', category: 'factual', prompt: 'What is 2+2?' },
          ],
        },
      });
      return;
    }

    // Normalize prompts
    const normalizedPrompts = prompts.map(p => ({
      id: p.id,
      category: p.category,
      difficulty: (p.difficulty || 'medium') as 'easy' | 'medium' | 'hard',
      prompt: p.prompt,
      context: p.context,
    }));

    const result = await evalSuite.createTestSet(name, normalizedPrompts, {
      description,
      isDefault,
    });

    res.json({
      success: true,
      testSetId: result.id,
      version: result.version,
      promptCount: prompts.length,
    });
  } catch (error) {
    logger.error('Failed to create test set:', error);
    res.status(500).json({
      error: 'Failed to create test set',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/eval/suite/test-sets/seed-default - Ensure default test set exists
apiRouter.post('/eval/suite/test-sets/seed-default', async (_req: Request, res: Response) => {
  try {
    const result = await evalSuite.getOrCreateDefaultTestSet();
    res.json({
      success: true,
      testSetId: result.id,
      promptCount: result.prompts.length,
    });
  } catch (error) {
    logger.error('Failed to seed default test set:', error);
    res.status(500).json({
      error: 'Failed to seed default test set',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
