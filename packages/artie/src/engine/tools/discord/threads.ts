import { RegisteredCapability } from '../../5-tool-loop/registry.js';
import { logger } from '../../../shared/logger.js';
import * as gateway from '../../../gateway/api.js';

interface _DiscordThreadParams {
  action: 'create_thread' | 'get_thread_messages';
  channelId: string;
  threadId?: string;
  threadName?: string;
  message?: string;
  limit?: number;
}

// Wave 9: the gateway has never served this tool's routes (no handler for POST
// /api/channels/:id/threads or GET /api/channels/:id/threads/:id/messages): over HTTP every call
// got express's 404. In-process, gateway.unservedRoute answers the same 404, so the tool fails
// exactly as it always has. Serving them is new work, not part of the move.

function ensureArray<T>(value: any): T[] {
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}


export const discordThreadsCapability: RegisteredCapability = {
  name: 'discord-threads',
  emoji: '🧵',
  supportedActions: ['create_thread', 'get_thread_messages'],
  description:
    'Manage Discord threads - create new threads in channels or retrieve messages from existing threads',
  requiredParams: ['action', 'channelId'],

  handler: async (params: any, _content: string | undefined) => {
    const action = params.action as string;

    try {
      switch (action) {
        case 'create_thread':
          return JSON.stringify(await createThread(params));
        case 'get_thread_messages':
          return JSON.stringify(await getThreadMessages(params));
        default:
          throw new Error(`Unknown discord-threads action: ${action}`);
      }
    } catch (error) {
      logger.error(`Discord threads error: ${error}`);
      throw error;
    }
  },
};

/**
 * Create a new thread in a Discord channel
 */
async function createThread(params: {
  channelId: string;
  threadName: string;
  message?: string;
}): Promise<any> {
  const { channelId, threadName, message } = params;

  logger.info(`🧵 Creating thread "${threadName}" in channel ${channelId}`);

  if (!channelId) {
    throw new Error('Missing required parameter: channelId');
  }

  if (!threadName) {
    throw new Error('Missing required parameter: threadName');
  }

  try {
    const response = await gateway.unservedRoute('POST', `/api/channels/${channelId}/threads`);

    if (!gateway.isOk(response)) {
      throw new Error(`Discord service error: ${response.status} ${gateway.statusText(response)}`);
    }

    const thread = response.body as any;

    return {
      success: true,
      data: {
        threadId: thread.id,
        threadName: thread.name,
        channelId: thread.parent_id || channelId,
        created: thread.created_timestamp || new Date().toISOString(),
      },
    };
  } catch (error) {
    logger.error('❌ Failed to create Discord thread:', error);
    throw error;
  }
}

/**
 * Get all messages in a Discord thread
 */
async function getThreadMessages(params: {
  channelId: string;
  threadId: string;
  limit?: number;
}): Promise<any> {
  const { channelId, threadId, limit = 50 } = params;

  logger.info(`📬 Fetching messages from thread ${threadId} in channel ${channelId}`);

  if (!channelId) {
    throw new Error('Missing required parameter: channelId');
  }

  if (!threadId) {
    throw new Error('Missing required parameter: threadId');
  }

  try {
    const response = await gateway.unservedRoute('GET', `/api/channels/${channelId}/threads/${threadId}/messages`);

    if (!gateway.isOk(response)) {
      throw new Error(`Discord service error: ${response.status} ${gateway.statusText(response)}`);
    }

    const messages = response.body as any;
    const messageArray = ensureArray(messages);

    return {
      success: true,
      data: {
        channelId,
        threadId,
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
    logger.error('❌ Failed to fetch Discord thread messages:', error);
    throw error;
  }
}
