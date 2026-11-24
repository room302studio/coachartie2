/**
 * Discord Nickname Capability
 * Lets Artie change his own display name (nickname) in the current guild.
 */

import {
  RegisteredCapability,
  CapabilityContext,
} from '../registry.js';
import { logger } from '../../../shared/logger.js';
import * as gateway from '../../../gateway/api.js';

export const discordNicknameCapability: RegisteredCapability = {
  name: 'discord-nickname',
  emoji: '🏷️',
  actions: {
    set_nickname: { effect: 'discord' },
    reset_nickname: { effect: 'discord' },
  },
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
    '<capability name="discord-nickname" action="set_nickname" nickname="jan" guild_id="1420846272545296470" />',
    '<capability name="discord-nickname" action="reset_nickname" />',
  ],

  handler: async (params: any, _content: string | undefined, context?: CapabilityContext) => {
    const { action, nickname } = params;
    // guild_id param lets DM conversations target a server ("rename yourself in SB").
    const guildId = params.guild_id || params.guildId || context?.guildId;

    if (!guildId) {
      return JSON.stringify({
        success: false,
        error:
          'No guild in context — in DMs, pass guild_id="..." to say which server to rename yourself in (Subway Builder is 1420846272545296470)',
      });
    }

    if (action === 'set_nickname' && (!nickname || !String(nickname).trim())) {
      return JSON.stringify({ success: false, error: 'nickname param is required for set_nickname' });
    }

    try {
      // Gateway's POST /api/guilds/:id/nickname, in-process since wave 9
      let nicknameValue: string | null;
      if (action === 'reset_nickname') {
        nicknameValue = null;
      } else {
        nicknameValue = String(nickname).trim().slice(0, 32);
      }
      const response = await gateway.setNickname(String(guildId), {
        nickname: nicknameValue,
      });
      if (!gateway.isOk(response)) {
        return JSON.stringify({ success: false, error: JSON.stringify(response.body) });
      }
      const result = response.body as { nickname: string | null };
      logger.info(`[nickname] Set guild ${guildId} nickname to: ${result.nickname || '(default)'}`);
      let message: string;
      if (result.nickname) {
        message = `Your display name is now "${result.nickname}"`;
      } else {
        message = 'Your display name is back to default';
      }
      return JSON.stringify({
        success: true,
        message,
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
