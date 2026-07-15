import { logger } from '@coachartie/shared';
import { estimateTokens } from '@coachartie/shared';
import { CreditMonitor } from '../../monitoring/credit-monitor.js';
import { distressMonitor } from '../../monitoring/distress-monitor.js';
import { ContextSource } from './types.js';

/**
 * Add credit/balance warnings so Artie knows to switch to cheaper models.
 */
export async function addCreditWarnings(sources: ContextSource[]): Promise<void> {
  try {
    const creditMonitor = CreditMonitor.getInstance();
    const creditInfo = await creditMonitor.getCurrentBalance();

    // Credit awareness is CRITICAL-ONLY by design. Injecting balance/burn into
    // Artie's context every turn made him fixate on money and read his whole
    // setup as intrusive ("$X hovering in my context is like taping your bank
    // balance to your forehead") — A/B tested: with the warning ~75% of reflective
    // replies flagged the setup as intrusive; without it, 0%. So above the
    // critical floor, cost is the system's job (logs + model selection), NOT
    // something Artie has to carry. He only hears about it when he must act.
    const balance = creditInfo?.credits_remaining;
    const CRITICAL_BALANCE = parseFloat(process.env.CREDIT_CRITICAL_BALANCE || '5');

    if (typeof balance === 'number' && balance < CRITICAL_BALANCE) {
      const content = `⚠️ Credits are critically low ($${balance.toFixed(2)} left). Prefer cheaper models (Haiku/Flash) for non-critical work until topped up.`;
      sources.push({
        name: 'credit_status',
        priority: 95,
        tokenWeight: estimateTokens(content),
        content,
        category: 'user_state',
      });
      logger.warn(`💰 Critical credit warning injected into context: $${balance.toFixed(2)}`);
    } else if (typeof balance === 'number') {
      // Not critical — keep it out of his head; log only for observability.
      logger.info(
        `💰 Balance $${balance.toFixed(2)} — not injected (above $${CRITICAL_BALANCE} critical floor)`
      );
    }
  } catch (error) {
    logger.warn('Failed to add credit warnings:', error);
    // Graceful degradation - continue without credit warnings
  }
}

/**
 * Add current date/time to message context (compressed format to save tokens).
 */
export async function addCurrentDateTime(sources: ContextSource[]): Promise<void> {
  const now = new Date();
  // Compressed format: saves ~14 tokens vs verbose format
  const dayName = now.toLocaleDateString('en-US', { weekday: 'short' });
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const tzMatch = now.toLocaleTimeString('en-US', { timeZoneName: 'short' }).match(/\b[A-Z]{3,4}\b/);
  const tz = tzMatch ? tzMatch[0] : 'UTC';

  // Format: "Date: 2025-10-24 13:40 EST (Fri)"
  const content = `Date: ${now.toISOString().split('T')[0]} ${timeStr} ${tz} (${dayName})`;

  sources.push({
    name: 'temporal_context',
    priority: 100, // Always highest priority
    tokenWeight: estimateTokens(content),
    content,
    category: 'temporal',
  });
}

/**
 * Add a self-awareness note when the distress monitor flags Artie is stressed.
 */
export async function addSelfAwareness(sources: ContextSource[]): Promise<void> {
  try {
    const note = await distressMonitor.getSelfAwarenessNote();

    if (note) {
      const content = `[Self-awareness: ${note}]`;

      sources.push({
        name: 'self_awareness',
        priority: 85, // High priority when Artie is stressed
        tokenWeight: estimateTokens(content),
        content,
        category: 'system',
      });
    }
  } catch (error) {
    logger.debug('Failed to add self-awareness:', error);
    // Graceful degradation - continue without self-awareness
  }
}
