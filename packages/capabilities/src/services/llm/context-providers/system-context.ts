import { logger } from '@coachartie/shared';
import { estimateTokens } from '@coachartie/shared';
import { CreditMonitor } from '../../monitoring/credit-monitor.js';
import { distressMonitor } from '../../monitoring/distress-monitor.js';
import { ContextSource, DEBUG } from './types.js';

/**
 * Add credit/balance warnings so Artie knows to switch to cheaper models.
 */
export async function addCreditWarnings(sources: ContextSource[]): Promise<void> {
  try {
    const creditMonitor = CreditMonitor.getInstance();
    const [creditInfo, alerts] = await Promise.all([
      creditMonitor.getCurrentBalance(),
      creditMonitor.getActiveAlerts(),
    ]);

    // Build credit warning message if we have alerts or low balance
    const warningParts: string[] = [];

    // Add active alerts
    if (alerts.length > 0) {
      warningParts.push(...alerts.map((a) => a.message));
    }

    // Add balance info if available
    if (creditInfo?.credits_remaining !== undefined) {
      const balance = creditInfo.credits_remaining;

      // Critical warning (<$5)
      if (balance < 5) {
        warningParts.push(`🤖💸 "I'm faddddingggg..." - Only $${balance.toFixed(2)} credits left!`);
        warningParts.push(
          '⚡ SWITCH TO CHEAPER MODELS IMMEDIATELY (use Haiku/Gemini Flash for non-critical tasks)'
        );
      }
      // Warning (<$25)
      else if (balance < 25) {
        warningParts.push(`⚠️ Low credit balance: $${balance.toFixed(2)} remaining`);
        warningParts.push('💡 Consider using cheaper models for simple tasks');
      }
      // Info (just show balance if we have it)
      else {
        warningParts.push(`💰 Current balance: $${balance.toFixed(2)}`);
      }
    }

    // Add daily spend warning if high
    if (creditInfo?.daily_spend !== undefined && creditInfo.daily_spend > 10) {
      warningParts.push(`📊 Today's spend: $${creditInfo.daily_spend.toFixed(2)}`);
    }

    // Only add to context if we have warnings
    if (warningParts.length > 0) {
      const content = warningParts.join('\n');

      sources.push({
        name: 'credit_status',
        priority: 95, // Very high priority - Artie needs to know this!
        tokenWeight: estimateTokens(content),
        content,
        category: 'user_state',
      });

      if (DEBUG || (creditInfo?.credits_remaining && creditInfo.credits_remaining < 25)) {
        logger.warn(`💰 Credit warning added to context: ${warningParts[0]}`);
      }
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
