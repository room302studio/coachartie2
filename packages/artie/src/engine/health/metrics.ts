/**
 * Prometheus Metrics Service for Coach Artie
 *
 * Exposes API costs, token usage, and operational metrics for Grafana dashboards.
 */

import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import { logger } from '@coachartie/shared';

// Create a custom registry
export const metricsRegistry = new Registry();

// Collect default Node.js metrics (memory, CPU, event loop, etc.)
collectDefaultMetrics({ register: metricsRegistry, prefix: 'artie_' });

// ============================================================================
// API COST METRICS
// ============================================================================

// Total cost counter (accumulates over time)
export const apiCostTotal = new Counter({
  name: 'artie_api_cost_dollars_total',
  help: 'Total API cost in dollars',
  labelNames: ['model', 'provider'],
  registers: [metricsRegistry],
});

// Cost per call histogram (for percentile analysis)
export const apiCostPerCall = new Histogram({
  name: 'artie_api_cost_per_call_dollars',
  help: 'API cost per call in dollars',
  labelNames: ['model', 'provider'],
  buckets: [0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0],
  registers: [metricsRegistry],
});

// ============================================================================
// TOKEN METRICS
// ============================================================================

export const tokensInputTotal = new Counter({
  name: 'artie_tokens_input_total',
  help: 'Total input tokens used',
  labelNames: ['model', 'provider'],
  registers: [metricsRegistry],
});

export const tokensOutputTotal = new Counter({
  name: 'artie_tokens_output_total',
  help: 'Total output tokens used',
  labelNames: ['model', 'provider'],
  registers: [metricsRegistry],
});

// ============================================================================
// API CALL METRICS
// ============================================================================

export const apiCallsTotal = new Counter({
  name: 'artie_api_calls_total',
  help: 'Total API calls made',
  labelNames: ['model', 'provider', 'status'],
  registers: [metricsRegistry],
});

export const apiCallDuration = new Histogram({
  name: 'artie_api_call_duration_seconds',
  help: 'API call duration in seconds',
  labelNames: ['model', 'provider'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

// ============================================================================
// MESSAGE METRICS
// ============================================================================

export const messagesProcessed = new Counter({
  name: 'artie_messages_processed_total',
  help: 'Total messages processed',
  labelNames: ['guild', 'type'],
  registers: [metricsRegistry],
});

export const responsesGenerated = new Counter({
  name: 'artie_responses_generated_total',
  help: 'Total responses generated',
  labelNames: ['guild', 'trigger'],
  registers: [metricsRegistry],
});

// ============================================================================
// CAPABILITY USAGE METRICS
// ============================================================================

export const capabilityUsageTotal = new Counter({
  name: 'artie_capability_usage_total',
  help: 'Total capability executions',
  labelNames: ['capability', 'action', 'guild', 'status'],
  registers: [metricsRegistry],
});

// ============================================================================
// DAILY COST GAUGE (resets at midnight)
// ============================================================================

export const dailyCostGauge = new Gauge({
  name: 'artie_daily_cost_dollars',
  help: 'Estimated cost today in dollars',
  labelNames: ['model'],
  registers: [metricsRegistry],
});

// Track daily costs in memory (resets on service restart)
const dailyCosts: Record<string, number> = {};
let lastResetDate = new Date().toDateString();

/**
 * Record an API call with cost tracking
 */
export function recordApiCall(params: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  durationMs?: number;
  success?: boolean;
}): void {
  const { model, inputTokens, outputTokens, cost, durationMs, success = true } = params;

  // Parse provider from model string (e.g., "openai/gpt-4o" -> "openai")
  const provider = model.includes('/') ? model.split('/')[0] : 'unknown';

  // Reset daily costs at midnight
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    Object.keys(dailyCosts).forEach((key) => delete dailyCosts[key]);
    lastResetDate = today;
    logger.info('📊 Daily cost metrics reset for new day');
  }

  // Update counters
  apiCostTotal.inc({ model, provider }, cost);
  apiCostPerCall.observe({ model, provider }, cost);
  tokensInputTotal.inc({ model, provider }, inputTokens);
  tokensOutputTotal.inc({ model, provider }, outputTokens);
  apiCallsTotal.inc({ model, provider, status: success ? 'success' : 'error' });

  if (durationMs) {
    apiCallDuration.observe({ model, provider }, durationMs / 1000);
  }

  // Update daily gauge
  dailyCosts[model] = (dailyCosts[model] || 0) + cost;
  dailyCostGauge.set({ model }, dailyCosts[model]);
}

/**
 * Record a message processed
 */
export function recordMessage(guild: string, type: 'discord' | 'sms' | 'api'): void {
  messagesProcessed.inc({ guild, type });
}

/**
 * Record a response generated
 */
export function recordResponse(
  guild: string,
  trigger: 'mention' | 'dm' | 'robot_channel' | 'proactive'
): void {
  responsesGenerated.inc({ guild, trigger });
}

/**
 * Record a capability execution
 */
export function recordCapabilityUsage(params: {
  capability: string;
  action: string;
  guild?: string;
  success: boolean;
}): void {
  const { capability, action, guild = 'unknown', success } = params;
  capabilityUsageTotal.inc({
    capability,
    action,
    guild,
    status: success ? 'success' : 'error',
  });
}

/**
 * Get metrics in Prometheus format
 */
export async function getMetrics(): Promise<string> {
  return metricsRegistry.metrics();
}

/**
 * Get content type for metrics endpoint
 */
export function getMetricsContentType(): string {
  return metricsRegistry.contentType;
}

logger.info('📊 Prometheus metrics service initialized');
