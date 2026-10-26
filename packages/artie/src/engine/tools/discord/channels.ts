import { RegisteredCapability } from '../../5-tool-loop/registry.js';
import { logger } from '../../../shared/logger.js';
import * as gateway from '../../../gateway/api.js';

interface _DiscordChannelParams {
  action: 'get_messages' | 'get_pinned_messages' | 'search_messages';
  channelId: string;
  limit?: number;
  before?: string; // Message ID to fetch before
  after?: string; // Message ID to fetch after
  query?: string; // For search_messages
}

// Wave 9: the gateway has never served this tool's routes (no handler for GET
// /api/channels/:id/messages, /pins or /messages/search): over HTTP every call got express's 404.
// In-process, gateway.unservedRoute answers the same 404, so the tool fails exactly as it always
// has. Serving them is new work, not part of the move.

function ensureArray<T>(value: any): T[] {
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}


export const discordChannelsCapability: RegisteredCapability = {
  name: 'discord-channels',
  emoji: '💬',
  supportedActions: ['get_messages', 'get_pinned_messages', 'search_messages'],
  description:
    'Query Discord channel messages - fetch recent messages, pinned messages, or search channel history',
  requiredParams: ['action', 'channelId'],

  handler: async (params: any, _content: string | undefined) => {
    const action = params.action as string;

    try {
      switch (action) {
        case 'get_messages':
          return JSON.stringify(await getMessages(params));
        case 'get_pinned_messages':
          return JSON.stringify(await getPinnedMessages(params));
        case 'search_messages':
          return JSON.stringify(await searchMessages(params));
        default:
          throw new Error(`Unknown discord-channels action: ${action}`);
      }
    } catch (error) {
      logger.error(`Discord channels error: ${error}`);
      throw error;
    }
  },
};

/**
 * Fetch recent messages from a Discord channel
 */
async function getMessages(params: {
  channelId: string;
  limit?: number;
  before?: string;
  after?: string;
}): Promise<any> {
  const { channelId, limit = 50, before, after } = params;

  logger.info(`📨 Fetching messages from channel ${channelId}`);

  if (!channelId) {
    throw new Error('Missing required parameter: channelId');
  }

  try {
    const response = await gateway.unservedRoute('GET', `/api/channels/${channelId}/messages`);

    if (!gateway.isOk(response)) {
      throw new Error(`Discord service error: ${response.status} ${gateway.statusText(response)}`);
    }

    const messages = response.body as any;
    const messageArray = ensureArray(messages);

    return {
      success: true,
      data: {
        channelId,
        messageCount: messageArray.length,
        messages: messageArray.map((msg: any) => ({
          id: msg.id,
          author: msg.author?.username || 'Unknown',
          content: msg.content,
          timestamp: msg.timestamp,
          attachments: msg.attachments?.length || 0,
        })),
      },
    };
  } catch (error) {
    logger.error('❌ Failed to fetch Discord messages:', error);
    throw error;
  }
}

/**
 * Fetch pinned messages from a Discord channel
 */
async function getPinnedMessages(params: { channelId: string; limit?: number }): Promise<any> {
  const { channelId, limit = 50 } = params;

  logger.info(`📌 Fetching pinned messages from channel ${channelId}`);

  if (!channelId) {
    throw new Error('Missing required parameter: channelId');
  }

  try {
    const response = await gateway.unservedRoute('GET', `/api/channels/${channelId}/pins`);

    if (!gateway.isOk(response)) {
      throw new Error(`Discord service error: ${response.status} ${gateway.statusText(response)}`);
    }

    const messages = response.body as any;
    const messageArray = ensureArray(messages);

    return {
      success: true,
      data: {
        channelId,
        pinnedCount: messageArray.length,
        messages: messageArray.map((msg: any) => ({
          id: msg.id,
          author: msg.author?.username || 'Unknown',
          content: msg.content,
          timestamp: msg.timestamp,
          pinnedAt: msg.pinned_timestamp,
        })),
      },
    };
  } catch (error) {
    logger.error('❌ Failed to fetch pinned messages:', error);
    throw error;
  }
}

/**
 * Search messages in a Discord channel by keyword
 */
async function searchMessages(params: {
  channelId: string;
  query: string;
  limit?: number;
}): Promise<any> {
  const { channelId, query, limit = 50 } = params;

  logger.info(`🔍 Searching channel ${channelId} for: ${query}`);

  if (!channelId) {
    throw new Error('Missing required parameter: channelId');
  }

  if (!query) {
    throw new Error('Missing required parameter: query');
  }

  try {
    const response = await gateway.unservedRoute('GET', `/api/channels/${channelId}/messages/search`);

    if (!gateway.isOk(response)) {
      throw new Error(`Discord service error: ${response.status} ${gateway.statusText(response)}`);
    }

    const results = response.body as any;
    const resultArray = ensureArray(results);

    return {
      success: true,
      data: {
        channelId,
        query,
        resultCount: resultArray.length,
        messages: resultArray.map((msg: any) => ({
          id: msg.id,
          author: msg.author?.username || 'Unknown',
          content: msg.content,
          timestamp: msg.timestamp,
        })),
      },
    };
  } catch (error) {
    logger.error('❌ Failed to search Discord messages:', error);
    throw error;
  }
}
