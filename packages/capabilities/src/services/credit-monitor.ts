import { getDatabase } from '@coachartie/shared';
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
    low_balance_critical: 5.0,    // $5 remaining
    low_balance_warning: 25.0,    // $25 remaining
    daily_limit_warning: 50.0,    // $50/day
    rate_limit_threshold: 5       // 5 requests remaining
  };

  private constructor() {}

  static getInstance(): CreditMonitor {
    if (!CreditMonitor.instance) {
      CreditMonitor.instance = new CreditMonitor();
    }
    return CreditMonitor.instance;
  }

  /**
   * Extract and store credit information from OpenRouter response
   */
  async recordCreditInfo(creditData: any): Promise<void> {
    try {
      const db = await getDatabase();
      
      // Extract credit info from the response
      const creditInfo: CreditInfo = {
        provider: 'openrouter',
        credits_remaining: creditData.credits_remaining,
        credits_used: creditData.credits_used,
        daily_spend: creditData.daily_spend,
        monthly_spend: creditData.monthly_spend,
        rate_limit_remaining: creditData.rate_limit_remaining,
        rate_limit_reset: creditData.rate_limit_reset ? new Date(creditData.rate_limit_reset) : undefined,
        raw_response: JSON.stringify(creditData)
      };

      // Insert or update credit balance
      await db.run(`
        INSERT OR REPLACE INTO credit_balance (
          provider, credits_remaining, credits_used, daily_spend, monthly_spend,
          rate_limit_remaining, rate_limit_reset, last_updated, raw_response
        ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
      `, [
        creditInfo.provider,
        creditInfo.credits_remaining,
        creditInfo.credits_used,
        creditInfo.daily_spend,
        creditInfo.monthly_spend,
        creditInfo.rate_limit_remaining,
        creditInfo.rate_limit_reset?.toISOString(),
        creditInfo.raw_response
      ]);

      // Check for alerts
      await this.checkAndCreateAlerts(creditInfo);

      logger.info(`💳 Credit info recorded: ${creditInfo.credits_remaining || 'unknown'} credits remaining`);
    } catch (error) {
      logger.error('❌ Failed to record credit info:', error);
    }
  }

  /**
   * Get current credit balance
   */
  async getCurrentBalance(): Promise<CreditInfo | null> {
    try {
      const db = await getDatabase();
      
      const result = await db.get(`
        SELECT * FROM credit_balance 
        WHERE provider = 'openrouter' 
        ORDER BY last_updated DESC 
        LIMIT 1
      `);

      if (!result) {return null;}

      return {
        provider: result.provider,
        credits_remaining: result.credits_remaining,
        credits_used: result.credits_used,
        daily_spend: result.daily_spend,
        monthly_spend: result.monthly_spend,
        rate_limit_remaining: result.rate_limit_remaining,
        rate_limit_reset: result.rate_limit_reset ? new Date(result.rate_limit_reset) : undefined
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
          severity: 'critical'
        });
      } else if (creditInfo.credits_remaining <= this.alertThresholds.low_balance_warning) {
        alerts.push({
          alert_type: 'low_balance',
          threshold_value: this.alertThresholds.low_balance_warning,
          current_value: creditInfo.credits_remaining,
          message: `⚠️ Warning: Credits getting low ($${creditInfo.credits_remaining.toFixed(2)} remaining)`,
          severity: 'warning'
        });
      }
    }

    // Check daily spend alerts
    if (creditInfo.daily_spend !== undefined && creditInfo.daily_spend >= this.alertThresholds.daily_limit_warning) {
      alerts.push({
        alert_type: 'daily_spend',
        threshold_value: this.alertThresholds.daily_limit_warning,
        current_value: creditInfo.daily_spend,
        message: `💰 High daily spend: $${creditInfo.daily_spend.toFixed(2)} today`,
        severity: 'warning'
      });
    }

    // Check rate limit alerts
    if (creditInfo.rate_limit_remaining !== undefined && creditInfo.rate_limit_remaining <= this.alertThresholds.rate_limit_threshold) {
      alerts.push({
        alert_type: 'rate_limit',
        threshold_value: this.alertThresholds.rate_limit_threshold,
        current_value: creditInfo.rate_limit_remaining,
        message: `⏱️ Rate limit low: ${creditInfo.rate_limit_remaining} requests remaining`,
        severity: 'warning'
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
      const db = await getDatabase();
      
      // Check if we already have a recent alert of this type
      const recentAlert = await db.get(`
        SELECT id FROM credit_alerts 
        WHERE alert_type = ? AND severity = ?
        AND created_at > datetime('now', '-1 hour')
        AND acknowledged = 0
      `, [alert.alert_type, alert.severity]);

      if (recentAlert) {
        // Don't spam alerts - we already have a recent one
        return;
      }

      await db.run(`
        INSERT INTO credit_alerts (
          alert_type, threshold_value, current_value, message, severity
        ) VALUES (?, ?, ?, ?, ?)
      `, [
        alert.alert_type,
        alert.threshold_value,
        alert.current_value,
        alert.message,
        alert.severity
      ]);

      // Log the alert
      const emoji = alert.severity === 'critical' ? '🚨' : '⚠️';
      logger.warn(`${emoji} Credit Alert: ${alert.message}`);
    } catch (error) {
      logger.error('❌ Failed to create alert:', error);
    }
  }

  /**
   * Get recent unacknowledged alerts
   */
  async getActiveAlerts(): Promise<CreditAlert[]> {
    try {
      const db = await getDatabase();
      
      const results = await db.all(`
        SELECT alert_type, threshold_value, current_value, message, severity
        FROM credit_alerts 
        WHERE acknowledged = 0 
        AND created_at > datetime('now', '-24 hours')
        ORDER BY created_at DESC
      `);

      return results.map(row => ({
        alert_type: row.alert_type,
        threshold_value: row.threshold_value,
        current_value: row.current_value,
        message: row.message,
        severity: row.severity as 'info' | 'warning' | 'critical'
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
      const db = await getDatabase();
      
      await db.run(`
        UPDATE credit_alerts 
        SET acknowledged = 1 
        WHERE alert_type = ? AND acknowledged = 0
      `, [alertType]);

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
      const db = await getDatabase();
      
      const result = await db.get(`
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
        estimated_days_remaining: estimatedDaysRemaining
      };
    } catch (error) {
      logger.error('❌ Failed to get usage stats:', error);
      return { total_spend: 0, daily_average: 0, requests_count: 0, estimated_days_remaining: 0 };
    }
  }
}

// Export singleton instance
export const creditMonitor = CreditMonitor.getInstance();