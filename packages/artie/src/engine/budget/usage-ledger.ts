import { getSyncDb } from '../../shared/db/client.js';
import { logger } from '../../shared/logger.js';
import { scheduleDailyBudgetCheck } from './daily-cap.js';
import { recordApiCall } from '../health/metrics.js';

/**
 * The one spend module: the durable per-call ledger (UsageTracker, model_usage_stats) and
 * the in-process spend counter (CostMonitor/costMonitor, was session-spend.ts). Today's
 * spend for the daily cap and brownout is getTodaySpendUsd in daily-cap.ts, the only
 * function that sums model_usage_stats for the ET day.
 */

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /**
   * Prompt tokens served from the Anthropic prompt cache. OpenRouter reports this on the
   * OpenAI shape as usage.prompt_tokens_details.cached_tokens, and it is a SUBSET of
   * prompt_tokens, not an addition to it. Zero across repeated requests with the same
   * prefix means a silent cache invalidator — see context-alchemy's static system block.
   */
  cached_tokens?: number;
  /**
   * Prompt tokens WRITTEN to the cache on this call (prompt_tokens_details.cache_write_tokens),
   * also a subset of prompt_tokens. Billed at a premium: 1.25x for the 5-minute TTL, 2x for
   * the 1-hour TTL we use by default.
   */
  cache_write_tokens?: number;
}

/** Write premium matching prompt-cache.ts's TTL choice (PROMPT_CACHE_TTL=5m → 1.25x, else 1h → 2x). */
export function cacheWriteMultiplier(): number {
  return getCacheWriteMultiplier();
}

export interface UsageStats {
  model_name: string;
  user_id: string;
  message_id: string;
  input_length: number;
  output_length: number;
  response_time_ms: number;
  capabilities_detected: number;
  capabilities_executed: number;
  capability_types: string;
  success: boolean;
  error_type?: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
  estimated_cost: number;
  guild_id?: string | null; // per-guild budget shares (shared guild-budget.ts)
  step_type?: string; // 'response' | 'proactive_judgment' | 'observational_learning' | 'capability' | 'planning'
}

// Model pricing per 1K tokens (input/output). Verified against the live OpenRouter
// /api/v1/models endpoint on 2026-09-22 — re-check there rather than trusting this comment:
//   curl -s https://openrouter.ai/api/v1/models | jq '.data[] | select(.id=="<model>") | .pricing'
// That endpoint also confirms cache reads bill at exactly 0.1x prompt and writes at 1.25x
// (2x for the 1h TTL) on every Anthropic model, which is what calculateCost assumes below.
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic
  'anthropic/claude-3.5-sonnet': { input: 0.003, output: 0.015 },
  'anthropic/claude-sonnet-4': { input: 0.003, output: 0.015 },
  'anthropic/claude-sonnet-4.5': { input: 0.003, output: 0.015 },
  'anthropic/claude-sonnet-4.6': { input: 0.003, output: 0.015 },
  'anthropic/claude-opus-4': { input: 0.015, output: 0.075 },
  // $15/$75 here was the Opus 4 / 4.1 tier copied forward. 4.5 is $5/$25 like 4.6 and 4.8,
  // so 1,972 historical calls were booked at 3x — $141.90 recorded against ~$47.30 actual,
  // roughly $95 of phantom spend in the all-time total.
  'anthropic/claude-opus-4.5': { input: 0.005, output: 0.025 },
  'anthropic/claude-opus-4.6': { input: 0.005, output: 0.025 },
  // The models actually in rotation (OPENROUTER_MODELS + SMART_MODEL). All three were
  // MISSING, so calculateCost returned 0 for literally every call we made — cost tracking
  // reported $0.00 for 100% of traffic. Rates read from the live OpenRouter /models API
  // (per-token there, per-1K here), not estimated.
  'anthropic/claude-haiku-4.5': { input: 0.001, output: 0.005 },
  'anthropic/claude-sonnet-5': { input: 0.002, output: 0.01 },
  'anthropic/claude-opus-4.8': { input: 0.005, output: 0.025 },
  // Persona model from 2026-09-29. Its cache reads list at $0.20/M (0.05x), cheaper than the
  // 0.1x calculateCost assumes, so cached calls read slightly high — the safe direction.
  'anthropic/claude-opus-5.5': { input: 0.004, output: 0.02 },
  // OpenAI
  'openai/gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
  'openai/gpt-4': { input: 0.03, output: 0.06 },
  'openai/gpt-4-turbo': { input: 0.01, output: 0.03 },
  'openai/gpt-4o': { input: 0.0025, output: 0.01 }, // was 2x over
  'openai/gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  // Google
  // Was gpt-4o-mini's rate; flash is 2x that on input and 4x on output.
  'google/gemini-2.5-flash': { input: 0.0003, output: 0.0025 },
  'google/gemini-2.0-flash': { input: 0.0001, output: 0.0004 },
  'google/gemini-pro': { input: 0.00025, output: 0.0005 },
  // Free models
  'mistralai/mistral-7b-instruct:free': { input: 0, output: 0 },
  'microsoft/phi-3-mini-128k-instruct:free': { input: 0, output: 0 },
  'meta-llama/llama-3.2-3b-instruct:free': { input: 0, output: 0 },
  'google/gemma-2-9b-it:free': { input: 0, output: 0 },
};

// What we charge ourselves for a model we don't recognise. Deliberately the priciest tier we
// use, so an untracked model reads as expensive rather than free.
const UNKNOWN_MODEL_PRICING = { input: 0.015, output: 0.075 };

/** Get the cache write multiplier based on TTL environment variable. */
function getCacheWriteMultiplier(): number {
  if (process.env.PROMPT_CACHE_TTL === '5m') {
    return 1.25;
  }
  return 2.0;
}

export class UsageTracker {
  /**
   * Calculate estimated cost based on token usage and model
   */
  static calculateCost(modelName: string, usage: TokenUsage): number {
    const pricing = MODEL_PRICING[modelName] ?? UNKNOWN_MODEL_PRICING;
    if (!MODEL_PRICING[modelName]) {
      // Returning 0 here (the old behaviour) doesn't mean "unknown", it means "FREE" — and
      // every downstream credit guard and cost report believed it. Whenever a model got
      // swapped in that nobody added below, spend silently vanished from the books. Assume
      // top-tier rates instead: over-reporting makes a budget alarm fire early, which is
      // recoverable; under-reporting hides the burn until the credits are gone.
      logger.warn(
        `⚠️ No pricing info for model: ${modelName} — billing it at top-tier rates. ` +
          `Add it to MODEL_PRICING (rates: openrouter.ai/api/v1/models) to track it accurately.`
      );
    }

    // Cache reads bill at ~0.1x base input. cached_tokens is a subset of prompt_tokens, so
    // the uncached remainder is the difference — charging the full prompt at list price
    // would hide exactly the saving prompt caching exists to produce.
    const cached = Math.min(usage.cached_tokens ?? 0, usage.prompt_tokens);
    // Cache WRITES bill at a premium (2x at the 1h TTL). They were costed at list price, so
    // every cache-warming call was under-booked — and the daily budget cap sums these rows.
    const written = Math.min(usage.cache_write_tokens ?? 0, usage.prompt_tokens - cached);
    const uncached = usage.prompt_tokens - cached - written;

    const inputCost =
      (uncached / 1000) * pricing.input +
      (cached / 1000) * pricing.input * 0.1 +
      (written / 1000) * pricing.input * cacheWriteMultiplier();
    const outputCost = (usage.completion_tokens / 1000) * pricing.output;

    return inputCost + outputCost;
  }

  /**
   * Record usage statistics to database
   */
  static async recordUsage(stats: UsageStats): Promise<void> {
    try {
      const db = getSyncDb();

      // SQLite can't bind booleans - convert to 0/1
      // Also ensure all values are valid types (no undefined)
      let successInt: number;
      if (stats.success) {
        successInt = 1;
      } else {
        successInt = 0;
      }
      db.run(
        `INSERT INTO model_usage_stats (
          model_name, user_id, message_id, input_length, output_length,
          response_time_ms, capabilities_detected, capabilities_executed,
          capability_types, success, error_type, prompt_tokens,
          completion_tokens, total_tokens, cached_tokens, cache_write_tokens,
          estimated_cost, step_type, guild_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          stats.model_name || 'unknown',
          stats.user_id || 'unknown',
          stats.message_id || 'unknown',
          stats.input_length ?? 0,
          stats.output_length ?? 0,
          stats.response_time_ms ?? 0,
          stats.capabilities_detected ?? 0,
          stats.capabilities_executed ?? 0,
          stats.capability_types || '',
          successInt,
          stats.error_type || null,
          stats.prompt_tokens ?? 0,
          stats.completion_tokens ?? 0,
          stats.total_tokens ?? 0,
          stats.cached_tokens ?? 0,
          stats.cache_write_tokens ?? 0,
          stats.estimated_cost ?? 0,
          stats.step_type || 'response',
          stats.guild_id ?? null,
        ]
      );

      // Cache hit rate is logged at INFO deliberately: DEBUG is off in production, and a
      // silently-zero cache is the failure mode that costs money without raising anything.
      const cachedTok = stats.cached_tokens ?? 0;
      const cacheNote =
        stats.prompt_tokens > 0
          ? ` - cache ${cachedTok}/${stats.prompt_tokens} (${Math.round((cachedTok / stats.prompt_tokens) * 100)}%)`
          : '';
      logger.info(
        `📊 Usage recorded: ${stats.model_name} - ${stats.total_tokens} tokens${cacheNote} - $${stats.estimated_cost.toFixed(4)}`
      );

      // Spend just changed — re-evaluate the daily cap (coalesced, fire-and-forget).
      if ((stats.estimated_cost ?? 0) > 0) scheduleDailyBudgetCheck();
    } catch (error) {
      logger.error('❌ Failed to record usage stats:', error);
      // Don't throw - usage tracking failure shouldn't break the main flow
    }
  }

  /**
   * Get usage statistics for a user or model
   */
  static async getUserUsage(
    userId: string,
    days: number = 30
  ): Promise<{
    total_tokens: number;
    total_cost: number;
    requests: number;
    most_used_model: string;
  }> {
    try {
      const db = getSyncDb();

      const result = db.get(
        `
        SELECT 
          SUM(total_tokens) as total_tokens,
          SUM(estimated_cost) as total_cost,
          COUNT(*) as requests,
          (SELECT model_name FROM model_usage_stats 
           WHERE user_id = ? AND timestamp >= datetime('now', '-${days} days')
           GROUP BY model_name ORDER BY COUNT(*) DESC LIMIT 1) as most_used_model
        FROM model_usage_stats 
        WHERE user_id = ? 
        AND timestamp >= datetime('now', '-${days} days')
      `,
        [userId, userId]
      );

      return {
        total_tokens: result?.total_tokens || 0,
        total_cost: result?.total_cost || 0,
        requests: result?.requests || 0,
        most_used_model: result?.most_used_model || 'none',
      };
    } catch (error) {
      logger.error('❌ Failed to get user usage:', error);
      return { total_tokens: 0, total_cost: 0, requests: 0, most_used_model: 'none' };
    }
  }

  /**
   * Get model usage statistics
   */
  static async getModelUsage(
    modelName: string,
    days: number = 30
  ): Promise<{
    total_tokens: number;
    total_cost: number;
    requests: number;
    avg_tokens_per_request: number;
  }> {
    try {
      const db = getSyncDb();

      const result = db.get(
        `
        SELECT 
          SUM(total_tokens) as total_tokens,
          SUM(estimated_cost) as total_cost,
          COUNT(*) as requests,
          AVG(total_tokens) as avg_tokens_per_request
        FROM model_usage_stats 
        WHERE model_name = ? 
        AND timestamp >= datetime('now', '-${days} days')
      `,
        [modelName]
      );

      return {
        total_tokens: result?.total_tokens || 0,
        total_cost: result?.total_cost || 0,
        requests: result?.requests || 0,
        avg_tokens_per_request: result?.avg_tokens_per_request || 0,
      };
    } catch (error) {
      logger.error('❌ Failed to get model usage:', error);
      return { total_tokens: 0, total_cost: 0, requests: 0, avg_tokens_per_request: 0 };
    }
  }

  /**
   * Get tool usage performance by model
   */
  static async getToolUsagePerformance(days: number = 30): Promise<
    Array<{
      model_name: string;
      total_requests: number;
      capabilities_detected: number;
      capabilities_executed: number;
      tool_success_rate: number;
      xml_format_success_rate: number;
      avg_response_time: number;
    }>
  > {
    try {
      const db = getSyncDb();

      const results = db.all(`
        SELECT 
          model_name,
          COUNT(*) as total_requests,
          SUM(capabilities_detected) as capabilities_detected,
          SUM(capabilities_executed) as capabilities_executed,
          ROUND(
            CASE 
              WHEN SUM(capabilities_detected) > 0 
              THEN (SUM(capabilities_executed) * 100.0 / SUM(capabilities_detected))
              ELSE 0 
            END, 2
          ) as tool_success_rate,
          ROUND(
            CASE 
              WHEN COUNT(*) > 0
              THEN (SUM(CASE WHEN capabilities_detected > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*))
              ELSE 0
            END, 2
          ) as xml_format_success_rate,
          ROUND(AVG(response_time_ms), 0) as avg_response_time
        FROM model_usage_stats 
        WHERE timestamp >= datetime('now', '-${days} days')
        GROUP BY model_name
        ORDER BY tool_success_rate DESC, xml_format_success_rate DESC
      `);

      return results.map((row) => ({
        model_name: row.model_name,
        total_requests: row.total_requests,
        capabilities_detected: row.capabilities_detected,
        capabilities_executed: row.capabilities_executed,
        tool_success_rate: row.tool_success_rate,
        xml_format_success_rate: row.xml_format_success_rate,
        avg_response_time: row.avg_response_time,
      }));
    } catch (error) {
      logger.error('❌ Failed to get tool usage performance:', error);
      return [];
    }
  }

  /**
   * Get daily usage summary
   */
  static async getDailyUsage(days: number = 7): Promise<
    Array<{
      date: string;
      total_tokens: number;
      total_cost: number;
      requests: number;
    }>
  > {
    try {
      const db = getSyncDb();

      const results = db.all(`
        SELECT 
          DATE(timestamp) as date,
          SUM(total_tokens) as total_tokens,
          SUM(estimated_cost) as total_cost,
          COUNT(*) as requests
        FROM model_usage_stats 
        WHERE timestamp >= datetime('now', '-${days} days')
        GROUP BY DATE(timestamp)
        ORDER BY date DESC
      `);

      return results.map((row) => ({
        date: row.date,
        total_tokens: row.total_tokens || 0,
        total_cost: row.total_cost || 0,
        requests: row.requests || 0,
      }));
    } catch (error) {
      logger.error('❌ Failed to get daily usage:', error);
      return [];
    }
  }
}

export { UsageTracker as usageTracker };

// ── In-process spend (was budget/session-spend.ts, folded in wave 6) ───────────────────────
// Per-request $ and the rolling burn rate, in memory. The DB ledger above is the durable
// record; this is the live counter the runway warning and brownout read.

/**
 * Simple cost monitoring service to track OpenRouter API usage
 * Helps prevent runaway costs by logging and alerting
 */
class CostMonitor {
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCachedTokens = 0;
  /**
   * Rolling window of recent spend, for the burn RATE (as distinct from the total).
   *
   * costPerHour used to be total-cost-since-boot / hours-since-boot, which is a cumulative
   * average, not a rate. Right after a restart it divides a burst by a tiny uptime and reads
   * enormous; after a long quiet uptime it stays stale. Measured over July it reported a
   * median of $11.39/hr during a month that averaged $0.26/hr — a ~40x overstatement, which
   * is why the vitals alarm got tuned out entirely. The brownout ladder divides the credit
   * balance by this number, so an inflated rate demotes Artie off Opus for no reason.
   */
  private recentCalls: Array<{ at: number; cost: number }> = [];
  private readonly burnWindowMs: number;
  /**
   * Running real cost. Accumulated per call at that call's OWN model rate, because the
   * brownout ladder demotes Artie off Opus based on this number and recomputing it from
   * flat totals got both halves wrong: it priced every model at Sonnet 3.5's $3/$15 while
   * SMART_MODEL is opus-4.8 ($5/$25), and it could not see cache discounts at all.
   */
  private totalCost = 0;
  private totalCalls = 0;
  private startTime = Date.now();
  private messageCount = 0;
  private statsInterval: NodeJS.Timeout | null = null;

  // "Floating ballast" state: the latest known real balance (fed by the credit
  // monitor) and the last time we emitted a runway warning (for throttling).
  private lastKnownBalance: number | null = null;
  private lastRunwayWarnAt = 0;

  // Pricing lives in UsageTracker.MODEL_PRICING (one table, per model, rates from the live
  // OpenRouter /models API). The flat $3/$15 Sonnet-3.5 constants that used to sit here
  // under-reported every Opus call by ~40% on input and ~40% on output, which means every
  // runway estimate and every brownout decision was made on a number that was too small.

  // Tunable limits from env vars
  private readonly maxCostPerHour: number;
  private readonly maxTokensPerCall: number;
  private readonly autoCheckCreditsEvery: number;

  constructor() {
    this.maxCostPerHour = parseFloat(process.env.MAX_COST_PER_HOUR || '10.0');
    this.maxTokensPerCall = parseInt(process.env.MAX_TOKENS_PER_CALL || '8000');
    this.autoCheckCreditsEvery = parseInt(process.env.AUTO_CHECK_CREDITS_EVERY || '50');
    this.burnWindowMs = parseInt(process.env.BURN_RATE_WINDOW_MINUTES || '60', 10) * 60_000;

    logger.info('💰 Cost Monitor initialized with limits:', {
      maxCostPerHour: `$${this.maxCostPerHour}/hr`,
      maxTokensPerCall: this.maxTokensPerCall,
      autoCheckCreditsEvery: this.autoCheckCreditsEvery,
    });

    // Start periodic stats logging
    this.startStatsInterval();
  }

  /**
   * Start periodic stats logging interval
   */
  private startStatsInterval(): void {
    if (process.env.NODE_ENV !== 'development') {
      this.statsInterval = setInterval(() => this.logStats(), 5 * 60 * 1000);
    }
  }

  /**
   * Graceful shutdown - clears stats interval
   */
  shutdown(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
      logger.info('💰 Cost Monitor shutdown: stats interval cleared');
    }
  }

  /**
   * Feed the latest real credit balance in (called by the credit monitor).
   * This is the "ballast" the runway warning floats on.
   */
  updateBalance(balance: number | null): void {
    this.lastKnownBalance = balance;
  }

  /**
   * Track an API call
   */
  /**
   * @param cachedTokens Prompt tokens served from the prompt cache — a SUBSET of
   * inputTokens, billed at ~0.1x. This is not cosmetic: the brownout ladder steps Artie
   * down off Opus using the burn rate measured here, so billing cached tokens at full
   * price would make a working cache look like a spending spike and demote him for it.
   */
  trackCall(
    inputTokens: number,
    outputTokens: number,
    model: string,
    cachedTokens = 0,
    /** Exact USD from OpenRouter usage accounting (auto-routed calls); overrides the table. */
    reportedCost?: number
  ): { shouldCheckCredits: boolean; warnings: string[] } {
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.totalCachedTokens += Math.min(Math.max(cachedTokens, 0), inputTokens);
    this.totalCalls++;

    const estimatedCost =
      reportedCost !== undefined && Number.isFinite(reportedCost)
        ? reportedCost
        : this.calculateCost(inputTokens, outputTokens, cachedTokens, model);
    this.totalCost += estimatedCost;

    const now = Date.now();
    this.recentCalls.push({ at: now, cost: estimatedCost });
    this.pruneRecentCalls(now);
    const totalCost = this.getTotalEstimatedCost();
    const callTokens = inputTokens + outputTokens;
    const warnings: string[] = [];

    logger.info(
      `💰 API Call: ${inputTokens} in + ${outputTokens} out tokens (~$${estimatedCost.toFixed(4)}) | Total: $${totalCost.toFixed(2)} (${this.totalCalls} calls)`,
      {
        model,
        inputTokens,
        outputTokens,
        estimatedCost,
        totalCost,
        totalCalls: this.totalCalls,
      }
    );

    // Record to Prometheus metrics
    recordApiCall({
      model,
      inputTokens,
      outputTokens,
      cost: estimatedCost,
    });

    // Check tokens per call limit
    if (callTokens > this.maxTokensPerCall) {
      const warning = `⚠️ High token usage: ${callTokens.toLocaleString()} tokens in single call (limit: ${this.maxTokensPerCall.toLocaleString()})`;
      logger.warn(warning);
      warnings.push(warning);
    }

    // Floating ballast: instead of a hard $/hr alarm that fires on every call
    // (and gets injected into Artie's context, making him fixate on money), warn
    // based on RUNWAY — how long the real balance lasts at the current burn rate.
    // This self-adjusts: a fat balance stays quiet even at high burn; a thin one
    // warns early. Gated on a stable sample + throttled so it can't spam.
    const stats = this.getStats();
    const uptimeHours = (Date.now() - this.startTime) / 3_600_000;
    const MIN_SAMPLE_HOURS = 0.25; // ignore burn rate in the first 15 min (tiny sample skews it)
    if (uptimeHours >= MIN_SAMPLE_HOURS && this.lastKnownBalance !== null && stats.costPerHour > 0) {
      const runwayHours = this.lastKnownBalance / stats.costPerHour;
      const warnHours = parseFloat(process.env.RUNWAY_WARN_HOURS || '24');
      const critHours = parseFloat(process.env.RUNWAY_CRITICAL_HOURS || '6');
      const throttleMs = parseInt(process.env.RUNWAY_WARN_THROTTLE_MS || '600000'); // 10 min

      if (runwayHours < warnHours && Date.now() - this.lastRunwayWarnAt > throttleMs) {
        this.lastRunwayWarnAt = Date.now();
        let sev: string;
        if (runwayHours < critHours) {
          sev = '🚨';
        } else {
          sev = '⚠️';
        }
        const warning = `${sev} ~${runwayHours.toFixed(1)}h of credit left at current burn ($${stats.costPerHour.toFixed(2)}/hr, $${this.lastKnownBalance.toFixed(2)} balance)`;
        logger.warn(warning);
        warnings.push(warning);
      }
    }

    // Check if we should auto-check credits
    const shouldCheckCredits =
      this.autoCheckCreditsEvery > 0 &&
      this.messageCount % this.autoCheckCreditsEvery === 0 &&
      this.messageCount > 0;

    return { shouldCheckCredits, warnings };
  }

  /**
   * Increment message counter for auto-check credits
   */
  incrementMessageCount() {
    this.messageCount++;
  }

  /**
   * Get current message count
   */
  getMessageCount(): number {
    return this.messageCount;
  }

  /**
   * Calculate cost for a single call
   */
  private calculateCost(
    inputTokens: number,
    outputTokens: number,
    cachedTokens = 0,
    model = 'unknown'
  ): number {
    // Delegated so there is exactly one pricing table. UsageTracker.calculateCost already
    // applies the per-model rate and the 0.1x cache-read discount, and bills an unknown
    // model at top-tier rates rather than free.
    return UsageTracker.calculateCost(model, {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      cached_tokens: cachedTokens,
    });
  }

  /**
   * Get total estimated cost
   */
  /** Drop calls that have aged out of the burn window. */
  private pruneRecentCalls(now: number): void {
    const cutoff = now - this.burnWindowMs;
    let i = 0;
    while (i < this.recentCalls.length && this.recentCalls[i].at < cutoff) i++;
    if (i > 0) this.recentCalls.splice(0, i);
  }

  /**
   * Spend rate over the recent window, in dollars per hour.
   *
   * Divides by the elapsed time actually covered — capped at the window, floored at the
   * process uptime — so a 10-minute-old process reporting $0.05 of spend reads $0.30/hr,
   * not $3/hr. Returns null when there is too little to say anything honest, and callers
   * fall back to a configured estimate rather than acting on noise.
   */
  getRecentBurnPerHour(): number | null {
    const now = Date.now();
    this.pruneRecentCalls(now);
    if (this.recentCalls.length === 0) return null;

    // Refuse to extrapolate from too short an observation. A burst in the first seconds of
    // uptime divided by that elapsed time produces an enormous number that is arithmetically
    // true and completely useless — the old cumulative version reported $264,000/hr on a
    // 20-call burst in a test. Returning null makes callers use their configured fallback,
    // which is a far better estimate than a spike.
    const uptimeMs = now - this.startTime;
    const minObservationMs = Math.min(this.burnWindowMs, 5 * 60_000);
    if (uptimeMs < minObservationMs) return null;

    const coveredMs = Math.min(this.burnWindowMs, uptimeMs);
    const windowCost = this.recentCalls.reduce((total, c) => total + c.cost, 0);
    return windowCost / (coveredMs / 3_600_000);
  }

  getTotalEstimatedCost(): number {
    // The running sum, NOT a recomputation from totals — totals have no model and no cache
    // information, so recomputing silently discards both.
    return this.totalCost;
  }

  /**
   * Get usage statistics
   */
  getStats() {
    const uptime = Date.now() - this.startTime;
    const hours = uptime / (1000 * 60 * 60);

    let costPerHour: number;
    if (hours > 0) {
      costPerHour = this.getTotalEstimatedCost() / hours;
    } else {
      costPerHour = 0;
    }

    return {
      totalCalls: this.totalCalls,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalTokens: this.totalInputTokens + this.totalOutputTokens,
      totalCachedTokens: this.totalCachedTokens,
      estimatedCost: this.getTotalEstimatedCost(),
      // Cumulative average since boot. Kept for reporting; NOT a rate — see
      // getRecentBurnPerHour, which is what anything making a decision should use.
      costPerHour,
      recentBurnPerHour: this.getRecentBurnPerHour(),
      burnWindowMinutes: this.burnWindowMs / 60_000,
      uptime: uptime,
    };
  }

  /**
   * Reset counters (useful for testing or daily resets)
   */
  reset() {
    logger.info(
      `📊 Cost Monitor Reset - Final Stats: $${this.getTotalEstimatedCost().toFixed(2)}, ${this.totalCalls} calls, ${this.messageCount} messages`
    );
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCachedTokens = 0;
    this.totalCost = 0;
    this.recentCalls = [];
    this.totalCalls = 0;
    this.messageCount = 0;
    this.startTime = Date.now();
  }

  /**
   * Log current statistics
   */
  logStats() {
    const stats = this.getStats();
    logger.info(`💰 Cost Monitor Stats:`, {
      calls: stats.totalCalls,
      tokens: stats.totalTokens,
      cost: `$${stats.estimatedCost.toFixed(2)}`,
      costPerHour: `$${stats.costPerHour.toFixed(2)}/hr`,
      uptimeHours: (stats.uptime / (1000 * 60 * 60)).toFixed(1),
    });
  }
}

// Export singleton
export const costMonitor = new CostMonitor();
