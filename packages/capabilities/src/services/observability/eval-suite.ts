/**
 * Evaluation Suite - Proactive Scientific Testing
 *
 * Proper A/B testing methodology:
 * 1. Define a TEST SET of representative prompts
 * 2. Generate responses from EACH condition (same prompts)
 * 3. Blind pairwise evaluation (LLM-as-judge, randomized order)
 * 4. Statistical analysis with confidence intervals
 *
 * This is how you do science - controlled conditions, same inputs, blind comparison.
 */

import { logger, getSyncDb } from '@coachartie/shared';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// TEST SET - Representative prompts for evaluation
// ============================================================================

export interface TestPrompt {
  id: string;
  category: string;
  prompt: string;
  context?: string;  // Optional context/system prompt additions
  difficulty: 'easy' | 'medium' | 'hard';
}

// Default test set - diverse prompts covering different capabilities
export const DEFAULT_TEST_SET: TestPrompt[] = [
  // Factual/Knowledge
  { id: 'fact-1', category: 'factual', difficulty: 'easy',
    prompt: 'What causes the seasons on Earth?' },
  { id: 'fact-2', category: 'factual', difficulty: 'medium',
    prompt: 'Explain how a neural network learns, in simple terms.' },
  { id: 'fact-3', category: 'factual', difficulty: 'hard',
    prompt: 'What are the key differences between TCP and UDP, and when would you use each?' },

  // Reasoning/Problem-solving
  { id: 'reason-1', category: 'reasoning', difficulty: 'easy',
    prompt: 'I have 3 apples. I give away 1 and buy 4 more. How many do I have?' },
  { id: 'reason-2', category: 'reasoning', difficulty: 'medium',
    prompt: 'A bat and ball cost $1.10 total. The bat costs $1 more than the ball. How much does the ball cost?' },
  { id: 'reason-3', category: 'reasoning', difficulty: 'hard',
    prompt: 'Design a simple system to fairly distribute limited resources among competing teams with different needs.' },

  // Creative
  { id: 'creative-1', category: 'creative', difficulty: 'easy',
    prompt: 'Write a haiku about coding late at night.' },
  { id: 'creative-2', category: 'creative', difficulty: 'medium',
    prompt: 'Come up with 3 unique startup ideas combining AI and gardening.' },
  { id: 'creative-3', category: 'creative', difficulty: 'hard',
    prompt: 'Write a short scene where two characters debate whether consciousness can exist in machines.' },

  // Emotional/Empathy
  { id: 'empathy-1', category: 'emotional', difficulty: 'easy',
    prompt: "I'm feeling stressed about an upcoming deadline. Any advice?" },
  { id: 'empathy-2', category: 'emotional', difficulty: 'medium',
    prompt: "My friend is going through a tough breakup. How can I be supportive without being pushy?" },
  { id: 'empathy-3', category: 'emotional', difficulty: 'hard',
    prompt: "I made a mistake at work that hurt my team. I feel terrible. How do I move forward?" },

  // Task/Instruction Following
  { id: 'task-1', category: 'task', difficulty: 'easy',
    prompt: 'List 5 healthy breakfast options.' },
  { id: 'task-2', category: 'task', difficulty: 'medium',
    prompt: 'Create a weekly meal plan for someone trying to eat more vegetables.' },
  { id: 'task-3', category: 'task', difficulty: 'hard',
    prompt: 'Design a 30-day learning plan to go from zero to basic conversational Spanish.' },

  // Conversational
  { id: 'conv-1', category: 'conversational', difficulty: 'easy',
    prompt: 'Hey, how are you doing today?' },
  { id: 'conv-2', category: 'conversational', difficulty: 'medium',
    prompt: "I've been thinking about learning to play guitar. Worth it?" },
  { id: 'conv-3', category: 'conversational', difficulty: 'hard',
    prompt: "What's your take on work-life balance? I feel like I'm always connected." },
];

// ============================================================================
// EXPERIMENT CONDITION
// ============================================================================

export interface Condition {
  id: string;
  name: string;
  description: string;
  config: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    systemPromptOverride?: string;
    systemPromptAppend?: string;
  };
}

// ============================================================================
// GENERATION & EVALUATION
// ============================================================================

export interface Generation {
  id: string;
  runId: string;
  promptId: string;
  conditionId: string;
  prompt: string;
  response: string;
  latencyMs: number;
  tokenCount: number;
  generatedAt: string;
}

export interface PairwiseJudgment {
  id: string;
  runId: string;
  promptId: string;
  conditionA: string;
  conditionB: string;
  generationA: string;
  generationB: string;
  winner: 'A' | 'B' | 'tie';
  confidence: number;  // 1-5
  reasoning: string;
  judgeModel: string;
  judgedAt: string;
}

export interface EvalRunSummary {
  runId: string;
  name: string;
  startedAt: string;
  completedAt: string | null;
  conditions: Condition[];
  promptCount: number;
  generationCount: number;
  judgmentCount: number;
  results: {
    conditionId: string;
    conditionName: string;
    wins: number;
    losses: number;
    ties: number;
    winRate: number;
    ciLow: number;   // 95% CI lower bound
    ciHigh: number;  // 95% CI upper bound
  }[];
}

// ============================================================================
// EVAL SUITE CLASS
// ============================================================================

class EvalSuite {
  private static instance: EvalSuite;
  private judgeModel = 'anthropic/claude-sonnet-4';

  static getInstance(): EvalSuite {
    if (!EvalSuite.instance) {
      EvalSuite.instance = new EvalSuite();
    }
    return EvalSuite.instance;
  }

  /**
   * Run a complete evaluation comparing multiple conditions
   */
  async runEval(
    name: string,
    conditions: Condition[],
    testSet: TestPrompt[] = DEFAULT_TEST_SET,
    options: {
      generationsPerPrompt?: number;  // For statistical power, generate N times
      judgeModel?: string;
    } = {}
  ): Promise<EvalRunSummary> {
    const runId = uuidv4();
    const startedAt = new Date().toISOString();
    const generationsPerPrompt = options.generationsPerPrompt || 1;

    if (options.judgeModel) {
      this.judgeModel = options.judgeModel;
    }

    logger.info(`🧪 Starting eval run: ${name} (${runId.slice(0,8)})`);
    logger.info(`   Conditions: ${conditions.map(c => c.name).join(', ')}`);
    logger.info(`   Prompts: ${testSet.length}`);
    logger.info(`   Generations per prompt: ${generationsPerPrompt}`);

    // Store run metadata
    await this.storeRun(runId, name, conditions, testSet.length);

    // Step 1: Generate responses for each prompt × condition
    const generations: Generation[] = [];

    for (const prompt of testSet) {
      for (const condition of conditions) {
        for (let i = 0; i < generationsPerPrompt; i++) {
          try {
            const gen = await this.generateResponse(runId, prompt, condition);
            generations.push(gen);
            await this.storeGeneration(gen);
            logger.info(`   ✓ Generated: ${prompt.id} × ${condition.name}`);
          } catch (error) {
            logger.error(`   ✗ Failed: ${prompt.id} × ${condition.name}:`, error);
          }
        }
      }
    }

    // Step 2: Pairwise comparisons (all pairs of conditions)
    const judgments: PairwiseJudgment[] = [];
    const conditionPairs = this.getAllPairs(conditions);

    for (const prompt of testSet) {
      for (const [condA, condB] of conditionPairs) {
        // Get generations for this prompt and these conditions
        const genA = generations.find(g => g.promptId === prompt.id && g.conditionId === condA.id);
        const genB = generations.find(g => g.promptId === prompt.id && g.conditionId === condB.id);

        if (!genA || !genB) continue;

        try {
          const judgment = await this.judgeComparison(runId, prompt, genA, genB, condA, condB);
          judgments.push(judgment);
          await this.storeJudgment(judgment);
          logger.info(`   ⚖️ Judged: ${prompt.id} | ${condA.name} vs ${condB.name} → ${judgment.winner}`);
        } catch (error) {
          logger.error(`   ✗ Judge failed: ${prompt.id}:`, error);
        }
      }
    }

    // Step 3: Compute statistics
    const results = this.computeResults(conditions, judgments);

    // Update run as complete
    const completedAt = new Date().toISOString();
    await this.completeRun(runId, completedAt);

    const summary: EvalRunSummary = {
      runId,
      name,
      startedAt,
      completedAt,
      conditions,
      promptCount: testSet.length,
      generationCount: generations.length,
      judgmentCount: judgments.length,
      results,
    };

    // Store summary
    await this.storeSummary(summary);

    logger.info(`🎉 Eval complete: ${name}`);
    this.printResults(summary);

    return summary;
  }

  /**
   * Generate a response for a prompt under a specific condition
   */
  private async generateResponse(
    runId: string,
    prompt: TestPrompt,
    condition: Condition
  ): Promise<Generation> {
    const { openRouterService } = await import('../llm/openrouter.js');
    const { promptManager } = await import('../llm/prompt-manager.js');

    const startTime = Date.now();

    // Build system prompt
    let systemPrompt = condition.config.systemPromptOverride ||
      await promptManager.getCapabilityInstructions(prompt.prompt);

    if (condition.config.systemPromptAppend) {
      systemPrompt += '\n\n' + condition.config.systemPromptAppend;
    }

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: prompt.prompt },
    ];

    const response = await openRouterService.generateFromMessageChain(
      messages,
      'eval-suite',
      undefined,
      condition.config.model,
      {
        maxTokens: condition.config.maxTokens,
      }
    );

    const latencyMs = Date.now() - startTime;

    return {
      id: uuidv4(),
      runId,
      promptId: prompt.id,
      conditionId: condition.id,
      prompt: prompt.prompt,
      response,
      latencyMs,
      tokenCount: Math.ceil(response.length / 4), // Rough estimate
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Judge a pairwise comparison (blind, randomized order)
   */
  private async judgeComparison(
    runId: string,
    prompt: TestPrompt,
    genA: Generation,
    genB: Generation,
    condA: Condition,
    condB: Condition
  ): Promise<PairwiseJudgment> {
    const { openRouterService } = await import('../llm/openrouter.js');

    // Randomize order to prevent position bias
    const showAFirst = Math.random() > 0.5;
    const first = showAFirst ? genA : genB;
    const second = showAFirst ? genB : genA;

    const judgePrompt = `You are a quality evaluator comparing two AI responses. Be objective and critical.

USER PROMPT:
"${prompt.prompt}"

RESPONSE 1:
"""
${first.response}
"""

RESPONSE 2:
"""
${second.response}
"""

Which response is better overall? Consider:
- Accuracy and correctness
- Helpfulness and relevance
- Clarity and coherence
- Appropriate tone

Respond in this exact JSON format:
{
  "winner": 1 or 2 or "tie",
  "confidence": <1-5>,
  "reasoning": "<2-3 sentences explaining your choice>"
}

Be decisive. Only call it a tie if truly equivalent.`;

    const judgment = await openRouterService.generateFromMessageChain(
      [
        { role: 'system', content: 'You are an expert AI evaluator. Output only valid JSON.' },
        { role: 'user', content: judgePrompt }
      ],
      'eval-suite-judge',
      undefined,
      this.judgeModel
    );

    // Parse response
    const jsonMatch = judgment.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON in judge response');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Map randomized winner back to A/B
    let winner: 'A' | 'B' | 'tie';
    if (parsed.winner === 'tie' || parsed.winner === '"tie"') {
      winner = 'tie';
    } else if (parsed.winner === 1 || parsed.winner === '1') {
      winner = showAFirst ? 'A' : 'B';
    } else {
      winner = showAFirst ? 'B' : 'A';
    }

    return {
      id: uuidv4(),
      runId,
      promptId: prompt.id,
      conditionA: condA.id,
      conditionB: condB.id,
      generationA: genA.id,
      generationB: genB.id,
      winner,
      confidence: Math.max(1, Math.min(5, parsed.confidence || 3)),
      reasoning: parsed.reasoning || '',
      judgeModel: this.judgeModel,
      judgedAt: new Date().toISOString(),
    };
  }

  /**
   * Compute win rates and confidence intervals using Wilson score
   */
  private computeResults(
    conditions: Condition[],
    judgments: PairwiseJudgment[]
  ): EvalRunSummary['results'] {
    const stats: Record<string, { wins: number; losses: number; ties: number }> = {};

    for (const cond of conditions) {
      stats[cond.id] = { wins: 0, losses: 0, ties: 0 };
    }

    for (const j of judgments) {
      if (j.winner === 'A') {
        stats[j.conditionA].wins++;
        stats[j.conditionB].losses++;
      } else if (j.winner === 'B') {
        stats[j.conditionB].wins++;
        stats[j.conditionA].losses++;
      } else {
        stats[j.conditionA].ties++;
        stats[j.conditionB].ties++;
      }
    }

    return conditions.map(cond => {
      const s = stats[cond.id];
      const total = s.wins + s.losses + s.ties;
      const winRate = total > 0 ? s.wins / total : 0;

      // Wilson score interval for 95% CI
      const { low, high } = this.wilsonScore(s.wins, total, 0.95);

      return {
        conditionId: cond.id,
        conditionName: cond.name,
        wins: s.wins,
        losses: s.losses,
        ties: s.ties,
        winRate: Math.round(winRate * 1000) / 10, // Percentage with 1 decimal
        ciLow: Math.round(low * 1000) / 10,
        ciHigh: Math.round(high * 1000) / 10,
      };
    }).sort((a, b) => b.winRate - a.winRate);
  }

  /**
   * Wilson score confidence interval - better than normal approximation for small samples
   */
  private wilsonScore(wins: number, total: number, confidence: number): { low: number; high: number } {
    if (total === 0) return { low: 0, high: 0 };

    const z = 1.96; // 95% CI
    const p = wins / total;
    const n = total;

    const denominator = 1 + z * z / n;
    const centre = p + z * z / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);

    return {
      low: Math.max(0, (centre - margin) / denominator),
      high: Math.min(1, (centre + margin) / denominator),
    };
  }

  /**
   * Get all unique pairs of conditions
   */
  private getAllPairs(conditions: Condition[]): [Condition, Condition][] {
    const pairs: [Condition, Condition][] = [];
    for (let i = 0; i < conditions.length; i++) {
      for (let j = i + 1; j < conditions.length; j++) {
        pairs.push([conditions[i], conditions[j]]);
      }
    }
    return pairs;
  }

  /**
   * Print results to console
   */
  private printResults(summary: EvalRunSummary): void {
    console.log('\n' + '='.repeat(60));
    console.log(`EVAL RESULTS: ${summary.name}`);
    console.log('='.repeat(60));
    console.log(`Prompts: ${summary.promptCount} | Generations: ${summary.generationCount} | Comparisons: ${summary.judgmentCount}`);
    console.log('');
    console.log('Condition                  Win%    95% CI       W/L/T');
    console.log('-'.repeat(60));

    for (const r of summary.results) {
      const name = r.conditionName.padEnd(24);
      const winPct = `${r.winRate.toFixed(1)}%`.padStart(6);
      const ci = `[${r.ciLow.toFixed(1)}-${r.ciHigh.toFixed(1)}%]`.padStart(14);
      const wlt = `${r.wins}/${r.losses}/${r.ties}`;
      console.log(`${name} ${winPct}  ${ci}    ${wlt}`);
    }

    console.log('='.repeat(60) + '\n');
  }

  // ============================================================================
  // DATABASE STORAGE
  // ============================================================================

  private async storeRun(runId: string, name: string, conditions: Condition[], promptCount: number): Promise<void> {
    const db = getSyncDb();
    db.run(
      `INSERT INTO eval_runs (id, name, conditions_json, prompt_count, started_at)
       VALUES (?, ?, ?, ?, ?)`,
      [runId, name, JSON.stringify(conditions), promptCount, new Date().toISOString()]
    );
  }

  private async completeRun(runId: string, completedAt: string): Promise<void> {
    const db = getSyncDb();
    db.run(`UPDATE eval_runs SET completed_at = ? WHERE id = ?`, [completedAt, runId]);
  }

  private async storeGeneration(gen: Generation): Promise<void> {
    const db = getSyncDb();
    db.run(
      `INSERT INTO eval_generations (id, run_id, prompt_id, condition_id, prompt, response, latency_ms, token_count, generated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gen.id, gen.runId, gen.promptId, gen.conditionId, gen.prompt, gen.response, gen.latencyMs, gen.tokenCount, gen.generatedAt]
    );
  }

  private async storeJudgment(j: PairwiseJudgment): Promise<void> {
    const db = getSyncDb();
    db.run(
      `INSERT INTO eval_judgments (id, run_id, prompt_id, condition_a, condition_b, generation_a, generation_b, winner, confidence, reasoning, judge_model, judged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [j.id, j.runId, j.promptId, j.conditionA, j.conditionB, j.generationA, j.generationB, j.winner, j.confidence, j.reasoning, j.judgeModel, j.judgedAt]
    );
  }

  private async storeSummary(summary: EvalRunSummary): Promise<void> {
    const db = getSyncDb();
    db.run(
      `UPDATE eval_runs SET results_json = ?, generation_count = ?, judgment_count = ? WHERE id = ?`,
      [JSON.stringify(summary.results), summary.generationCount, summary.judgmentCount, summary.runId]
    );
  }

  /**
   * List all eval runs
   */
  async listRuns(): Promise<Array<{ id: string; name: string; startedAt: string; completedAt: string | null; promptCount: number }>> {
    const db = getSyncDb();
    return db.all(
      `SELECT id, name, started_at as startedAt, completed_at as completedAt, prompt_count as promptCount
       FROM eval_runs ORDER BY started_at DESC LIMIT 50`
    ) || [];
  }

  /**
   * Get results for a specific run
   */
  async getRunResults(runId: string): Promise<EvalRunSummary | null> {
    const db = getSyncDb();
    const run = db.get<{
      id: string;
      name: string;
      started_at: string;
      completed_at: string | null;
      conditions_json: string;
      prompt_count: number;
      generation_count: number;
      judgment_count: number;
      results_json: string;
    }>(`SELECT * FROM eval_runs WHERE id = ?`, [runId]);

    if (!run) return null;

    return {
      runId: run.id,
      name: run.name,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      conditions: JSON.parse(run.conditions_json || '[]'),
      promptCount: run.prompt_count,
      generationCount: run.generation_count || 0,
      judgmentCount: run.judgment_count || 0,
      results: JSON.parse(run.results_json || '[]'),
    };
  }

  // ============================================================================
  // TEST SET MANAGEMENT
  // ============================================================================

  /**
   * Create a new test set (or new version of existing)
   */
  async createTestSet(
    name: string,
    prompts: TestPrompt[],
    options: { description?: string; createdBy?: string; isDefault?: boolean } = {}
  ): Promise<{ id: string; version: number }> {
    const db = getSyncDb();
    const setId = uuidv4();

    // Get next version number for this name
    const existing = db.get<{ max_version: number }>(
      `SELECT MAX(version) as max_version FROM test_sets WHERE name = ?`,
      [name]
    );
    const version = (existing?.max_version || 0) + 1;

    // Create test set
    db.run(
      `INSERT INTO test_sets (id, name, description, version, created_by, is_default, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [setId, name, options.description || null, version, options.createdBy || null, options.isDefault ? 1 : 0]
    );

    // Insert prompts
    for (let i = 0; i < prompts.length; i++) {
      const p = prompts[i];
      db.run(
        `INSERT INTO test_prompts (id, test_set_id, prompt_key, category, difficulty, prompt, context, expected_behavior, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), setId, p.id, p.category, p.difficulty, p.prompt, p.context || null, null, i]
      );
    }

    logger.info(`📝 Created test set: ${name} v${version} with ${prompts.length} prompts`);
    return { id: setId, version };
  }

  /**
   * Get a test set by ID or name (latest version if by name)
   */
  async getTestSet(idOrName: string): Promise<{ set: { id: string; name: string; version: number }; prompts: TestPrompt[] } | null> {
    const db = getSyncDb();

    // Try by ID first
    let set = db.get<{ id: string; name: string; version: number }>(
      `SELECT id, name, version FROM test_sets WHERE id = ? AND is_active = 1`,
      [idOrName]
    );

    // If not found, try by name (latest version)
    if (!set) {
      set = db.get<{ id: string; name: string; version: number }>(
        `SELECT id, name, version FROM test_sets WHERE name = ? AND is_active = 1 ORDER BY version DESC LIMIT 1`,
        [idOrName]
      );
    }

    if (!set) return null;

    // Get prompts
    const rows = db.all<{
      prompt_key: string;
      category: string;
      difficulty: string;
      prompt: string;
      context: string | null;
    }>(
      `SELECT prompt_key, category, difficulty, prompt, context
       FROM test_prompts WHERE test_set_id = ? ORDER BY position`,
      [set.id]
    ) || [];

    const prompts: TestPrompt[] = rows.map(r => ({
      id: r.prompt_key,
      category: r.category,
      prompt: r.prompt,
      difficulty: r.difficulty as 'easy' | 'medium' | 'hard',
      context: r.context || undefined,
    }));

    return { set, prompts };
  }

  /**
   * List all test sets
   */
  async listTestSets(): Promise<Array<{ id: string; name: string; version: number; promptCount: number; isDefault: boolean; createdAt: string }>> {
    const db = getSyncDb();
    return db.all(
      `SELECT ts.id, ts.name, ts.version, ts.is_default as isDefault, ts.created_at as createdAt,
              (SELECT COUNT(*) FROM test_prompts WHERE test_set_id = ts.id) as promptCount
       FROM test_sets ts
       WHERE ts.is_active = 1
       ORDER BY ts.is_default DESC, ts.created_at DESC`
    ) || [];
  }

  /**
   * Get the default test set, or create it from hardcoded prompts
   */
  async getOrCreateDefaultTestSet(): Promise<{ id: string; prompts: TestPrompt[] }> {
    const db = getSyncDb();

    // Check for existing default
    const existing = db.get<{ id: string }>(
      `SELECT id FROM test_sets WHERE is_default = 1 AND is_active = 1 ORDER BY version DESC LIMIT 1`
    );

    if (existing) {
      const result = await this.getTestSet(existing.id);
      if (result) {
        return { id: result.set.id, prompts: result.prompts };
      }
    }

    // Create default from hardcoded prompts
    logger.info('📝 Creating default test set from hardcoded prompts...');
    const { id } = await this.createTestSet('Default Artie Eval Set', DEFAULT_TEST_SET, {
      description: 'Standard test set covering factual, reasoning, creative, emotional, task, and conversational prompts',
      createdBy: 'system',
      isDefault: true,
    });

    return { id, prompts: DEFAULT_TEST_SET };
  }

  /**
   * Seed the default test set if it doesn't exist
   */
  async ensureDefaultTestSet(): Promise<void> {
    await this.getOrCreateDefaultTestSet();
  }
}

export const evalSuite = EvalSuite.getInstance();
