import { RegisteredCapability } from '../../5-tool-loop/registry.js';
import { logger } from '../../../shared/logger.js';
import * as gateway from '../../../gateway/api.js';

// Room 302 Studio Guild whitelist
const WHITELISTED_GUILD_IDS = ['932719842522443928'];

export const discordSendMessageCapability: RegisteredCapability = {
  name: 'discord-send-message',
  emoji: '💬',
  supportedActions: ['send_message'],
  description:
    'Send a message to a whitelisted Discord channel. Requires explicit guildId and channelId - prevents sneaky hidden messages.',
  requiredParams: ['guildId', 'channelId', 'message'],

  handler: async (params: any, _content: string | undefined) => {
    const { action } = params;

    switch (action) {
      case 'send_message':
        return JSON.stringify(await sendMessage(params));
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
}): Promise<any> {
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

  try {
    // Gateway's POST /api/channels/:id/messages, in-process since wave 9
    const response = await gateway.sendChannelMessage(String(channelId), { content: message });

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

    const sentMessage = response.body;
    logger.info('✅ discord-send-message: Message sent successfully', {
      channelId,
      messageId: (sentMessage as any).id,
      length: message.length,
    });

    return {
      success: true,
      messageId: (sentMessage as any).id,
      channelId,
      guildId,
      content: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
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
