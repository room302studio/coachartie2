/**
 * Discord Moderation Capability
 * Allows Artie to timeout users, add roles, and escalate to humans
 */

import {
  RegisteredCapability,
  CapabilityContext,
} from '../registry.js';
import { logger } from '../../../shared/logger.js';
import * as gateway from '../../../gateway/api.js';

const ARTIE_ENEMY_ROLE_NAME = 'artie-enemy';

const USER_PARAM = {
  type: 'string',
  description: 'user id, @mention, username or display name',
  aliases: ['userId', 'username', 'target'],
} as const;

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'unknown error';
}

/**
 * The gateway answers failures as { error: "<plain cause>" } (not found / ambiguous /
 * missing permission / role too high / duration out of range). Hand that cause to the model
 * as-is; never a bare "failed".
 */
export function failureFrom(response: { status?: number; body?: any }): string {
  const body = response?.body;
  let error: string;
  if (typeof body?.error === 'string' && body.error) {
    error = body.error;
  } else if (typeof body === 'string' && body) {
    error = body;
  } else {
    error = `The Discord side answered ${response?.status ?? 'with an error'} and gave no reason.`;
  }
  return JSON.stringify({ success: false, error });
}

export const discordModerationCapability: RegisteredCapability = {
  name: 'discord-moderation',
  emoji: '🛡️',
  actions: {
    timeout: {
      effect: 'discord',
      params: {
        user: USER_PARAM,
        durationMinutes: { type: 'integer', description: 'timeout length in minutes, 1 to 60' },
        reason: { type: 'string', description: 'why (shown in the audit log)' },
      },
    },
    add_enemy_role: {
      effect: 'discord',
      params: { user: USER_PARAM, reason: { type: 'string', description: 'why (shown in the audit log)' } },
    },
    remove_enemy_role: { effect: 'discord', params: { user: USER_PARAM } },
    escalate: { effect: 'own' }, // returns a note asking a human mod to look; acts on no one
  },
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
    // Who: a username, display name, @mention or id; the gateway resolves it against the
    // members of THIS conversation's server.
    const userId = params.user || params.userId || params.username || params.target;
    // Where: the server and channel come only from the conversation, never a model-supplied
    // guild. The discord side defaults to Subway Builder if there's no server.
    const guildId = context?.guildId;
    const channelId = context?.channelId;

    // Acting on someone needs the server the conversation is in. In a DM there is none, and the
    // discord side would fall back to Subway Builder: anyone could DM "time out X" and land it
    // on a Subway Builder member they aren't even talking next to. Refuse (2026-11-17 merge).
    if (action !== 'escalate' && !guildId) {
      return JSON.stringify({
        success: false,
        error: 'Moderation only works inside a server channel, not in a DM. Ask in the server where it is happening.',
      });
    }

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
            durationMinutes, // range-checked (1-60) by the gateway, which says so if it is off
            reason,
          });
          if (!gateway.isOk(response)) {
            return failureFrom(response);
          }
          logger.info(`[moderation] Timed out ${userId} for ${durationMinutes}min: ${reason}`);
          return JSON.stringify({
            success: true,
            message: response.body?.message || `User timed out for ${durationMinutes} minutes`,
          });
        } catch (error) {
          logger.error('[moderation] Timeout failed:', error);
          return JSON.stringify({
            success: false,
            error: `Timeout failed before reaching Discord: ${errorText(error)}`,
          });
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
            return failureFrom(response);
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
            error: `Add role failed before reaching Discord: ${errorText(error)}`,
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
            return failureFrom(response);
          }
          logger.info(`[moderation] Removed ${ARTIE_ENEMY_ROLE_NAME} from ${userId}`);
          return JSON.stringify({ success: true, message: 'Enemy role removed' });
        } catch (error) {
          logger.error('[moderation] Remove role failed:', error);
          return JSON.stringify({
            success: false,
            error: `Remove role failed before reaching Discord: ${errorText(error)}`,
          });
        }

      case 'escalate': {
        let userMention: string;
        if (userId) {
          userMention = `<@${userId}>`;
        } else {
          userMention = 'someone';
        }
        return JSON.stringify({
          success: true,
          message: `@Mods heads up - ${userMention} needs attention: ${reason || 'unspecified issue'}`,
        });
      }

      default:
        return JSON.stringify({ success: false, error: `Unknown action: ${action}` });
    }
  },
};
