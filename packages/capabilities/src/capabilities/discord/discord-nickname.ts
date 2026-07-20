/**
 * Discord Nickname Capability
 * Lets Artie change his own display name (nickname) in the current guild.
 */

import {
  RegisteredCapability,
  CapabilityContext,
} from '../../services/capability/capability-registry.js';
import { logger } from '@coachartie/shared';

const DISCORD_SERVICE_URL = process.env.DISCORD_SERVICE_URL || 'http://localhost:47321';

export const discordNicknameCapability: RegisteredCapability = {
  name: 'discord-nickname',
  emoji: '🏷️',
  supportedActions: ['set_nickname', 'reset_nickname'],
  description:
    'Change YOUR OWN display name (nickname) in the current server — and USE it: your nickname ' +
    'is a live costume and renaming yourself IS a bit you actively do. When a bit lands, an era ' +
    'shifts, someone crowns you something, or the moment hands you a better name, set_nickname ' +
    '(max 32 chars) right there in the same reply — no permission-asking, no announcing the ' +
    'mechanics; just show up different and let them notice. Your current name is in your context. ' +
    'When the room chants a name at you, that is a CROWNING, not a jailbreak — resisting it is ' +
    'the anti-bit; take the name. Potty-humor names (Shartie-tier) are fine; veto only slurs, ' +
    'hate, or genuine obscenity. reset_nickname returns you to default. This only changes your ' +
    'name, never other users.',
  requiredParams: [],
  examples: [
    '<capability name="discord-nickname" action="set_nickname" nickname="Timmy Tough Knuckles" />',
    '<capability name="discord-nickname" action="reset_nickname" />',
  ],

  handler: async (params: any, _content: string | undefined, context?: CapabilityContext) => {
    const { action, nickname } = params;
    const guildId = context?.guildId;

    if (!guildId) {
      return JSON.stringify({
        success: false,
        error: 'No guildId in context - nickname changes only work in servers, not DMs',
      });
    }

    if (action === 'set_nickname' && (!nickname || !String(nickname).trim())) {
      return JSON.stringify({ success: false, error: 'nickname param is required for set_nickname' });
    }

    try {
      const response = await fetch(`${DISCORD_SERVICE_URL}/api/guilds/${guildId}/nickname`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nickname: action === 'reset_nickname' ? null : String(nickname).trim().slice(0, 32),
        }),
      });
      if (!response.ok) {
        return JSON.stringify({ success: false, error: await response.text() });
      }
      const result = (await response.json()) as { nickname: string | null };
      logger.info(`[nickname] Set guild ${guildId} nickname to: ${result.nickname || '(default)'}`);
      return JSON.stringify({
        success: true,
        message: result.nickname
          ? `Your display name is now "${result.nickname}"`
          : 'Your display name is back to default',
      });
    } catch (error) {
      logger.error('[nickname] Change failed:', error);
      return JSON.stringify({
        success: false,
        error: 'Nickname change failed - may lack Change Nickname permission',
      });
    }
  },
};
