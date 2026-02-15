/**
 * Morning Briefing Capability
 *
 * Clawdbot-style daily intelligence briefing - compile and deliver
 * personalized morning summaries via DM.
 *
 * Usage:
 * - "set up morning briefing at 8am"
 * - "show my briefing now"
 * - "add weather to my briefing"
 * - "what's in my morning briefing?"
 */

import { logger } from '@coachartie/shared';
import type {
  RegisteredCapability,
  CapabilityContext,
} from '../../services/capability/capability-registry.js';
import { schedulerService } from '../../services/core/scheduler.js';

interface BriefingConfig {
  userId: string;
  enabled: boolean;
  cronTime: string; // e.g., "0 8 * * *" for 8 AM
  timezone: string;
  sections: BriefingSection[];
  deliveryChannel: 'discord' | 'sms' | 'both';
  lastDelivered?: string;
}

interface BriefingSection {
  type: 'weather' | 'calendar' | 'github' | 'trends' | 'tasks' | 'memories' | 'custom';
  enabled: boolean;
  config?: Record<string, unknown>;
}

interface MorningBriefingParams {
  action: string;
  time?: string; // "8am", "7:30", etc.
  timezone?: string;
  section?: string;
  channel?: 'discord' | 'sms' | 'both';
  [key: string]: unknown;
}

// In-memory config store (will be migrated to DB)
const briefingConfigs = new Map<string, BriefingConfig>();

// Default briefing sections
const DEFAULT_SECTIONS: BriefingSection[] = [
  { type: 'weather', enabled: true },
  { type: 'calendar', enabled: true },
  { type: 'tasks', enabled: true },
  { type: 'trends', enabled: true, config: { sources: ['github', 'hackernews'], limit: 3 } },
  { type: 'memories', enabled: true, config: { type: 'gems', limit: 2 } },
];

/**
 * Parse time string to cron format
 */
function parseTimeToCron(timeStr: string, timezone: string = 'America/New_York'): string {
  // Handle formats like "8am", "8:30am", "14:00", "2pm"
  const time = timeStr.toLowerCase().trim();

  let hour = 0;
  let minute = 0;

  // Match patterns
  const ampmMatch = time.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (ampmMatch) {
    hour = parseInt(ampmMatch[1]);
    minute = ampmMatch[2] ? parseInt(ampmMatch[2]) : 0;
    const period = ampmMatch[3];

    if (period === 'pm' && hour !== 12) hour += 12;
    if (period === 'am' && hour === 12) hour = 0;
  }

  // Cron: minute hour * * * (every day)
  return `${minute} ${hour} * * *`;
}

/**
 * Generate weather section
 */
async function generateWeatherSection(_userId: string): Promise<string> {
  // TODO: Integrate with weather API
  // For now, return placeholder
  return `**Weather**: Check your local forecast app for today's conditions.`;
}

/**
 * Generate calendar section
 */
async function generateCalendarSection(_userId: string): Promise<string> {
  // TODO: Integrate with calendar capability
  return `**Calendar**: No calendar integration configured yet.`;
}

/**
 * Generate tasks section - meshes quests, todos, and kanban
 */
async function generateTasksSection(userId: string): Promise<string> {
  const parts: string[] = [];

  // 1. Active quests (guided multi-step journeys)
  try {
    const { questsCapability } = await import('./quests.js');
    const questStatus = await questsCapability.handler(
      { action: 'status' },
      undefined,
      { userId }
    );

    if (!questStatus.includes('No active quests')) {
      parts.push(`**🎯 Active Quests**:\n${questStatus}`);
    }
  } catch {
    // Quest system unavailable, continue
  }

  // 2. Todo lists with pending items
  try {
    const { todoCapability } = await import('./todo.js');
    const todoStatus = await todoCapability.handler(
      { action: 'list', user_id: userId },
      undefined,
      { userId }
    );

    if (!todoStatus.includes('No todo lists found')) {
      // Extract just the summary lines
      const lines = todoStatus.split('\n').filter(l => l.includes('📋')).slice(0, 3);
      if (lines.length > 0) {
        parts.push(`**📋 Todo Lists**:\n${lines.join('\n')}`);
      }
    }
  } catch {
    // Todo system unavailable, continue
  }

  // 3. Kanban cards (cross-agent coordination)
  try {
    const { execSync } = await import('child_process');
    const result = execSync('~/scripts/kanban list Active 2>/dev/null || true', {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const cards = result.split('\n').filter(l => l.trim()).slice(0, 3);
    if (cards.length > 0) {
      parts.push(`**📌 Kanban (Active)**:\n${cards.join('\n')}`);
    }
  } catch {
    // Kanban unavailable, continue
  }

  if (parts.length === 0) {
    return `**Tasks**: No active work. Start a quest, create a todo list, or check kanban.`;
  }

  return parts.join('\n\n');
}

/**
 * Generate trends section
 */
async function generateTrendsSection(config?: Record<string, unknown>): Promise<string> {
  try {
    const { trendWatcherCapability } = await import('../research/trend-watcher.js');
    const limit = (config?.limit as number) || 3;

    const trends = await trendWatcherCapability.handler(
      { action: 'overview', limit },
      undefined,
      {}
    );

    // Truncate for briefing
    const lines = trends.split('\n').slice(0, 10);
    return lines.join('\n');
  } catch {
    return `**Trends**: Unable to fetch trends.`;
  }
}

/**
 * Generate memories/gems section
 */
async function generateMemoriesSection(userId: string, _config?: Record<string, unknown>): Promise<string> {
  try {
    // Use memory capability to recall recent important memories
    const { memoryCapability } = await import('../memory/memory.js');
    const recallResult = await memoryCapability.handler(
      { action: 'recall', query: 'important recent memories', limit: 2 },
      undefined,
      { userId }
    );

    if (!recallResult || recallResult.includes('No memories found')) {
      return `**Memory Gems**: No notable memories surfaced today.`;
    }

    // Truncate for briefing
    const lines = recallResult.split('\n').slice(0, 5);
    return `**Memory Gems**:\n${lines.join('\n')}`;
  } catch {
    return `**Memory Gems**: Memory system unavailable.`;
  }
}

/**
 * Generate full briefing
 */
async function generateBriefing(config: BriefingConfig): Promise<string> {
  const sections: string[] = [];
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  });

  sections.push(`**Good morning! Here's your briefing for ${dateStr}:**\n`);

  for (const section of config.sections) {
    if (!section.enabled) continue;

    try {
      switch (section.type) {
        case 'weather':
          sections.push(await generateWeatherSection(config.userId));
          break;
        case 'calendar':
          sections.push(await generateCalendarSection(config.userId));
          break;
        case 'tasks':
          sections.push(await generateTasksSection(config.userId));
          break;
        case 'trends':
          sections.push(await generateTrendsSection(section.config));
          break;
        case 'memories':
          sections.push(await generateMemoriesSection(config.userId, section.config));
          break;
      }
    } catch (error) {
      logger.error(`Failed to generate ${section.type} section:`, error);
    }
  }

  sections.push(`\n---\n*Briefing generated at ${now.toLocaleTimeString()}*`);

  return sections.join('\n\n');
}

/**
 * Morning briefing capability handler
 */
async function handleMorningBriefing(
  params: MorningBriefingParams,
  content?: string,
  ctx?: CapabilityContext
): Promise<string> {
  const { action } = params;
  const userId = ctx?.userId || 'unknown-user';

  logger.info(`Morning briefing - Action: ${action}, UserId: ${userId}`);

  try {
    switch (action) {
      case 'setup':
      case 'configure':
      case 'set': {
        const time = params.time || '8am';
        const timezone = params.timezone || 'America/New_York';
        const channel = params.channel || 'discord';

        const cronTime = parseTimeToCron(time, timezone);

        const config: BriefingConfig = {
          userId,
          enabled: true,
          cronTime,
          timezone,
          sections: [...DEFAULT_SECTIONS],
          deliveryChannel: channel,
        };

        briefingConfigs.set(userId, config);

        // Schedule the briefing
        const taskId = `morning-briefing-${userId}`;
        await schedulerService.scheduleTask({
          id: taskId,
          name: 'morning-briefing',
          cron: cronTime,
          data: {
            type: 'morning-briefing',
            userId,
            channel,
          },
          options: { timezone },
        });

        return `**Morning briefing configured!**

**Time**: ${time} (${timezone})
**Delivery**: ${channel}
**Sections**: Weather, Calendar, Tasks, Trends, Memory Gems

Your first briefing will arrive tomorrow. Say "show briefing now" to preview it.`;
      }

      case 'show':
      case 'preview':
      case 'now': {
        let config = briefingConfigs.get(userId);

        if (!config) {
          // Create temporary config for preview
          config = {
            userId,
            enabled: true,
            cronTime: '0 8 * * *',
            timezone: 'America/New_York',
            sections: [...DEFAULT_SECTIONS],
            deliveryChannel: 'discord',
          };
        }

        const briefing = await generateBriefing(config);
        return briefing;
      }

      case 'status':
      case 'config': {
        const config = briefingConfigs.get(userId);

        if (!config) {
          return `**Morning Briefing**: Not configured yet.

Set it up with: "set up morning briefing at 8am"`;
        }

        const enabledSections = config.sections
          .filter(s => s.enabled)
          .map(s => s.type)
          .join(', ');

        return `**Morning Briefing Status**

**Enabled**: ${config.enabled ? 'Yes' : 'No'}
**Time**: ${config.cronTime} (${config.timezone})
**Delivery**: ${config.deliveryChannel}
**Sections**: ${enabledSections}
**Last Delivered**: ${config.lastDelivered || 'Never'}`;
      }

      case 'enable': {
        const config = briefingConfigs.get(userId);
        if (!config) {
          return `No briefing configured. Use "set up morning briefing at 8am" first.`;
        }
        config.enabled = true;
        return `Morning briefing enabled.`;
      }

      case 'disable':
      case 'pause': {
        const config = briefingConfigs.get(userId);
        if (!config) {
          return `No briefing configured.`;
        }
        config.enabled = false;
        return `Morning briefing paused. Say "enable briefing" to resume.`;
      }

      case 'add': {
        const sectionType = params.section as BriefingSection['type'];
        if (!sectionType) {
          return `Please specify a section to add: weather, calendar, tasks, trends, memories`;
        }

        let config = briefingConfigs.get(userId);
        if (!config) {
          config = {
            userId,
            enabled: true,
            cronTime: '0 8 * * *',
            timezone: 'America/New_York',
            sections: [...DEFAULT_SECTIONS],
            deliveryChannel: 'discord',
          };
          briefingConfigs.set(userId, config);
        }

        const existing = config.sections.find(s => s.type === sectionType);
        if (existing) {
          existing.enabled = true;
          return `**${sectionType}** section enabled in your briefing.`;
        }

        config.sections.push({ type: sectionType, enabled: true });
        return `**${sectionType}** section added to your briefing.`;
      }

      case 'remove': {
        const sectionType = params.section as BriefingSection['type'];
        const config = briefingConfigs.get(userId);

        if (!config) {
          return `No briefing configured.`;
        }

        const section = config.sections.find(s => s.type === sectionType);
        if (section) {
          section.enabled = false;
          return `**${sectionType}** section removed from your briefing.`;
        }

        return `Section "${sectionType}" not found in your briefing.`;
      }

      default:
        return `Unknown briefing action: ${action}. Try: setup, show, status, enable, disable, add, remove`;
    }
  } catch (error) {
    logger.error('Morning briefing error:', error);
    return `Briefing error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

export const morningBriefingCapability: RegisteredCapability = {
  name: 'morning-briefing',
  emoji: '☀️',
  supportedActions: ['setup', 'configure', 'set', 'show', 'preview', 'now', 'status', 'config', 'enable', 'disable', 'pause', 'add', 'remove'],
  description: `Clawdbot-style daily intelligence briefing. Actions:
- setup/configure: Set up daily briefing (time, timezone, delivery channel)
- show/preview/now: Generate and show briefing immediately
- status/config: View current briefing configuration
- enable/disable: Turn briefing on or off
- add/remove: Add or remove sections (weather, calendar, tasks, trends, memories)

Example: "set up morning briefing at 8am" or "show my briefing now"`,
  handler: handleMorningBriefing,
};
