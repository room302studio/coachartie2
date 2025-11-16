import { RegisteredCapability } from '../services/capability-registry.js';
import { logger } from '@coachartie/shared';
import fetch from 'node-fetch';

interface DiscordUserHistoryParams {
  action: 'get_user_messages';
  channelId: string;
  userId: string;
  limit?: number;
}

const DISCORD_SERVICE_URL = process.env.DISCORD_SERVICE_URL || 'http://localhost:47321';

async function fetchWithTimeout(
  url: string,
  options: any = {},
  timeout = 30000
): Promise<any> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${timeout}ms`);
    }
    throw error;
  }
}

export const discordUserHistoryCapability: RegisteredCapability = {
  name: 'discord-user-history',
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
    const url = new URL(`${DISCORD_SERVICE_URL}/api/channels/${channelId}/messages`);
    url.searchParams.set('userId', userId);
    url.searchParams.set('limit', Math.min(limit, 100).toString()); // Cap at 100

    const response = await fetchWithTimeout(url.toString());

    if (!response.ok) {
      throw new Error(`Discord service error: ${response.status} ${response.statusText}`);
    }

    const messages = await response.json();

    return {
      success: true,
      data: {
        channelId,
        userId,
        messageCount: Array.isArray(messages) ? messages.length : 0,
        messages: Array.isArray(messages)
          ? messages.map((msg: any) => ({
              id: msg.id,
              author: {
                id: msg.author?.id,
                username: msg.author?.username || 'Unknown',
              },
              content: msg.content,
              timestamp: msg.timestamp,
              attachments: msg.attachments?.length || 0,
            }))
          : [],
      },
    };
  } catch (error) {
    logger.error('❌ Failed to fetch user messages:', error);
    throw error;
  }
}
