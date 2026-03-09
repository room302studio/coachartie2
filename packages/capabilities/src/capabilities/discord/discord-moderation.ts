/**
 * Discord Moderation Capability
 * Allows Artie to timeout users, add roles, and escalate to humans
 */

import {
  RegisteredCapability,
  CapabilityContext,
} from '../../services/capability/capability-registry.js';
import { logger } from '@coachartie/shared';

const ARTIE_ENEMY_ROLE_NAME = 'artie-enemy';
const DISCORD_SERVICE_URL = process.env.DISCORD_SERVICE_URL || 'http://localhost:47321';

export const discordModerationCapability: RegisteredCapability = {
  name: 'discord-moderation',
  emoji: '🛡️',
  supportedActions: ['timeout', 'add_enemy_role', 'remove_enemy_role', 'escalate'],
  description:
    'Moderate Discord users - timeout troublemakers, mark enemies, escalate to humans. ' +
    'Use timeout for disruptive users (1-60 min). Use add_enemy_role for persistent jerks. ' +
    'Use escalate when you need human backup.',
  requiredParams: [],
  examples: [
    '<capability name="discord-moderation" action="timeout" userId="123" durationMinutes="5" reason="being hostile" />',
    '<capability name="discord-moderation" action="add_enemy_role" userId="123" reason="persistent troll" />',
    '<capability name="discord-moderation" action="escalate" reason="need mod help with this user" />',
  ],

  handler: async (params: any, _content: string | undefined, context?: CapabilityContext) => {
    const { action, userId, durationMinutes, reason } = params;
    const guildId = context?.guildId;

    switch (action) {
      case 'timeout':
        if (!guildId || !userId || !durationMinutes || !reason) {
          return JSON.stringify({
            success: false,
            error: 'Missing required: guildId, userId, durationMinutes, reason',
          });
        }
        try {
          const response = await fetch(`${DISCORD_SERVICE_URL}/api/moderation/timeout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              guildId,
              userId,
              durationMinutes: Math.min(60, Math.max(1, durationMinutes)),
              reason,
            }),
          });
          if (!response.ok) {
            return JSON.stringify({ success: false, error: await response.text() });
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
        if (!guildId || !userId || !reason) {
          return JSON.stringify({
            success: false,
            error: 'Missing required: guildId, userId, reason',
          });
        }
        try {
          const response = await fetch(`${DISCORD_SERVICE_URL}/api/moderation/add-role`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ guildId, userId, roleName: ARTIE_ENEMY_ROLE_NAME, reason }),
          });
          if (!response.ok) {
            return JSON.stringify({ success: false, error: await response.text() });
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
        if (!guildId || !userId) {
          return JSON.stringify({ success: false, error: 'Missing required: guildId, userId' });
        }
        try {
          const response = await fetch(`${DISCORD_SERVICE_URL}/api/moderation/remove-role`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ guildId, userId, roleName: ARTIE_ENEMY_ROLE_NAME }),
          });
          if (!response.ok) {
            return JSON.stringify({ success: false, error: await response.text() });
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

export default discordModerationCapability;
