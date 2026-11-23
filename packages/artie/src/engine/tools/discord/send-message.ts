import { RegisteredCapability, CapabilityContext } from '../../5-tool-loop/registry.js';
import { logger } from '../../../shared/logger.js';
import { mintTrustedGuild, type TrustedGuildId } from '../../../shared/trusted-ids.js';
import * as gateway from '../../../gateway/api.js';
import { getErrorMessage } from '../../../shared/errors.js';
import { isOwner } from '../../../shared/config/owner.js';
import { scrubBlockedUserMentions } from '../../../shared/blocklist.js';

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  return undefined;
}

/** The sent message's id from the gateway's reply body, if it has one. */
function sentMessageId(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null && 'id' in body) {
    return stringOrUndefined((body as { id: unknown }).id);
  }
  return undefined;
}

// Room 302 Studio Guild whitelist
const WHITELISTED_GUILD_IDS = ['932719842522443928'];

export const discordSendMessageCapability: RegisteredCapability = {
  name: 'discord-send-message',
  emoji: '💬',
  // Declared 2026-11-23 (it was undeclared = open, with no gates): both are Discord writes.
  actions: {
    send_message: {
      effect: 'discord',
      params: {
        guildId: { type: 'string', description: 'Only from EJ\'s DM: the server id (Room 302). Ignored in a server.' },
        channelId: { type: 'string', description: 'Channel ("#general" or id)', required: true },
        message: { type: 'string', description: 'The text to post', required: true },
      },
    },
    edit_message: {
      effect: 'discord',
      params: {
        channelId: { type: 'string', description: 'Channel the message is in; defaults to this one' },
        messageId: { type: 'string', description: 'Id of YOUR message to edit', required: true, aliases: ['message_id'] },
        message: { type: 'string', description: 'The new full text', required: true },
      },
    },
  },
  supportedActions: ['send_message', 'edit_message'],
  description:
    'send_message: post to a channel in Room 302 (from a Room 302 conversation; EJ may also do it from his DM). ' +
    'edit_message: fix a message YOU already sent in this server (channelId + messageId + message, ' +
    'the new full text) instead of posting a correction.',
  requiredParams: ['action'],

  handler: async (params: Record<string, unknown>, _content: string | undefined, context?: CapabilityContext) => {
    const { action } = params;

    switch (action) {
      case 'send_message': {
        // The server is the conversation's; only EJ, in a DM, may name one (Codex High,
        // 2026-11-23: a model-written guildId let any server's conversation post into Room 302).
        let guildId: TrustedGuildId | undefined = context?.guildId;
        if (!guildId && isOwner(String(context?.userId ?? ''))) {
          guildId = mintTrustedGuild(params.guildId, 'owner-dm-choice');
        }
        return JSON.stringify(
          await sendMessage({
            guildId,
            channelId: stringOrUndefined(params.channelId),
            message: stringOrUndefined(params.message),
          })
        );
      }
      case 'edit_message': {
        // The server is the conversation's, never a param: he edits only here, only his own.
        const askerId = context?.userId ?? null;
        const resp = await gateway.editOwnMessage(
          context?.guildId ?? null,
          {
            askerId,
            fromChannelId: context?.channelId,
            askerIsOwner: isOwner(String(askerId ?? '')),
          },
          {
            channelId: String(params.channelId ?? context?.channelId ?? ''),
            messageId: String(params.messageId ?? params.message_id ?? ''),
            message: String(params.message ?? ''),
          }
        );
        return JSON.stringify(resp.body);
      }
      default:
        return JSON.stringify({
          success: false,
          error: `Unknown action: ${action}`,
        });
    }
  },
};

/**
 * Send a message to a Discord channel
 * Only allowed on whitelisted guilds (room302 for now)
 */
async function sendMessage(params: {
  guildId?: string;
  channelId?: string;
  message?: string;
}): Promise<Record<string, unknown>> {
  const { guildId, channelId, message } = params;

  // Validate required parameters
  if (!guildId || !channelId || !message) {
    logger.warn('❌ discord-send-message: Missing required parameters', {
      guildId,
      channelId,
      hasMessage: !!message,
    });
    return {
      success: false,
      error: 'Missing required parameters: guildId, channelId, message',
      code: 'PARAM_MISSING_003',
    };
  }

  // Check guild whitelist
  if (!WHITELISTED_GUILD_IDS.includes(guildId)) {
    logger.warn('❌ discord-send-message: Guild not whitelisted', {
      guildId,
      whitelistedCount: WHITELISTED_GUILD_IDS.length,
    });
    return {
      success: false,
      error: `Guild ${guildId} is not whitelisted for sending messages`,
      code: 'GUILD_NOT_WHITELISTED',
    };
  }

  // The channel must belong to that whitelisted guild: the guild check alone let a Room 302
  // guildId carry any channel id from any server (2026-11-23).
  if (!gateway.guildChannelEntries(guildId).some((e) => e.id === String(channelId))) {
    logger.warn('❌ discord-send-message: Channel not in the whitelisted guild', { guildId, channelId });
    return {
      success: false,
      error: `Channel ${channelId} is not in that server`,
      code: 'CHANNEL_NOT_IN_GUILD',
    };
  }

  try {
    // Gateway's POST /api/channels/:id/messages, in-process since wave 9
    // Same scrub as his normal replies (gateway/4-reply/stream-reply.ts): banned people become
    // their epithet, and opted-out banned people lose name, id and ping (Artie asked, 2026-11-23).
    const response = await gateway.sendChannelMessage(String(channelId), {
      content: scrubBlockedUserMentions(message),
    });

    if (!gateway.isOk(response)) {
      const errorData = JSON.stringify(response.body);
      logger.error('❌ discord-send-message: Failed to send message', {
        status: response.status,
        error: errorData,
        channelId,
      });
      return {
        success: false,
        error: `Discord API error: ${response.status}`,
        details: errorData,
        code: 'DISCORD_API_ERROR',
      };
    }

    const messageId = sentMessageId(response.body);
    logger.info('✅ discord-send-message: Message sent successfully', {
      channelId,
      messageId,
      length: message.length,
    });

    let preview: string;
    if (message.length > 100) {
      preview = message.substring(0, 100) + '...';
    } else {
      preview = message;
    }

    return {
      success: true,
      messageId,
      channelId,
      guildId,
      content: preview,
    };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    logger.error('❌ discord-send-message: Exception', {
      error: errorMessage,
      channelId,
      guildId,
    });
    return {
      success: false,
      error: `Failed to send message: ${errorMessage}`,
      code: 'SEND_MESSAGE_FAILED',
    };
  }
}
