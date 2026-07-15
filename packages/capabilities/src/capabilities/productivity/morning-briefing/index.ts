import { logger } from '@coachartie/shared';
import type { RegisteredCapability, CapabilityContext } from '../../../services/capability/capability-registry.js';
import { schedulerService } from '../../../services/core/scheduler.js';
import { timeToCron } from './shared.js';
import { generateBriefing } from './assemble.js';
import type { BriefingParams, BriefingConfig } from './shared.js';
import { configs } from './shared.js';

async function handle(params: BriefingParams, _content?: string, ctx?: CapabilityContext): Promise<string> {
  const { action } = params;
  const userId = ctx?.userId || 'ej';
  logger.info(`Morning briefing - Action: ${action}, UserId: ${userId}`);

  try {
    switch (action) {
      case 'setup': case 'configure': case 'set': {
        const time = params.time || '8am', tz = params.timezone || 'America/New_York', ch = params.channel || 'discord';
        const cron = timeToCron(time);
        configs.set(userId, { userId, enabled: true, cronTime: cron, timezone: tz, deliveryChannel: ch });
        await schedulerService.scheduleTask({ id: 'owner-morning-briefing', name: 'morning-briefing', cron, data: { type: 'morning-briefing', userId, channel: ch }, options: { timezone: tz } });
        return `**Morning briefing configured!**\n\n**Time**: ${time} (${tz})\n**Delivery**: ${ch}\n**Content**: Weather, OSINT signals, tasks, latest briefing\n\nSay "show briefing now" to preview.`;
      }
      case 'show': case 'preview': case 'now':
        return await generateBriefing(configs.get(userId) || { userId, enabled: true, cronTime: '0 8 * * *', timezone: 'America/New_York', deliveryChannel: 'discord' });
      case 'status': case 'config': {
        const c = configs.get(userId);
        return c ? `**Morning Briefing Status**\n\n**Enabled**: ${c.enabled?'Yes':'No'}\n**Time**: ${c.cronTime} (${c.timezone})\n**Delivery**: ${c.deliveryChannel}\n**Last Delivered**: ${c.lastDelivered||'Never'}` : `**Morning Briefing**: Not configured yet.\n\nSet it up with: "set up morning briefing at 8am"`;
      }
      case 'enable': { const c=configs.get(userId); if (!c) return 'No briefing configured.'; c.enabled=true; return 'Morning briefing enabled.'; }
      case 'disable': case 'pause': { const c=configs.get(userId); if (!c) return 'No briefing configured.'; c.enabled=false; return 'Morning briefing paused.'; }
      default: return `Unknown action: ${action}. Try: setup, show, status, enable, disable`;
    }
  } catch (error) {
    logger.error('Morning briefing error:', error);
    return `Briefing error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

export const morningBriefingCapability: RegisteredCapability = {
  name: 'morning-briefing', emoji: '☀️',
  supportedActions: ['setup','configure','set','show','preview','now','status','config','enable','disable','pause'],
  description: 'Daily intelligence briefing with real OSINT data. Actions: setup, show, status, enable, disable',
  handler: handle,
};
