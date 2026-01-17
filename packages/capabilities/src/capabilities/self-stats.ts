import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';
import { metricsRegistry } from '../services/metrics.js';

/**
 * Self-Stats capability - Artie can check his own health and metrics
 *
 * Lets Artie introspect on:
 * - API costs and token usage
 * - Capability usage stats
 * - Memory/CPU usage
 * - Recent errors
 * - Service health
 */

interface SelfStatsParams {
  action: 'overview' | 'costs' | 'capabilities' | 'health' | 'errors';
  timeRange?: string; // e.g., '1h', '24h', '7d'
}

// Parse Prometheus metrics text format
function parsePrometheusMetrics(metricsText: string): Record<string, any> {
  const result: Record<string, any> = {};
  const lines = metricsText.split('\n');

  for (const line of lines) {
    if (line.startsWith('#') || !line.trim()) continue;

    // Parse metric line: metric_name{labels} value
    const match = line.match(/^([a-z_]+)(\{[^}]*\})?\s+(.+)$/);
    if (match) {
      const [, name, labels, value] = match;
      if (!result[name]) result[name] = [];
      result[name].push({
        labels: labels || '',
        value: parseFloat(value),
      });
    }
  }

  return result;
}

// Format bytes to human readable
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Format duration
function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  return `${hours}h ${minutes}m`;
}

export const selfStatsCapability: RegisteredCapability = {
  name: 'self-stats',
  emoji: '📊',
  supportedActions: ['overview', 'costs', 'capabilities', 'health', 'errors'],
  description: `Check your own stats, health, and metrics. Use this to understand how you're doing.

Actions:
- overview: Quick summary of everything
- costs: API costs and token usage today
- capabilities: Which capabilities you've used most
- health: Memory, CPU, uptime
- errors: Recent errors (if any)

Use this when you want to reflect on your performance or check if something's wrong.`,
  requiredParams: [],
  examples: [
    '<capability name="self-stats" action="overview" />',
    '<capability name="self-stats" action="costs" />',
    '<capability name="self-stats" action="capabilities" />',
    '<capability name="self-stats" action="health" />',
  ],

  handler: async (params: any) => {
    const { action = 'overview' } = params as SelfStatsParams;

    logger.info(`📊 Self-stats: ${action}`);

    try {
      const metricsText = await metricsRegistry.metrics();
      const metrics = parsePrometheusMetrics(metricsText);

      switch (action) {
        case 'overview': {
          const lines: string[] = ['## Artie Self-Stats Overview\n'];

          // Memory (metrics have artie_ prefix)
          const heapUsed = metrics['artie_nodejs_heap_size_used_bytes']?.[0]?.value;
          const heapTotal = metrics['artie_nodejs_heap_size_total_bytes']?.[0]?.value;
          if (heapUsed && heapTotal) {
            lines.push(`**Memory:** ${formatBytes(heapUsed)} / ${formatBytes(heapTotal)} heap`);
          }

          // Uptime
          const uptime = metrics['artie_process_start_time_seconds']?.[0]?.value;
          if (uptime) {
            const uptimeSeconds = Date.now() / 1000 - uptime;
            lines.push(`**Uptime:** ${formatUptime(uptimeSeconds)}`);
          }

          // API Costs today
          const dailyCosts = metrics['artie_daily_cost_dollars'] || [];
          const totalDailyCost = dailyCosts.reduce((sum: number, m: any) => sum + m.value, 0);
          lines.push(`**Today's API Cost:** $${totalDailyCost.toFixed(4)}`);

          // Total API calls
          const apiCalls = metrics['artie_api_calls_total'] || [];
          const totalCalls = apiCalls.reduce((sum: number, m: any) => sum + m.value, 0);
          lines.push(`**API Calls:** ${totalCalls}`);

          // Capability usage
          const capUsage = metrics['artie_capability_usage_total'] || [];
          const totalCapCalls = capUsage.reduce((sum: number, m: any) => sum + m.value, 0);
          lines.push(`**Capability Executions:** ${totalCapCalls}`);

          // Messages processed
          const messages = metrics['artie_messages_processed_total'] || [];
          const totalMessages = messages.reduce((sum: number, m: any) => sum + m.value, 0);
          lines.push(`**Messages Processed:** ${totalMessages}`);

          return lines.join('\n');
        }

        case 'costs': {
          const lines: string[] = ['## API Costs & Token Usage\n'];

          // Daily costs by model
          const dailyCosts = metrics['artie_daily_cost_dollars'] || [];
          if (dailyCosts.length > 0) {
            lines.push('**Today by Model:**');
            for (const m of dailyCosts) {
              const model = m.labels.match(/model="([^"]+)"/)?.[1] || 'unknown';
              lines.push(`- ${model}: $${m.value.toFixed(4)}`);
            }
            const total = dailyCosts.reduce((sum: number, m: any) => sum + m.value, 0);
            lines.push(`\n**Total Today:** $${total.toFixed(4)}`);
          } else {
            lines.push('No API costs recorded yet today.');
          }

          // Token usage
          const inputTokens = metrics['artie_tokens_input_total'] || [];
          const outputTokens = metrics['artie_tokens_output_total'] || [];
          const totalInput = inputTokens.reduce((sum: number, m: any) => sum + m.value, 0);
          const totalOutput = outputTokens.reduce((sum: number, m: any) => sum + m.value, 0);
          lines.push(`\n**Tokens Used:**`);
          lines.push(`- Input: ${totalInput.toLocaleString()}`);
          lines.push(`- Output: ${totalOutput.toLocaleString()}`);
          lines.push(`- Total: ${(totalInput + totalOutput).toLocaleString()}`);

          return lines.join('\n');
        }

        case 'capabilities': {
          const lines: string[] = ['## Capability Usage\n'];

          const capUsage = metrics['artie_capability_usage_total'] || [];
          if (capUsage.length === 0) {
            return 'No capability usage recorded yet since last restart.';
          }

          // Group by capability
          const byCapability: Record<string, { success: number; error: number }> = {};
          for (const m of capUsage) {
            const cap = m.labels.match(/capability="([^"]+)"/)?.[1] || 'unknown';
            const status = m.labels.match(/status="([^"]+)"/)?.[1] || 'unknown';
            if (!byCapability[cap]) byCapability[cap] = { success: 0, error: 0 };
            if (status === 'success') byCapability[cap].success += m.value;
            else byCapability[cap].error += m.value;
          }

          // Sort by total usage
          const sorted = Object.entries(byCapability)
            .map(([name, stats]) => ({ name, ...stats, total: stats.success + stats.error }))
            .sort((a, b) => b.total - a.total);

          lines.push('**Most Used:**');
          for (const cap of sorted.slice(0, 10)) {
            const errorRate = cap.total > 0 ? ((cap.error / cap.total) * 100).toFixed(0) : '0';
            const errorNote = cap.error > 0 ? ` (${errorRate}% errors)` : '';
            lines.push(`- ${cap.name}: ${cap.total}${errorNote}`);
          }

          return lines.join('\n');
        }

        case 'health': {
          const lines: string[] = ['## System Health\n'];

          // Memory details (metrics have artie_ prefix)
          const heapUsed = metrics['artie_nodejs_heap_size_used_bytes']?.[0]?.value;
          const heapTotal = metrics['artie_nodejs_heap_size_total_bytes']?.[0]?.value;
          const external = metrics['artie_nodejs_external_memory_bytes']?.[0]?.value;
          const rss = metrics['artie_process_resident_memory_bytes']?.[0]?.value;

          lines.push('**Memory:**');
          if (heapUsed) lines.push(`- Heap Used: ${formatBytes(heapUsed)}`);
          if (heapTotal) lines.push(`- Heap Total: ${formatBytes(heapTotal)}`);
          if (external) lines.push(`- External: ${formatBytes(external)}`);
          if (rss) lines.push(`- RSS: ${formatBytes(rss)}`);

          // Uptime
          const uptime = metrics['artie_process_start_time_seconds']?.[0]?.value;
          if (uptime) {
            const uptimeSeconds = Date.now() / 1000 - uptime;
            lines.push(`\n**Uptime:** ${formatUptime(uptimeSeconds)}`);
          }

          // Event loop lag
          const eventLoopLag = metrics['artie_nodejs_eventloop_lag_seconds']?.[0]?.value;
          if (eventLoopLag !== undefined) {
            const lagMs = eventLoopLag * 1000;
            const status = lagMs < 100 ? '✅' : lagMs < 500 ? '⚠️' : '🔴';
            lines.push(`\n**Event Loop Lag:** ${lagMs.toFixed(1)}ms ${status}`);
          }

          // Active handles/requests
          const activeHandles = metrics['artie_nodejs_active_handles_total']?.[0]?.value;
          const activeRequests = metrics['artie_nodejs_active_requests_total']?.[0]?.value;
          if (activeHandles !== undefined) {
            lines.push(`\n**Active Handles:** ${activeHandles}`);
          }
          if (activeRequests !== undefined) {
            lines.push(`**Active Requests:** ${activeRequests}`);
          }

          return lines.join('\n');
        }

        case 'errors': {
          const lines: string[] = ['## Recent Errors\n'];

          // Check for failed API calls
          const apiCalls = metrics['artie_api_calls_total'] || [];
          const errorCalls = apiCalls.filter((m: any) => m.labels.includes('status="error"'));
          const totalErrors = errorCalls.reduce((sum: number, m: any) => sum + m.value, 0);

          if (totalErrors > 0) {
            lines.push(`**API Errors:** ${totalErrors}`);
            for (const m of errorCalls) {
              const model = m.labels.match(/model="([^"]+)"/)?.[1] || 'unknown';
              lines.push(`- ${model}: ${m.value} errors`);
            }
          }

          // Check capability errors
          const capUsage = metrics['artie_capability_usage_total'] || [];
          const capErrors = capUsage.filter((m: any) => m.labels.includes('status="error"'));
          const totalCapErrors = capErrors.reduce((sum: number, m: any) => sum + m.value, 0);

          if (totalCapErrors > 0) {
            lines.push(`\n**Capability Errors:** ${totalCapErrors}`);
            for (const m of capErrors) {
              const cap = m.labels.match(/capability="([^"]+)"/)?.[1] || 'unknown';
              lines.push(`- ${cap}: ${m.value} errors`);
            }
          }

          if (totalErrors === 0 && totalCapErrors === 0) {
            lines.push('No errors recorded since last restart. 🎉');
          }

          return lines.join('\n');
        }

        default:
          return `Unknown action: ${action}. Use: overview, costs, capabilities, health, errors`;
      }
    } catch (error: any) {
      logger.error('Self-stats error:', error);
      return `Error checking stats: ${error.message}`;
    }
  },
};
