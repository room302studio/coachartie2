import { logger } from '@coachartie/shared';
import { recordApiCall } from '../metrics.js';

/**
 * Simple cost monitoring service to track OpenRouter API usage
 * Helps prevent runaway costs by logging and alerting
 */
class CostMonitor {
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCalls = 0;
  private startTime = Date.now();
  private messageCount = 0;
  private statsInterval: NodeJS.Timeout | null = null;

  // "Floating ballast" state: the latest known real balance (fed by the credit
  // monitor) and the last time we emitted a runway warning (for throttling).
  private lastKnownBalance: number | null = null;
  private lastRunwayWarnAt = 0;

  // Approximate pricing for Claude 3.5 Sonnet (update these as needed)
  private readonly INPUT_COST_PER_MILLION = 3.0; // $3 per 1M input tokens
  private readonly OUTPUT_COST_PER_MILLION = 15.0; // $15 per 1M output tokens

  // Tunable limits from env vars
  private readonly maxCostPerHour: number;
  private readonly maxTokensPerCall: number;
  private readonly autoCheckCreditsEvery: number;

  constructor() {
    this.maxCostPerHour = parseFloat(process.env.MAX_COST_PER_HOUR || '10.0');
    this.maxTokensPerCall = parseInt(process.env.MAX_TOKENS_PER_CALL || '8000');
    this.autoCheckCreditsEvery = parseInt(process.env.AUTO_CHECK_CREDITS_EVERY || '50');

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
  trackCall(
    inputTokens: number,
    outputTokens: number,
    model: string
  ): { shouldCheckCredits: boolean; warnings: string[] } {
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.totalCalls++;

    const estimatedCost = this.calculateCost(inputTokens, outputTokens);
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
  private calculateCost(inputTokens: number, outputTokens: number): number {
    const inputCost = (inputTokens / 1_000_000) * this.INPUT_COST_PER_MILLION;
    const outputCost = (outputTokens / 1_000_000) * this.OUTPUT_COST_PER_MILLION;
    return inputCost + outputCost;
  }

  /**
   * Get total estimated cost
   */
  getTotalEstimatedCost(): number {
    return this.calculateCost(this.totalInputTokens, this.totalOutputTokens);
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
      estimatedCost: this.getTotalEstimatedCost(),
      costPerHour: hours > 0 ? this.getTotalEstimatedCost() / hours : 0,
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
