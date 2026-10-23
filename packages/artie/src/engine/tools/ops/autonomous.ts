/**
 * Autonomous Capability
 *
 * Unified interface for Artie's autonomous behaviors:
 * - Heartbeat status and configuration
 * - Model routing preferences
 * - Scheduled task management
 * - Daily summarization
 *
 * This is the control panel for Artie's proactive behavior.
 */

import { logger } from '@coachartie/shared';
import type {
  RegisteredCapability,
  CapabilityContext,
} from '../../services/capability/capability-registry.js';
import { heartbeatStatus } from '../../services/autonomous/heartbeat.js';
import { getRecentSummaries } from '../../services/autonomous/conversation-summarizer.js';
import { MODEL_TIERS, routeMessage } from '../../services/autonomous/model-router.js';

interface AutonomousParams {
  action: string;
  setting?: string;
  value?: string | boolean | number;
  [key: string]: unknown;
}

/**
 * Autonomous capability handler
 */
async function handleAutonomous(
  params: AutonomousParams,
  content?: string,
  ctx?: CapabilityContext
): Promise<string> {
  const { action } = params;
  const userId = ctx?.userId || 'unknown-user';

  logger.info(`Autonomous - Action: ${action}, UserId: ${userId}`);

  try {
    switch (action) {
      case 'status': {
        // Get overall autonomous system status
        const hbStatus = await heartbeatStatus();
        const summaries = getRecentSummaries(userId, 7);

        return `**Autonomous System Status**

**Heartbeat**
- Healthy: ${hbStatus.healthy ? 'Yes' : 'No'}
- Stalled Quests: ${hbStatus.stalledQuests}
- Stalled Goals: ${hbStatus.stalledGoals}
- Inactive Users: ${hbStatus.inactiveUsers}

**Your Activity**
- Daily Summaries (7 days): ${summaries.length}
- Recent Topics: ${summaries.flatMap(s => s.topics).slice(0, 5).join(', ') || 'None'}

**Scheduled Jobs**
- Heartbeat: Every hour at :30
- Daily Summarization: 6 AM UTC
- Memory Gardening: 5 AM UTC
- Daily Reflection: 4 AM UTC

Say "autonomous config" to customize these settings.`;
      }

      case 'heartbeat': {
        // Trigger heartbeat manually or get status
        const status = await heartbeatStatus();
        return `**Heartbeat Status**

- Healthy: ${status.healthy ? 'Yes' : 'No'}
- Stalled Quests: ${status.stalledQuests}
- Stalled Goals: ${status.stalledGoals}
- Inactive Users: ${status.inactiveUsers}

The heartbeat runs every hour and will:
1. Nudge you if quests are stalled for 24+ hours
2. Nudge you if goals are stalled for 3+ days
3. Deliver daily insights at 9 AM and 6 PM UTC`;
      }

      case 'summaries': {
        // Get recent conversation summaries
        const days = (params.days as number) || 7;
        const summaries = getRecentSummaries(userId, days);

        if (summaries.length === 0) {
          return `No conversation summaries found for the past ${days} days.`;
        }

        const summaryList = summaries.map(s => {
          return `**${s.date}** (${s.messageCount} messages, ${s.sentiment})
${s.summary}`;
        }).join('\n\n');

        return `**Your Conversation Summaries (${days} days)**\n\n${summaryList}`;
      }

      case 'models': {
        // Show model routing configuration
        const tiers = Object.entries(MODEL_TIERS).map(([tier, config]) => {
          return `**${tier.toUpperCase()}**: ${config.model}
   ${config.description}
   Max tokens: ${config.maxTokens}`;
        }).join('\n\n');

        return `**Model Routing Configuration**

Artie automatically selects the best model for each task:

${tiers}

This saves costs while maintaining quality. Complex tasks get Opus, simple lookups get Haiku.`;
      }

      case 'route': {
        // Test model routing for a message
        const testMessage = content || params.message as string || 'Hello, how are you?';
        const result = routeMessage(testMessage);

        return `**Model Routing Test**

Message: "${testMessage.slice(0, 100)}${testMessage.length > 100 ? '...' : ''}"

Selected: **${result.tier.toUpperCase()}** (${result.model})
${result.description}`;
      }

      case 'config': {
        // Show configuration options
        return `**Autonomous Configuration**

Control Artie's proactive behavior:

**Heartbeat Settings**
- HEARTBEAT_CRON: When to run (default: "30 * * * *")
- Nudges users with stalled quests
- Delivers daily insights at 9 AM and 6 PM

**Summarization Settings**
- SUMMARIZATION_CRON: When to summarize (default: "0 6 * * *")
- Creates daily memory summaries

**Model Routing**
- Automatic tier selection based on complexity
- Override with explicit model requests

These are configured via environment variables or can be adjusted per-user in the future.`;
      }

      case 'help':
      default: {
        return `**Autonomous System**

Artie runs proactive behaviors in the background:

**Commands:**
- \`autonomous status\` - Overall system health
- \`autonomous heartbeat\` - Heartbeat status
- \`autonomous summaries\` - Your conversation summaries
- \`autonomous models\` - Model routing config
- \`autonomous route [message]\` - Test model selection
- \`autonomous config\` - Configuration options

**What Runs Automatically:**
1. **Hourly Heartbeat** - Checks on stalled quests, nudges you
2. **Daily Summarization** - Creates memory from conversations
3. **Memory Gardening** - Links and prunes memories
4. **Daily Reflection** - Learns from feedback`;
      }
    }
  } catch (error) {
    logger.error('Autonomous error:', error);
    return `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

export const autonomousCapability: RegisteredCapability = {
  name: 'autonomous',
  emoji: '🤖',
  supportedActions: ['status', 'heartbeat', 'summaries', 'models', 'route', 'config', 'help'],
  description: `Control panel for Artie's autonomous behaviors. Actions:
- status: Overall autonomous system health
- heartbeat: Check heartbeat status (proactive nudges)
- summaries: View your daily conversation summaries
- models: See model routing configuration (Haiku/Sonnet/Opus)
- route: Test which model would be selected for a message
- config: View configuration options

Artie automatically: nudges stalled quests, creates daily memory summaries, routes to cost-effective models.`,
  handler: handleAutonomous,
};
