import { logger } from '@coachartie/shared';
import { recordApiCall } from '../metrics.js';
import { UsageTracker } from './usage-tracker.js';

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
    cachedTokens = 0
  ): { shouldCheckCredits: boolean; warnings: string[] } {
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.totalCachedTokens += Math.min(Math.max(cachedTokens, 0), inputTokens);
    this.totalCalls++;

    const estimatedCost = this.calculateCost(inputTokens, outputTokens, cachedTokens, model);
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
        const sev = runwayHours < critHours ? '🚨' : '⚠️';
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

    return {
      totalCalls: this.totalCalls,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalTokens: this.totalInputTokens + this.totalOutputTokens,
      totalCachedTokens: this.totalCachedTokens,
      estimatedCost: this.getTotalEstimatedCost(),
      // Cumulative average since boot. Kept for reporting; NOT a rate — see
      // getRecentBurnPerHour, which is what anything making a decision should use.
      costPerHour: hours > 0 ? this.getTotalEstimatedCost() / hours : 0,
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
