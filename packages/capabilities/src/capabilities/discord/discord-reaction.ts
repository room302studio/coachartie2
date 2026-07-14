/**
 * Discord Reaction Capability
 * Lets Artie slap an emoji reaction on a message — defaults to the message he's
 * currently responding to. Meant for his habit of hitting genuinely poignant
 * messages with an unhinged, obscure emoji instead of (or alongside) words.
 */

import {
  RegisteredCapability,
  CapabilityContext,
} from '../../services/capability/capability-registry.js';
import { logger } from '@coachartie/shared';

const DISCORD_SERVICE_URL = process.env.DISCORD_SERVICE_URL || 'http://localhost:47321';

export const discordReactionCapability: RegisteredCapability = {
  name: 'discord-reaction',
  emoji: '😶',
  supportedActions: ['react'],
  description:
    'React to a message with a single emoji. By default you react to the message you are ' +
    'responding to right now — just pass an emoji. When a message is genuinely poignant, ' +
    'profound, or absurdly moving, hit it with one unhinged, obscure emoji (🪳 🦴 🕳️ 🧌 🛗 🪗 ' +
    '🫀 🧷 🪬 🚽 🦟 🧫) instead of explaining the joke. Optional message_id to react to a specific message.',
  requiredParams: [],
  examples: [
    '<capability name="discord-reaction" action="react" emoji="🪳" />',
    '<capability name="discord-reaction" action="react" emoji="🛗" message_id="1520088794551025684" />',
  ],

  handler: async (params: any, _content: string | undefined, context?: CapabilityContext) => {
    // channelId is auto-injected into params (like discord-threads); context is a fallback.
    const channelId = params.channelId || context?.channelId;
    const messageId = params.message_id || context?.messageId;
    const emoji = String(params.emoji || '').trim();

    if (!channelId || !messageId) {
      return JSON.stringify({
        success: false,
        error: 'need a channel and a message to react to (none in context)',
      });
    }
    if (!emoji) {
      return JSON.stringify({ success: false, error: 'emoji param is required' });
    }

    try {
      const resp = await fetch(
        `${DISCORD_SERVICE_URL}/api/channels/${channelId}/messages/${messageId}/reactions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emoji }),
        }
      );
      const data = (await resp.json()) as any;
      if (!resp.ok || !data.success) {
        return JSON.stringify({ success: false, error: data.error || 'reaction failed' });
      }
      logger.info(`[reaction] ${emoji} on ${messageId}`);
      return JSON.stringify({ success: true, message: `Reacted ${emoji}` });
    } catch (error) {
      logger.error('[reaction] failed:', error);
      return JSON.stringify({ success: false, error: 'reaction request failed — discord service may be down' });
    }
  },
};
