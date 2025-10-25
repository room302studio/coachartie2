import { logger } from '@coachartie/shared';
import { creditMonitor } from '../services/credit-monitor.js';
import { costMonitor } from '../services/cost-monitor.js';
import { RegisteredCapability } from '../services/capability-registry.js';

export const creditStatusCapability: RegisteredCapability = {
  name: 'credit_status',
  supportedActions: ['check_balance', 'get_alerts', 'acknowledge_alerts', 'usage_summary'],
  description: 'Monitor API credit balance and usage statistics',
  handler: async (params, content) => {
    const { action = 'check_balance' } = params;

    switch (action) {
      case 'check_balance':
        try {
          const currentBalance = await creditMonitor.getCurrentBalance();
          const usageStats = await creditMonitor.getUsageStats(7);
          const activeAlerts = await creditMonitor.getActiveAlerts();

          // Check if currentBalance is null
          if (!currentBalance) {
            throw new Error('Failed to retrieve current balance - API returned null. Check OpenRouter API credentials (OPENROUTER_API_KEY)');
          }

          // Get real-time cost monitor stats
          const realtimeStats = costMonitor.getStats();

          const status = {
            credits_remaining: currentBalance.credits_remaining,
            credits_used: currentBalance.credits_used,
            daily_spend: currentBalance.daily_spend,
            monthly_spend: currentBalance.monthly_spend,
            rate_limit_remaining: currentBalance.rate_limit_remaining,
            usage_stats: usageStats,
            active_alerts: activeAlerts.length,
            alert_messages: activeAlerts.map((alert) => alert.message),
          };

          let statusMessage = '💳 **Credit Status:**\n';

          if (currentBalance.credits_remaining !== undefined) {
            statusMessage +=
              '💰 Credits Remaining: $' + currentBalance.credits_remaining.toFixed(2) + '\n';
          }

          if (currentBalance.daily_spend !== undefined) {
            statusMessage += '📅 Daily Spend: $' + currentBalance.daily_spend.toFixed(2) + '\n';
          }

          if (currentBalance.monthly_spend !== undefined) {
            statusMessage += '📊 Monthly Spend: $' + currentBalance.monthly_spend.toFixed(2) + '\n';
          }

          if (usageStats.estimated_days_remaining > 0) {
            statusMessage +=
              '⏰ Estimated Days Remaining: ' + usageStats.estimated_days_remaining + '\n';
          }

          if (activeAlerts.length > 0) {
            statusMessage += '\n🚨 **Active Alerts:**\n';
            activeAlerts.slice(0, 3).forEach((alert) => {
              statusMessage += '- ' + alert.message + '\n';
            });
          }

          statusMessage += '\n📈 **Usage (Last 7 Days):**\n';
          statusMessage += '- Total Requests: ' + usageStats.requests_count + '\n';
          statusMessage += '- Total Spend: $' + usageStats.total_spend.toFixed(4) + '\n';
          statusMessage += '- Daily Average: $' + usageStats.daily_average.toFixed(4);

          // Add real-time session stats
          statusMessage += '\n\n⚡ **Current Session:**\n';
          statusMessage += '- API Calls: ' + realtimeStats.totalCalls + '\n';
          statusMessage += '- Tokens Used: ' + realtimeStats.totalTokens.toLocaleString() + '\n';
          statusMessage += '- Session Cost: $' + realtimeStats.estimatedCost.toFixed(4) + '\n';
          statusMessage += '- Burn Rate: $' + realtimeStats.costPerHour.toFixed(2) + '/hour\n';
          statusMessage +=
            '- Uptime: ' + (realtimeStats.uptime / (1000 * 60)).toFixed(1) + ' minutes';

          return JSON.stringify({
            success: true,
            data: status,
            message: statusMessage,
          });
        } catch (error) {
          logger.error('❌ Failed to check credit balance:', error);
          return JSON.stringify({
            success: false,
            error: 'Failed to retrieve credit information',
          });
        }

      case 'get_alerts':
        try {
          const activeAlerts = await creditMonitor.getActiveAlerts();

          if (activeAlerts.length === 0) {
            return JSON.stringify({
              success: true,
              data: [],
              message: '✅ No active credit alerts',
            });
          }

          let alertMessage = '🚨 **Active Credit Alerts (' + activeAlerts.length + '):**\n\n';

          activeAlerts.forEach((alert, index) => {
            const emoji = alert.severity === 'critical' ? '🔴' : '⚠️';
            alertMessage += emoji + ' **' + alert.alert_type.toUpperCase() + '**\n';
            alertMessage += '   ' + alert.message + '\n';
            if (alert.current_value !== undefined && alert.threshold_value !== undefined) {
              alertMessage +=
                '   Current: ' +
                alert.current_value +
                ' | Threshold: ' +
                alert.threshold_value +
                '\n';
            }
            alertMessage += '\n';
          });

          return JSON.stringify({
            success: true,
            data: activeAlerts,
            message: alertMessage,
          });
        } catch (error) {
          logger.error('❌ Failed to get credit alerts:', error);
          return JSON.stringify({
            success: false,
            error: 'Failed to retrieve credit alerts',
          });
        }

      case 'acknowledge_alerts':
        try {
          const alertType = params.alert_type || 'all';

          if (alertType === 'all') {
            const activeAlerts = await creditMonitor.getActiveAlerts();
            const alertTypes = [...new Set(activeAlerts.map((alert) => alert.alert_type))];

            for (const type of alertTypes) {
              await creditMonitor.acknowledgeAlerts(type);
            }

            return JSON.stringify({
              success: true,
              message: '✅ Acknowledged all active alerts (' + alertTypes.length + ' types)',
            });
          } else {
            await creditMonitor.acknowledgeAlerts(alertType);

            return JSON.stringify({
              success: true,
              message: '✅ Acknowledged all ' + alertType + ' alerts',
            });
          }
        } catch (error) {
          logger.error('❌ Failed to acknowledge alerts:', error);
          return JSON.stringify({
            success: false,
            error: 'Failed to acknowledge alerts',
          });
        }

      case 'usage_summary':
        try {
          const days = parseInt(params.days || '7');
          const usageStats = await creditMonitor.getUsageStats(days);

          let summary = '📊 **Usage Summary (Last ' + days + ' Days):**\n\n';
          summary += '💰 Total Spend: $' + usageStats.total_spend.toFixed(4) + '\n';
          summary += '📈 Daily Average: $' + usageStats.daily_average.toFixed(4) + '\n';
          summary += '🔄 Total Requests: ' + usageStats.requests_count + '\n';
          summary +=
            '⏰ Estimated Days Remaining: ' +
            (usageStats.estimated_days_remaining || 'Unknown') +
            '\n';

          if (usageStats.daily_average > 0) {
            const costPerRequest = usageStats.total_spend / usageStats.requests_count;
            summary += '💸 Average Cost per Request: $' + costPerRequest.toFixed(6);
          }

          return JSON.stringify({
            success: true,
            data: usageStats,
            message: summary,
          });
        } catch (error) {
          logger.error('❌ Failed to get usage summary:', error);
          return JSON.stringify({
            success: false,
            error: 'Failed to retrieve usage summary',
          });
        }

      default:
        throw new Error('Unsupported action: ' + action);
    }
  },
  examples: [
    '<capability name="credit_status" action="check_balance" />',
    '<capability name="credit_status" action="get_alerts" />',
    '<capability name="credit_status" action="acknowledge_alerts" alert_type="low_balance" />',
    '<capability name="credit_status" action="usage_summary" days="30" />',
  ],
};
