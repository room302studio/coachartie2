import { RegisteredCapability } from '../../5-tool-loop/registry.js';
import { logger } from '../../../shared/logger.js';
import * as gateway from '../../../gateway/api.js';

interface _DiscordUserHistoryParams {
  action: 'get_user_messages';
  channelId: string;
  userId: string;
  limit?: number;
}

// Wave 9: the gateway has never served this tool's routes (no handler for GET
// /api/channels/:id/messages): over HTTP every call got express's 404. In-process,
// gateway.unservedRoute answers the same 404, so the tool fails exactly as it always has. Serving
// them is new work, not part of the move.


export const discordUserHistoryCapability: RegisteredCapability = {
  name: 'discord-user-history',
  emoji: '📜',
  supportedActions: ['get_user_messages'],
  description:
    'Query Discord user message history - fetch all messages from a specific user in a channel. Useful for duplicate detection and checking if a user has reported before.',
  requiredParams: ['action', 'channelId', 'userId'],

  handler: async (params: any, _content: string | undefined) => {
    const action = params.action as string;

    try {
      switch (action) {
        case 'get_user_messages':
          return JSON.stringify(await getUserMessages(params));
        default:
          throw new Error(`Unknown discord-user-history action: ${action}`);
      }
    } catch (error) {
      logger.error(`Discord user history error: ${error}`);
      throw error;
    }
  },
};

/**
 * Fetch all messages from a specific user in a Discord channel
 */
async function getUserMessages(params: {
  channelId: string;
  userId: string;
  limit?: number;
}): Promise<any> {
  const { channelId, userId, limit = 50 } = params;

  logger.info(`👤 Fetching messages from user ${userId} in channel ${channelId}`);

  if (!channelId) {
    throw new Error('Missing required parameter: channelId');
  }

  if (!userId) {
    throw new Error('Missing required parameter: userId');
  }

  try {
    const response = await gateway.unservedRoute('GET', `/api/channels/${channelId}/messages`);

    if (!gateway.isOk(response)) {
      throw new Error(`Discord service error: ${response.status} ${gateway.statusText(response)}`);
    }

    const messages = response.body as any;
    const messageArray = Array.isArray(messages) ? messages : [];

    return {
      success: true,
      data: {
        channelId,
        userId,
        messageCount: messageArray.length,
        messages: messageArray.map((msg: any) => ({
          id: msg.id,
          author: {
            id: msg.author?.id,
            username: msg.author?.username || 'Unknown',
          },
          content: msg.content,
          timestamp: msg.timestamp,
          attachments: msg.attachments?.length || 0,
        })),
      },
    };
  } catch (error) {
    logger.error('❌ Failed to fetch user messages:', error);
    throw error;
  }
}
