import { getSyncDb, createQueue, logger } from '@coachartie/shared';
import { costMonitor } from './cost-monitor.js';

/**
 * Distress monitoring service for Artie
 * Detects when Artie is struggling and needs human intervention
 */

export interface DistressSignals {
  negativeReactionRate: number;  // negative / total in last hour
  apiErrorRate: number;          // errors / calls in last hour
  messageQueueDepth: number;     // pending messages
  burnRate: number;              // $/hour API spend
  timestamp: Date;
}

export interface DistressThresholds {
  negativeReactionRate: number;  // 30% negative = distress
  apiErrorRate: number;          // 10% errors = trouble
  messageQueueDepth: number;     // 50+ backed up = overload
  burnRate: number;              // $1.50/hr = high spend
}

class DistressMonitor {
  private static instance: DistressMonitor;
  private checkInterval: NodeJS.Timeout | null = null;
  private lastAlertTime: Date | null = null;
  private readonly ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours
  private readonly CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

  private thresholds: DistressThresholds = {
    negativeReactionRate: 0.3,   // 30% negative = distress
    apiErrorRate: 0.1,           // 10% errors = trouble
    messageQueueDepth: 50,       // 50+ backed up = overload
    burnRate: 1.5,               // $1.50/hr = high spend
  };

  private constructor() {
    // Load thresholds from env if available
    if (process.env.DISTRESS_NEGATIVE_RATE) {
      this.thresholds.negativeReactionRate = parseFloat(process.env.DISTRESS_NEGATIVE_RATE);
    }
    if (process.env.DISTRESS_ERROR_RATE) {
      this.thresholds.apiErrorRate = parseFloat(process.env.DISTRESS_ERROR_RATE);
    }
    if (process.env.DISTRESS_QUEUE_DEPTH) {
      this.thresholds.messageQueueDepth = parseInt(process.env.DISTRESS_QUEUE_DEPTH);
    }
    if (process.env.DISTRESS_BURN_RATE) {
      this.thresholds.burnRate = parseFloat(process.env.DISTRESS_BURN_RATE);
    }
  }

  static getInstance(): DistressMonitor {
    if (!DistressMonitor.instance) {
      DistressMonitor.instance = new DistressMonitor();
    }
    return DistressMonitor.instance;
  }

  /**
   * Start the distress monitoring loop
   */
  start(): void {
    if (this.checkInterval) {
      logger.warn('Distress monitor already running');
      return;
    }

    logger.info('🆘 Distress Monitor started with thresholds:', this.thresholds);

    // Run immediately, then on interval
    this.runCheck();
    this.checkInterval = setInterval(() => this.runCheck(), this.CHECK_INTERVAL_MS);
  }

  /**
   * Stop the distress monitoring loop
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logger.info('🆘 Distress Monitor stopped');
    }
  }

  /**
   * Run a single distress check
   */
  private async runCheck(): Promise<void> {
    try {
      const signals = await this.checkDistress();
      if (signals) {
        // Check cooldown
        if (this.lastAlertTime) {
          const timeSinceLastAlert = Date.now() - this.lastAlertTime.getTime();
          if (timeSinceLastAlert < this.ALERT_COOLDOWN_MS) {
            logger.debug('🆘 Distress detected but in cooldown period');
            return;
          }
        }

        await this.sendDistressAlert(signals);
        this.lastAlertTime = new Date();
      }
    } catch (error) {
      logger.error('Distress check failed:', error);
    }
  }

  /**
   * Check for distress signals
   * Returns signals if any threshold is exceeded, null otherwise
   */
  async checkDistress(): Promise<DistressSignals | null> {
    const signals: DistressSignals = {
      negativeReactionRate: await this.getNegativeReactionRate(),
      apiErrorRate: await this.getApiErrorRate(),
      messageQueueDepth: await this.getMessageQueueDepth(),
      burnRate: this.getBurnRate(),
      timestamp: new Date(),
    };

    // Check if any threshold exceeded
    if (signals.negativeReactionRate > this.thresholds.negativeReactionRate) {
      logger.warn(`🆘 Distress: ${(signals.negativeReactionRate * 100).toFixed(0)}% negative reactions`);
      return signals;
    }
    if (signals.apiErrorRate > this.thresholds.apiErrorRate) {
      logger.warn(`🆘 Distress: ${(signals.apiErrorRate * 100).toFixed(0)}% API errors`);
      return signals;
    }
    if (signals.messageQueueDepth > this.thresholds.messageQueueDepth) {
      logger.warn(`🆘 Distress: ${signals.messageQueueDepth} messages queued`);
      return signals;
    }
    if (signals.burnRate > this.thresholds.burnRate) {
      logger.warn(`🆘 Distress: $${signals.burnRate.toFixed(2)}/hr burn rate`);
      return signals;
    }

    return null;
  }

  /**
   * Get negative reaction rate from last hour
   */
  private async getNegativeReactionRate(): Promise<number> {
    try {
      const db = getSyncDb();

      const result = db.get<{ negative: number; total: number }>(`
        SELECT
          SUM(CASE WHEN tags LIKE '%negative%' THEN 1 ELSE 0 END) as negative,
          COUNT(*) as total
        FROM memories
        WHERE created_at > datetime('now', '-1 hour')
        AND tags LIKE '%feedback%'
      `);

      if (!result || result.total === 0) {
        return 0;
      }

      return result.negative / result.total;
    } catch (error) {
      logger.debug('Failed to get negative reaction rate:', error);
      return 0;
    }
  }

  /**
   * Get API error rate from last hour
   * Uses the metrics or logs to calculate
   */
  private async getApiErrorRate(): Promise<number> {
    try {
      const db = getSyncDb();

      // Check model_usage_stats for errors in last hour
      const result = db.get<{ errors: number; total: number }>(`
        SELECT
          SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as errors,
          COUNT(*) as total
        FROM model_usage_stats
        WHERE timestamp > datetime('now', '-1 hour')
      `);

      if (!result || result.total === 0) {
        return 0;
      }

      return result.errors / result.total;
    } catch (error) {
      logger.debug('Failed to get API error rate:', error);
      return 0;
    }
  }

  /**
   * Get current message queue depth
   */
  private async getMessageQueueDepth(): Promise<number> {
    try {
      // Try to get queue stats from BullMQ
      const queue = createQueue('coachartie-incoming');
      const waiting = await queue.getWaitingCount();
      const active = await queue.getActiveCount();
      return waiting + active;
    } catch (error) {
      logger.debug('Failed to get queue depth:', error);
      return 0;
    }
  }

  /**
   * Get current burn rate from cost monitor
   */
  private getBurnRate(): number {
    try {
      const stats = costMonitor.getStats();
      return stats.costPerHour;
    } catch (error) {
      logger.debug('Failed to get burn rate:', error);
      return 0;
    }
  }

  /**
   * Send distress alert to EJ via Discord DM and VPS alert system
   */
  private async sendDistressAlert(signals: DistressSignals): Promise<void> {
    const reasons: string[] = [];

    if (signals.negativeReactionRate > this.thresholds.negativeReactionRate) {
      reasons.push(`${(signals.negativeReactionRate * 100).toFixed(0)}% negative reactions`);
    }
    if (signals.apiErrorRate > this.thresholds.apiErrorRate) {
      reasons.push(`${(signals.apiErrorRate * 100).toFixed(0)}% API errors`);
    }
    if (signals.messageQueueDepth > this.thresholds.messageQueueDepth) {
      reasons.push(`${signals.messageQueueDepth} messages queued`);
    }
    if (signals.burnRate > this.thresholds.burnRate) {
      reasons.push(`$${signals.burnRate.toFixed(2)}/hr burn rate`);
    }

    const message = `**Artie needs help**\n${reasons.join('\n')}\n\nCheck: https://brain.coachartiebot.com`;

    logger.error(`🆘 DISTRESS ALERT: ${reasons.join(', ')}`);

    // Send Discord DM to admin
    try {
      const adminDiscordId = process.env.ADMIN_DISCORD_ID;
      if (adminDiscordId) {
        const outgoingQueue = createQueue('coachartie-discord-outgoing');
        await outgoingQueue.add('send-message', {
          userId: adminDiscordId,
          content: `🆘 ${message}`,
          source: 'distress-monitor',
        });
        logger.info('🆘 Distress alert sent to Discord');
      }
    } catch (error) {
      logger.error('Failed to send Discord distress alert:', error);
    }

    // Send to VPS alert system
    try {
      const vpsAlertUrl = process.env.VPS_ALERT_WEBHOOK || 'http://localhost:7777/webhook/artie-distress';
      await fetch(vpsAlertUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Host': 'n8n.tools.ejfox.com' },
        body: JSON.stringify({ signals, reasons }),
      });
      logger.info('🆘 Distress alert sent to VPS');
    } catch (error) {
      logger.debug('Failed to send VPS distress alert (non-critical):', error);
    }

    // Record the distress event
    try {
      const db = getSyncDb();
      db.run(`
        INSERT INTO distress_events (signals, reasons, created_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
      `, [JSON.stringify(signals), JSON.stringify(reasons)]);
    } catch (error) {
      // Table might not exist, that's ok
      logger.debug('Failed to record distress event:', error);
    }
  }

  /**
   * Manually trigger a distress check (for testing)
   */
  async triggerCheck(): Promise<DistressSignals | null> {
    return await this.checkDistress();
  }

  /**
   * Get current thresholds
   */
  getThresholds(): DistressThresholds {
    return { ...this.thresholds };
  }

  /**
   * Get current distress status for Artie's self-awareness
   * Returns a brief description if under stress, empty string otherwise
   */
  async getSelfAwarenessNote(): Promise<string> {
    try {
      const signals: DistressSignals = {
        negativeReactionRate: await this.getNegativeReactionRate(),
        apiErrorRate: await this.getApiErrorRate(),
        messageQueueDepth: await this.getMessageQueueDepth(),
        burnRate: this.getBurnRate(),
        timestamp: new Date(),
      };

      const concerns: string[] = [];

      // Check each signal and build awareness notes
      if (signals.negativeReactionRate > this.thresholds.negativeReactionRate * 0.7) {
        const pct = Math.round(signals.negativeReactionRate * 100);
        if (signals.negativeReactionRate > this.thresholds.negativeReactionRate) {
          concerns.push(`${pct}% of recent reactions have been negative - I might be saying something wrong`);
        } else {
          concerns.push(`${pct}% negative reactions lately`);
        }
      }

      if (signals.apiErrorRate > this.thresholds.apiErrorRate * 0.7) {
        const pct = Math.round(signals.apiErrorRate * 100);
        concerns.push(`experiencing ${pct}% API errors`);
      }

      if (signals.messageQueueDepth > this.thresholds.messageQueueDepth * 0.5) {
        if (signals.messageQueueDepth > this.thresholds.messageQueueDepth) {
          concerns.push(`overwhelmed with ${signals.messageQueueDepth} messages queued`);
        } else {
          concerns.push(`${signals.messageQueueDepth} messages waiting`);
        }
      }

      if (signals.burnRate > this.thresholds.burnRate * 0.8) {
        concerns.push(`spending $${signals.burnRate.toFixed(2)}/hr on API calls`);
      }

      if (concerns.length === 0) {
        return '';
      }

      // Build the awareness note
      if (concerns.length === 1) {
        return `I'm ${concerns[0]}.`;
      }
      return `I'm currently: ${concerns.join('; ')}.`;
    } catch (error) {
      logger.debug('Failed to get self-awareness note:', error);
      return '';
    }
  }

  /**
   * Update thresholds at runtime
   */
  setThresholds(newThresholds: Partial<DistressThresholds>): void {
    this.thresholds = { ...this.thresholds, ...newThresholds };
    logger.info('🆘 Distress thresholds updated:', this.thresholds);
  }
}

// Export singleton
export const distressMonitor = DistressMonitor.getInstance();
