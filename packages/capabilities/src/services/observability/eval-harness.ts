/**
 * Evaluation Harness - LLM-as-Judge for A/B Testing
 *
 * Provides rigorous evaluation of response quality using:
 * - Multi-dimensional scoring (helpfulness, accuracy, tone, etc.)
 * - Blind pairwise comparison (A vs B without knowing which is which)
 * - LLM-as-judge using strong model (Claude/GPT-4)
 * - Statistical analysis with confidence intervals
 */

import { logger, getSyncDb } from '@coachartie/shared';
import { v4 as uuidv4 } from 'uuid';

// Evaluation dimensions - each scored 1-5
export interface EvalDimensions {
  helpfulness: number;      // Did it answer the question/request?
  accuracy: number;         // Is the information correct?
  relevance: number;        // Is the response on-topic?
  coherence: number;        // Is it well-structured and clear?
  tone: number;             // Is the tone appropriate (friendly, professional)?
  conciseness: number;      // Is it appropriately brief (not verbose)?
}

export interface EvalResult {
  id: string;
  traceId: string;
  experimentId: string | null;
  variantId: string | null;

  // The inputs
  userMessage: string;
  response: string;

  // Scores
  dimensions: EvalDimensions;
  overallScore: number;     // Weighted average

  // Metadata
  judgeModel: string;
  evaluatedAt: string;
  rawJudgment: string;      // Full LLM response for debugging
}

export interface PairwiseResult {
  id: string;
  experimentId: string;

  // The comparison
  traceIdA: string;
  traceIdB: string;
  variantIdA: string;
  variantIdB: string;

  // Same prompt, different responses
  userMessage: string;
  responseA: string;
  responseB: string;

  // Judgment
  winner: 'A' | 'B' | 'tie';
  winnerVariantId: string | null;
  reasoning: string;
  confidence: number;       // 1-5 how confident is the judge

  // Metadata
  judgeModel: string;
  evaluatedAt: string;
}

// Weights for overall score calculation
const DIMENSION_WEIGHTS: Record<keyof EvalDimensions, number> = {
  helpfulness: 0.25,
  accuracy: 0.20,
  relevance: 0.20,
  coherence: 0.15,
  tone: 0.10,
  conciseness: 0.10,
};

class EvalHarness {
  private static instance: EvalHarness;
  private judgeModel = 'anthropic/claude-sonnet-4'; // Strong model for judging

  static getInstance(): EvalHarness {
    if (!EvalHarness.instance) {
      EvalHarness.instance = new EvalHarness();
    }
    return EvalHarness.instance;
  }

  /**
   * Evaluate a single response on multiple dimensions
   */
  async evaluateResponse(
    traceId: string,
    userMessage: string,
    response: string,
    experimentId?: string | null,
    variantId?: string | null
  ): Promise<EvalResult> {
    const evalPrompt = `You are evaluating an AI assistant's response quality. Be critical and objective.

USER MESSAGE:
"${userMessage}"

AI RESPONSE:
"${response}"

Rate the response on each dimension from 1-5:
- 1 = Very Poor
- 2 = Poor
- 3 = Acceptable
- 4 = Good
- 5 = Excellent

Respond in this exact JSON format:
{
  "helpfulness": <1-5>,
  "accuracy": <1-5>,
  "relevance": <1-5>,
  "coherence": <1-5>,
  "tone": <1-5>,
  "conciseness": <1-5>,
  "reasoning": "<brief explanation of your ratings>"
}

DIMENSION DEFINITIONS:
- helpfulness: Did it actually help with what was asked?
- accuracy: Is the information factually correct? (3 if can't verify)
- relevance: Does it stay on topic without tangents?
- coherence: Is it well-organized and easy to follow?
- tone: Is the tone appropriate for the context?
- conciseness: Is it appropriately brief without being terse?`;

    try {
      const { openRouterService } = await import('../llm/openrouter.js');

      const judgment = await openRouterService.generateFromMessageChain(
        [
          { role: 'system', content: 'You are an expert evaluator of AI responses. Output only valid JSON.' },
          { role: 'user', content: evalPrompt }
        ],
        'eval-harness',
        undefined,
        this.judgeModel
      );

      // Parse the JSON response
      const jsonMatch = judgment.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in judge response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      const dimensions: EvalDimensions = {
        helpfulness: this.clampScore(parsed.helpfulness),
        accuracy: this.clampScore(parsed.accuracy),
        relevance: this.clampScore(parsed.relevance),
        coherence: this.clampScore(parsed.coherence),
        tone: this.clampScore(parsed.tone),
        conciseness: this.clampScore(parsed.conciseness),
      };

      const overallScore = this.calculateOverallScore(dimensions);

      const result: EvalResult = {
        id: uuidv4(),
        traceId,
        experimentId: experimentId || null,
        variantId: variantId || null,
        userMessage,
        response,
        dimensions,
        overallScore,
        judgeModel: this.judgeModel,
        evaluatedAt: new Date().toISOString(),
        rawJudgment: judgment,
      };

      // Store in database
      await this.storeEvalResult(result);

      logger.info(`📊 Eval complete: trace=${traceId.slice(0,8)} score=${overallScore.toFixed(2)}`);
      return result;

    } catch (error) {
      logger.error('Eval failed:', error);
      throw error;
    }
  }

  /**
   * Pairwise comparison - which response is better?
   * Responses are shown in random order to prevent position bias
   */
  async comparePair(
    experimentId: string,
    traceIdA: string,
    traceIdB: string,
    variantIdA: string,
    variantIdB: string,
    userMessage: string,
    responseA: string,
    responseB: string
  ): Promise<PairwiseResult> {
    // Randomize order to prevent position bias
    const showAFirst = Math.random() > 0.5;
    const first = showAFirst ? { response: responseA, label: 'A' } : { response: responseB, label: 'B' };
    const second = showAFirst ? { response: responseB, label: 'B' } : { response: responseA, label: 'A' };

    const comparePrompt = `You are comparing two AI responses to the same user message. Be objective and critical.

USER MESSAGE:
"${userMessage}"

RESPONSE 1:
"${first.response}"

RESPONSE 2:
"${second.response}"

Which response is better overall? Consider helpfulness, accuracy, clarity, and appropriateness.

Respond in this exact JSON format:
{
  "winner": <1 or 2 or "tie">,
  "confidence": <1-5>,
  "reasoning": "<brief explanation of why you chose this winner>"
}

Be decisive - only call it a tie if they are truly equivalent.`;

    try {
      const { openRouterService } = await import('../llm/openrouter.js');

      const judgment = await openRouterService.generateFromMessageChain(
        [
          { role: 'system', content: 'You are an expert evaluator. Output only valid JSON.' },
          { role: 'user', content: comparePrompt }
        ],
        'eval-harness',
        undefined,
        this.judgeModel
      );

      const jsonMatch = judgment.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in judge response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Map the randomized winner back to A/B
      let winner: 'A' | 'B' | 'tie';
      if (parsed.winner === 'tie' || parsed.winner === '"tie"') {
        winner = 'tie';
      } else if (parsed.winner === 1 || parsed.winner === '1') {
        winner = first.label as 'A' | 'B';
      } else {
        winner = second.label as 'A' | 'B';
      }

      const result: PairwiseResult = {
        id: uuidv4(),
        experimentId,
        traceIdA,
        traceIdB,
        variantIdA,
        variantIdB,
        userMessage,
        responseA,
        responseB,
        winner,
        winnerVariantId: winner === 'A' ? variantIdA : winner === 'B' ? variantIdB : null,
        reasoning: parsed.reasoning || '',
        confidence: this.clampScore(parsed.confidence),
        judgeModel: this.judgeModel,
        evaluatedAt: new Date().toISOString(),
      };

      await this.storePairwiseResult(result);

      logger.info(`📊 Pairwise eval: winner=${winner} (${winner === 'A' ? variantIdA.slice(0,8) : winner === 'B' ? variantIdB.slice(0,8) : 'tie'})`);
      return result;

    } catch (error) {
      logger.error('Pairwise eval failed:', error);
      throw error;
    }
  }

  /**
   * Run evaluation on recent traces for an experiment
   */
  async evaluateExperiment(experimentId: string, limit: number = 50): Promise<{
    evaluated: number;
    byVariant: Record<string, { count: number; avgScore: number; scores: number[] }>;
  }> {
    const db = getSyncDb();

    // Get recent traces for this experiment
    const traces = db.all<{
      id: string;
      variant_id: string;
      message_id: string;
    }>(
      `SELECT gt.id, gt.variant_id, gt.message_id
       FROM generation_traces gt
       WHERE gt.experiment_id = ? AND gt.success = 1
       ORDER BY gt.started_at DESC
       LIMIT ?`,
      [experimentId, limit]
    );

    if (!traces || traces.length === 0) {
      return { evaluated: 0, byVariant: {} };
    }

    const byVariant: Record<string, { count: number; avgScore: number; scores: number[] }> = {};
    let evaluated = 0;

    for (const trace of traces) {
      // Get the snapshot for this trace
      const snapshot = db.get<{
        message_chain_json: string;
        full_response: string;
      }>(
        `SELECT message_chain_json, full_response FROM context_snapshots WHERE trace_id = ?`,
        [trace.id]
      );

      if (!snapshot?.full_response) continue;

      // Extract user message from message chain
      let userMessage = '';
      try {
        const chain = JSON.parse(snapshot.message_chain_json);
        const userMsg = chain.find((m: any) => m.role === 'user');
        userMessage = userMsg?.content || '';
      } catch {
        continue;
      }

      if (!userMessage) continue;

      // Evaluate this response
      const result = await this.evaluateResponse(
        trace.id,
        userMessage,
        snapshot.full_response,
        experimentId,
        trace.variant_id
      );

      // Aggregate by variant
      if (!byVariant[trace.variant_id]) {
        byVariant[trace.variant_id] = { count: 0, avgScore: 0, scores: [] };
      }
      byVariant[trace.variant_id].count++;
      byVariant[trace.variant_id].scores.push(result.overallScore);

      evaluated++;
    }

    // Calculate averages
    for (const variantId of Object.keys(byVariant)) {
      const variant = byVariant[variantId];
      variant.avgScore = variant.scores.reduce((a, b) => a + b, 0) / variant.scores.length;
    }

    return { evaluated, byVariant };
  }

  /**
   * Get evaluation statistics for an experiment
   */
  async getExperimentStats(experimentId: string): Promise<{
    totalEvals: number;
    byVariant: Record<string, {
      count: number;
      avgScore: number;
      dimensions: Record<keyof EvalDimensions, number>;
    }>;
    pairwise: {
      total: number;
      wins: Record<string, number>;
      winRate: Record<string, number>;
    };
  }> {
    const db = getSyncDb();

    // Get dimension-level stats by variant
    const evalStats = db.all<{
      variant_id: string;
      count: number;
      avg_overall: number;
      avg_helpfulness: number;
      avg_accuracy: number;
      avg_relevance: number;
      avg_coherence: number;
      avg_tone: number;
      avg_conciseness: number;
    }>(
      `SELECT
        variant_id,
        COUNT(*) as count,
        AVG(overall_score) as avg_overall,
        AVG(helpfulness) as avg_helpfulness,
        AVG(accuracy) as avg_accuracy,
        AVG(relevance) as avg_relevance,
        AVG(coherence) as avg_coherence,
        AVG(tone) as avg_tone,
        AVG(conciseness) as avg_conciseness
       FROM eval_results
       WHERE experiment_id = ?
       GROUP BY variant_id`,
      [experimentId]
    ) || [];

    // Get pairwise comparison stats
    const pairwiseStats = db.all<{
      winner_variant_id: string;
      wins: number;
    }>(
      `SELECT winner_variant_id, COUNT(*) as wins
       FROM pairwise_results
       WHERE experiment_id = ? AND winner_variant_id IS NOT NULL
       GROUP BY winner_variant_id`,
      [experimentId]
    ) || [];

    const totalPairwise = db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM pairwise_results WHERE experiment_id = ?`,
      [experimentId]
    )?.count || 0;

    // Build response
    const byVariant: Record<string, any> = {};
    for (const stat of evalStats) {
      byVariant[stat.variant_id] = {
        count: stat.count,
        avgScore: stat.avg_overall,
        dimensions: {
          helpfulness: stat.avg_helpfulness,
          accuracy: stat.avg_accuracy,
          relevance: stat.avg_relevance,
          coherence: stat.avg_coherence,
          tone: stat.avg_tone,
          conciseness: stat.avg_conciseness,
        },
      };
    }

    const wins: Record<string, number> = {};
    const winRate: Record<string, number> = {};
    for (const stat of pairwiseStats) {
      wins[stat.winner_variant_id] = stat.wins;
      winRate[stat.winner_variant_id] = totalPairwise > 0 ? stat.wins / totalPairwise : 0;
    }

    return {
      totalEvals: evalStats.reduce((sum, s) => sum + s.count, 0),
      byVariant,
      pairwise: {
        total: totalPairwise,
        wins,
        winRate,
      },
    };
  }

  // Helper methods
  private clampScore(score: number): number {
    return Math.max(1, Math.min(5, Math.round(score)));
  }

  private calculateOverallScore(dimensions: EvalDimensions): number {
    let total = 0;
    for (const [dim, weight] of Object.entries(DIMENSION_WEIGHTS)) {
      total += dimensions[dim as keyof EvalDimensions] * weight;
    }
    return Math.round(total * 100) / 100;
  }

  private async storeEvalResult(result: EvalResult): Promise<void> {
    const db = getSyncDb();

    db.run(
      `INSERT INTO eval_results (
        id, trace_id, experiment_id, variant_id,
        user_message, response,
        helpfulness, accuracy, relevance, coherence, tone, conciseness,
        overall_score, judge_model, evaluated_at, raw_judgment
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        result.id,
        result.traceId,
        result.experimentId,
        result.variantId,
        result.userMessage,
        result.response,
        result.dimensions.helpfulness,
        result.dimensions.accuracy,
        result.dimensions.relevance,
        result.dimensions.coherence,
        result.dimensions.tone,
        result.dimensions.conciseness,
        result.overallScore,
        result.judgeModel,
        result.evaluatedAt,
        result.rawJudgment,
      ]
    );
  }

  private async storePairwiseResult(result: PairwiseResult): Promise<void> {
    const db = getSyncDb();

    db.run(
      `INSERT INTO pairwise_results (
        id, experiment_id,
        trace_id_a, trace_id_b, variant_id_a, variant_id_b,
        user_message, response_a, response_b,
        winner, winner_variant_id, reasoning, confidence,
        judge_model, evaluated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        result.id,
        result.experimentId,
        result.traceIdA,
        result.traceIdB,
        result.variantIdA,
        result.variantIdB,
        result.userMessage,
        result.responseA,
        result.responseB,
        result.winner,
        result.winnerVariantId,
        result.reasoning,
        result.confidence,
        result.judgeModel,
        result.evaluatedAt,
      ]
    );
  }
}

export const evalHarness = EvalHarness.getInstance();
