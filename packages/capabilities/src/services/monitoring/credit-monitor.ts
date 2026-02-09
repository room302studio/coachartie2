import { getSyncDb, createQueue } from '@coachartie/shared';
import { logger } from '@coachartie/shared';

export interface CreditInfo {
  provider: string;
  credits_remaining?: number;
  credits_used?: number;
  daily_spend?: number;
  monthly_spend?: number;
  rate_limit_remaining?: number;
  rate_limit_reset?: Date;
  raw_response?: any;
}

export interface CreditAlert {
  alert_type: string;
  threshold_value?: number;
  current_value?: number;
  message: string;
  severity: 'info' | 'warning' | 'critical';
}

export class CreditMonitor {
  private static instance: CreditMonitor;
  private alertThresholds = {
    low_balance_critical: 5.0, // $5 remaining
    low_balance_warning: 25.0, // $25 remaining
    daily_limit_warning: 50.0, // $50/day
    rate_limit_threshold: 5, // 5 requests remaining
  };

  // Track credit exhaustion to avoid repeated API calls when out of credits
  private creditsExhaustedAt: Date | null = null;
  private static EXHAUSTION_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes before retrying

  private constructor() {}

  /**
   * Mark credits as exhausted (call this when we get a 402 error)
   */
  markCreditsExhausted(): void {
    this.creditsExhaustedAt = new Date();
    logger.warn('💳 Credits marked as EXHAUSTED - will skip API calls for 5 minutes');
  }

  /**
   * Check if credits are currently exhausted (within cooldown period)
   */
  areCreditsExhausted(): boolean {
    if (!this.creditsExhaustedAt) {
      return false;
    }
    const timeSinceExhaustion = Date.now() - this.creditsExhaustedAt.getTime();
    if (timeSinceExhaustion > CreditMonitor.EXHAUSTION_COOLDOWN_MS) {
      // Cooldown expired, clear the flag and allow retrying
      this.creditsExhaustedAt = null;
      logger.info('💳 Credit exhaustion cooldown expired - will retry API calls');
      return false;
    }
    return true;
  }

  /**
   * Clear the exhausted flag (call this after adding credits)
   */
  clearExhaustedFlag(): void {
    this.creditsExhaustedAt = null;
    logger.info('💳 Credit exhaustion flag cleared');
  }

  static getInstance(): CreditMonitor {
    if (!CreditMonitor.instance) {
      CreditMonitor.instance = new CreditMonitor();
    }
    return CreditMonitor.instance;
  }

  /**
   * Proactively check credit balance by calling the API
   * Call this on startup and periodically to catch low balance before exhaustion
   */
  async proactiveBalanceCheck(): Promise<{ balance: number | null; error?: string }> {
    const baseURL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
    const apiKey = process.env.OPENROUTER_API_KEY;

    if (!apiKey) {
      return { balance: null, error: 'No API key configured' };
    }

    try {
      // Try to get credits/balance from the API
      const response = await fetch(`${baseURL.replace('/v1', '')}/api/v1/auth/key`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      if (!response.ok) {
        // If auth/key endpoint doesn't exist, try a minimal completion to get usage info
        logger.debug(`Credit check endpoint returned ${response.status}, balance unknown`);
        return { balance: null, error: `API returned ${response.status}` };
      }

      const data = (await response.json()) as { data?: { limit?: number; usage?: number } };

      if (data.data?.limit !== undefined && data.data?.usage !== undefined) {
        const balance = data.data.limit - data.data.usage;

        // Log and alert based on balance
        if (balance <= 0) {
          logger.error(`\n${'='.repeat(60)}`);
          logger.error(`🚨 CREDITS EXHAUSTED! Balance: $${balance.toFixed(2)}`);
          logger.error(`   Add credits at: https://openrouter.ai/settings/credits`);
          logger.error(`${'='.repeat(60)}\n`);
          this.markCreditsExhausted();
        } else if (balance <= this.alertThresholds.low_balance_critical) {
          logger.error(`🚨 CRITICAL: Only $${balance.toFixed(2)} credits remaining!`);
        } else if (balance <= this.alertThresholds.low_balance_warning) {
          logger.warn(`⚠️ LOW CREDITS: $${balance.toFixed(2)} remaining`);
        } else {
          logger.info(`💳 Credit balance: $${balance.toFixed(2)}`);
        }

        return { balance };
      }

      return { balance: null, error: 'Balance not in response' };
    } catch (error) {
      logger.debug(`Credit check failed: ${error}`);
      return { balance: null, error: String(error) };
    }
  }

  /**
   * Extract and store credit information from OpenRouter response
   */
  async recordCreditInfo(creditData: any): Promise<void> {
    try {
      const db = getSyncDb();

      // Extract credit info from the response
      const creditInfo: CreditInfo = {
        provider: 'openrouter',
        credits_remaining: creditData.credits_remaining,
        credits_used: creditData.credits_used,
        daily_spend: creditData.daily_spend,
        monthly_spend: creditData.monthly_spend,
        rate_limit_remaining: creditData.rate_limit_remaining,
        rate_limit_reset: creditData.rate_limit_reset
          ? new Date(creditData.rate_limit_reset)
          : undefined,
        raw_response: JSON.stringify(creditData),
      };

      // Insert or update credit balance
      db.run(
        `
        INSERT OR REPLACE INTO credit_balance (
          provider, credits_remaining, credits_used, daily_spend, monthly_spend,
          rate_limit_remaining, rate_limit_reset, last_updated, raw_response
        ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
      `,
        [
          creditInfo.provider,
          creditInfo.credits_remaining,
          creditInfo.credits_used,
          creditInfo.daily_spend,
          creditInfo.monthly_spend,
          creditInfo.rate_limit_remaining,
          creditInfo.rate_limit_reset?.toISOString(),
          creditInfo.raw_response,
        ]
      );

      // Check for alerts
      await this.checkAndCreateAlerts(creditInfo);

      logger.info(
        `💳 Credit info recorded: ${creditInfo.credits_remaining || 'unknown'} credits remaining`
      );
    } catch (error) {
      logger.error('❌ Failed to record credit info:', error);
    }
  }

  /**
   * Get current credit balance
   */
  async getCurrentBalance(): Promise<CreditInfo | null> {
    try {
      const db = getSyncDb();

      const result = db.get(`
        SELECT * FROM credit_balance 
        WHERE provider = 'openrouter' 
        ORDER BY last_updated DESC 
        LIMIT 1
      `);

      if (!result) {
        return null;
      }

      return {
        provider: result.provider,
        credits_remaining: result.credits_remaining,
        credits_used: result.credits_used,
        daily_spend: result.daily_spend,
        monthly_spend: result.monthly_spend,
        rate_limit_remaining: result.rate_limit_remaining,
        rate_limit_reset: result.rate_limit_reset ? new Date(result.rate_limit_reset) : undefined,
      };
    } catch (error) {
      logger.error('❌ Failed to get current balance:', error);
      return null;
    }
  }

  /**
   * Check credit levels and create alerts if needed
   */
  private async checkAndCreateAlerts(creditInfo: CreditInfo): Promise<void> {
    const alerts: CreditAlert[] = [];

    // Check low balance alerts
    if (creditInfo.credits_remaining !== undefined) {
      if (creditInfo.credits_remaining <= this.alertThresholds.low_balance_critical) {
        alerts.push({
          alert_type: 'low_balance',
          threshold_value: this.alertThresholds.low_balance_critical,
          current_value: creditInfo.credits_remaining,
          message: `🚨 CRITICAL: Only $${creditInfo.credits_remaining.toFixed(2)} credits remaining!`,
          severity: 'critical',
        });
      } else if (creditInfo.credits_remaining <= this.alertThresholds.low_balance_warning) {
        alerts.push({
          alert_type: 'low_balance',
          threshold_value: this.alertThresholds.low_balance_warning,
          current_value: creditInfo.credits_remaining,
          message: `⚠️ Warning: Credits getting low ($${creditInfo.credits_remaining.toFixed(2)} remaining)`,
          severity: 'warning',
        });
      }
    }

    // Check daily spend alerts
    if (
      creditInfo.daily_spend !== undefined &&
      creditInfo.daily_spend >= this.alertThresholds.daily_limit_warning
    ) {
      alerts.push({
        alert_type: 'daily_spend',
        threshold_value: this.alertThresholds.daily_limit_warning,
        current_value: creditInfo.daily_spend,
        message: `💰 High daily spend: $${creditInfo.daily_spend.toFixed(2)} today`,
        severity: 'warning',
      });
    }

    // Check rate limit alerts
    if (
      creditInfo.rate_limit_remaining !== undefined &&
      creditInfo.rate_limit_remaining <= this.alertThresholds.rate_limit_threshold
    ) {
      alerts.push({
        alert_type: 'rate_limit',
        threshold_value: this.alertThresholds.rate_limit_threshold,
        current_value: creditInfo.rate_limit_remaining,
        message: `⏱️ Rate limit low: ${creditInfo.rate_limit_remaining} requests remaining`,
        severity: 'warning',
      });
    }

    // Store alerts in database
    for (const alert of alerts) {
      await this.createAlert(alert);
    }
  }

  /**
   * Create a credit alert
   */
  private async createAlert(alert: CreditAlert): Promise<void> {
    try {
      const db = getSyncDb();

      // Check if we already have a recent alert of this type
      const recentAlert = db.get(
        `
        SELECT id FROM credit_alerts
        WHERE alert_type = ? AND severity = ?
        AND created_at > datetime('now', '-1 hour')
        AND acknowledged = 0
      `,
        [alert.alert_type, alert.severity]
      );

      if (recentAlert) {
        // Don't spam alerts - we already have a recent one
        return;
      }

      db.run(
        `
        INSERT INTO credit_alerts (
          alert_type, threshold_value, current_value, message, severity
        ) VALUES (?, ?, ?, ?, ?)
      `,
        [
          alert.alert_type,
          alert.threshold_value,
          alert.current_value,
          alert.message,
          alert.severity,
        ]
      );

      // Log the alert
      const emoji = alert.severity === 'critical' ? '🚨' : '⚠️';
      logger.warn(`${emoji} Credit Alert: ${alert.message}`);

      // Send Discord notification for critical alerts
      if (alert.severity === 'critical') {
        await this.sendDiscordNotification(alert);
      }
    } catch (error) {
      logger.error('❌ Failed to create alert:', error);
    }
  }

  /**
   * Send Discord notification for critical alerts
   */
  private async sendDiscordNotification(alert: CreditAlert): Promise<void> {
    try {
      // Get admin Discord ID from environment
      const adminDiscordId = process.env.ADMIN_DISCORD_ID;
      const adminChannelId = process.env.ADMIN_CHANNEL_ID;

      if (!adminDiscordId && !adminChannelId) {
        logger.warn(
          '⚠️ No ADMIN_DISCORD_ID or ADMIN_CHANNEL_ID configured - skipping Discord notification'
        );
        return;
      }

      const notificationMessage = `${alert.message}

**Add credits here:** https://openrouter.ai/settings/credits

This is an automated alert from the credit monitoring system.`;

      // Send directly to Discord outgoing queue (bypass processing)
      const outgoingQueue = createQueue('coachartie-discord-outgoing');

      await outgoingQueue.add('send-message', {
        userId: adminDiscordId,
        channelId: adminChannelId,
        content: notificationMessage,
        source: 'credit-monitor',
      });

      logger.info(`💳 Critical credit alert sent to Discord (${adminDiscordId || adminChannelId})`);
    } catch (error) {
      logger.error('❌ Failed to send Discord notification:', error);
      // Don't throw - notification failure shouldn't break credit monitoring
    }
  }

  /**
   * Get recent unacknowledged alerts
   */
  async getActiveAlerts(): Promise<CreditAlert[]> {
    try {
      const db = getSyncDb();

      const results = db.all(`
        SELECT alert_type, threshold_value, current_value, message, severity
        FROM credit_alerts 
        WHERE acknowledged = 0 
        AND created_at > datetime('now', '-24 hours')
        ORDER BY created_at DESC
      `);

      return results.map((row) => ({
        alert_type: row.alert_type,
        threshold_value: row.threshold_value,
        current_value: row.current_value,
        message: row.message,
        severity: row.severity as 'info' | 'warning' | 'critical',
      }));
    } catch (error) {
      logger.error('❌ Failed to get active alerts:', error);
      return [];
    }
  }

  /**
   * Acknowledge all alerts of a specific type
   */
  async acknowledgeAlerts(alertType: string): Promise<void> {
    try {
      const db = getSyncDb();

      db.run(
        `
        UPDATE credit_alerts 
        SET acknowledged = 1 
        WHERE alert_type = ? AND acknowledged = 0
      `,
        [alertType]
      );

      logger.info(`✅ Acknowledged all ${alertType} alerts`);
    } catch (error) {
      logger.error('❌ Failed to acknowledge alerts:', error);
    }
  }

  /**
   * Get credit usage statistics
   */
  async getUsageStats(days: number = 7): Promise<{
    total_spend: number;
    daily_average: number;
    requests_count: number;
    estimated_days_remaining: number;
  }> {
    try {
      const db = getSyncDb();

      const result = db.get(`
        SELECT 
          SUM(estimated_cost) as total_spend,
          COUNT(*) as requests_count,
          AVG(estimated_cost) as avg_cost_per_request
        FROM model_usage_stats 
        WHERE timestamp >= datetime('now', '-${days} days')
      `);

      const currentBalance = await this.getCurrentBalance();
      const totalSpend = result?.total_spend || 0;
      const dailyAverage = totalSpend / days;
      const estimatedDaysRemaining = currentBalance?.credits_remaining
        ? Math.floor(currentBalance.credits_remaining / Math.max(dailyAverage, 0.01))
        : 0;

      return {
        total_spend: totalSpend,
        daily_average: dailyAverage,
        requests_count: result?.requests_count || 0,
        estimated_days_remaining: estimatedDaysRemaining,
      };
    } catch (error) {
      logger.error('❌ Failed to get usage stats:', error);
      return { total_spend: 0, daily_average: 0, requests_count: 0, estimated_days_remaining: 0 };
    }
  }
}

// Export singleton instance
export const creditMonitor = CreditMonitor.getInstance();
