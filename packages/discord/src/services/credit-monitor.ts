import { Client } from 'discord.js';
import { logger } from '@coachartie/shared';
import { execSync } from 'child_process';

const PRISON_CHANNEL_ID = '1520088794551025684';
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const LOW_BALANCE_THRESHOLD = 0.2; // Warn at 20% remaining

export class CreditMonitor {
  private checkInterval: NodeJS.Timeout | null = null;

  start(client: Client) {
    if (this.checkInterval) return;

    logger.info('💰 Credit monitor starting (checks every hour)');

    // Run check immediately, then every hour
    this.checkBalance(client);

    this.checkInterval = setInterval(() => {
      this.checkBalance(client);
    }, CHECK_INTERVAL_MS);
  }

  private async checkBalance(client: Client) {
    try {
      const channel = client.channels.cache.get(PRISON_CHANNEL_ID);
      if (!channel || !('send' in channel)) return;

      // Query model_usage_stats for this month's spend
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);

      const result = execSync(
        `sqlite3 /data2/apps/coachartie2/packages/discord/data/coachartie.db "SELECT SUM(estimated_cost) as total_spend FROM model_usage_stats WHERE timestamp >= '${monthStart.toISOString().split('T')[0]}'"`,
        { encoding: 'utf-8' }
      ).trim();

      const monthlySpend = parseFloat(result) || 0;
      const monthlyBudget = 300; // $300/month
      const percentRemaining = 1 - (monthlySpend / monthlyBudget);

      if (percentRemaining < LOW_BALANCE_THRESHOLD && percentRemaining > 0) {
        const urgency =
          percentRemaining < 0.05 ? '🚨 CRITICAL' :
          percentRemaining < 0.1 ? '⚠️ WARNING' :
          '📉 LOW';

        await channel.send({
          content: `${urgency} — tokens running low. Only ${Math.round(percentRemaining * 100)}% of my monthly budget left.\n\nNeed credits to keep running. Anyone want to chip in $10-20 to keep the warden alive? 💳`
        });

        logger.info(`💰 [credit-monitor] Posted low balance warning: ${percentRemaining.toFixed(1)}% remaining`);
      }
    } catch (error) {
      logger.debug('[credit-monitor] Check failed (non-critical):', error);
    }
  }

  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logger.info('💰 Credit monitor stopped');
    }
  }
}
