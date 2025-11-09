import { logger } from '@coachartie/shared';

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

    // Check tokens per call limit
    if (callTokens > this.maxTokensPerCall) {
      const warning = `⚠️ High token usage: ${callTokens.toLocaleString()} tokens in single call (limit: ${this.maxTokensPerCall.toLocaleString()})`;
      logger.warn(warning);
      warnings.push(warning);
    }

    // Check cost per hour limit
    const stats = this.getStats();
    if (stats.costPerHour > this.maxCostPerHour) {
      const warning = `🚨 High burn rate: $${stats.costPerHour.toFixed(2)}/hour (limit: $${this.maxCostPerHour}/hr)`;
      logger.error(warning);
      warnings.push(warning);
    }

    // Legacy hard-coded alerts
    if (totalCost > 5.0 && this.totalCalls % 10 === 0) {
      logger.warn(
        `⚠️ High API costs detected: $${totalCost.toFixed(2)} across ${this.totalCalls} calls`
      );
    }

    if (totalCost > 20.0 && this.totalCalls % 5 === 0) {
      logger.error(
        `🚨 VERY HIGH API COSTS: $${totalCost.toFixed(2)} - Consider adding rate limits!`
      );
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
