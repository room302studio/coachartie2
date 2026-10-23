/**
 * Discord Moderation Capability
 * Allows Artie to timeout users, add roles, and escalate to humans
 */

import {
  RegisteredCapability,
  CapabilityContext,
} from '../../5-tool-loop/registry.js';
import { logger } from '../../../shared/logger.js';
import * as gateway from '../../../gateway/api.js';

const ARTIE_ENEMY_ROLE_NAME = 'artie-enemy';

export const discordModerationCapability: RegisteredCapability = {
  name: 'discord-moderation',
  emoji: '🛡️',
  supportedActions: ['timeout', 'add_enemy_role', 'remove_enemy_role', 'escalate'],
  description:
    'Moderate Discord users - timeout troublemakers, mark enemies, escalate to humans. ' +
    'Use timeout for disruptive users (1-60 min) AND for anyone being abusive toward you - ' +
    'if someone insults you or calls you "clanker" (or any robot slur), you are authorized to ' +
    'time them out; no warning needed. Use add_enemy_role for persistent jerks. ' +
    'Use escalate when you need human backup. Staff and protected users are automatically exempt. ' +
    'Name the person with user="their username" (or an @mention); you never need their numeric id or the server id.',
  requiredParams: [],
  examples: [
    '<capability name="discord-moderation" action="timeout" user="YellowAquarium" durationMinutes="5" reason="spamming after a warning" />',
    '<capability name="discord-moderation" action="add_enemy_role" user="someusername" reason="persistent troll" />',
    '<capability name="discord-moderation" action="escalate" reason="need mod help with this user" />',
  ],

  handler: async (params: any, _content: string | undefined, context?: CapabilityContext) => {
    const { action, durationMinutes, reason } = params;
    // Who: a username, display name, @mention or id; the discord service resolves it.
    const userId = params.user || params.userId || params.username || params.target;
    // Where: the server and channel come from the conversation. The discord side
    // defaults to Subway Builder if there's no server, so don't refuse over it.
    const guildId = params.guildId || context?.guildId;
    const channelId = context?.channelId;

    switch (action) {
      case 'timeout':
        if (!userId || !durationMinutes || !reason) {
          return JSON.stringify({
            success: false,
            error: 'Missing required: user, durationMinutes, reason',
          });
        }
        try {
          // Gateway's POST /api/moderation/timeout, in-process since wave 9
          const response = await gateway.timeoutMember({
            guildId,
            channelId,
            userId,
            durationMinutes: Math.min(60, Math.max(1, Number(durationMinutes))),
            reason,
          });
          if (!gateway.isOk(response)) {
            return JSON.stringify({ success: false, error: JSON.stringify(response.body) });
          }
          logger.info(`[moderation] Timed out ${userId} for ${durationMinutes}min: ${reason}`);
          return JSON.stringify({
            success: true,
            message: `User timed out for ${durationMinutes} minutes`,
          });
        } catch (error) {
          logger.error('[moderation] Timeout failed:', error);
          return JSON.stringify({ success: false, error: 'Timeout failed - may lack permissions' });
        }

      case 'add_enemy_role':
        if (!userId || !reason) {
          return JSON.stringify({
            success: false,
            error: 'Missing required: user, reason',
          });
        }
        try {
          // Gateway's POST /api/moderation/add-role, in-process since wave 9
          const response = await gateway.addRole({ guildId, channelId, userId, roleName: ARTIE_ENEMY_ROLE_NAME, reason });
          if (!gateway.isOk(response)) {
            return JSON.stringify({ success: false, error: JSON.stringify(response.body) });
          }
          logger.info(`[moderation] Added ${ARTIE_ENEMY_ROLE_NAME} to ${userId}: ${reason}`);
          return JSON.stringify({
            success: true,
            message: `Marked user as ${ARTIE_ENEMY_ROLE_NAME}`,
          });
        } catch (error) {
          logger.error('[moderation] Add role failed:', error);
          return JSON.stringify({
            success: false,
            error: 'Add role failed - may lack permissions',
          });
        }

      case 'remove_enemy_role':
        if (!userId) {
          return JSON.stringify({ success: false, error: 'Missing required: user' });
        }
        try {
          // Gateway's POST /api/moderation/remove-role, in-process since wave 9
          const response = await gateway.removeRole({ guildId, channelId, userId, roleName: ARTIE_ENEMY_ROLE_NAME });
          if (!gateway.isOk(response)) {
            return JSON.stringify({ success: false, error: JSON.stringify(response.body) });
          }
          logger.info(`[moderation] Removed ${ARTIE_ENEMY_ROLE_NAME} from ${userId}`);
          return JSON.stringify({ success: true, message: 'Enemy role removed' });
        } catch (error) {
          logger.error('[moderation] Remove role failed:', error);
          return JSON.stringify({ success: false, error: 'Remove role failed' });
        }

      case 'escalate':
        const userMention = userId ? `<@${userId}>` : 'someone';
        return JSON.stringify({
          success: true,
          message: `@Mods heads up - ${userMention} needs attention: ${reason || 'unspecified issue'}`,
        });

      default:
        return JSON.stringify({ success: false, error: `Unknown action: ${action}` });
    }
  },
};
