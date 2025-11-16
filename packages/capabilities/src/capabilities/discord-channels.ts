import { RegisteredCapability } from '../services/capability-registry.js';
import { logger } from '@coachartie/shared';
import fetch from 'node-fetch';

interface DiscordChannelParams {
  action: 'get_messages' | 'get_pinned_messages' | 'search_messages';
  channelId: string;
  limit?: number;
  before?: string; // Message ID to fetch before
  after?: string; // Message ID to fetch after
  query?: string; // For search_messages
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

export const discordChannelsCapability: RegisteredCapability = {
  name: 'discord-channels',
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
    const url = new URL(`${DISCORD_SERVICE_URL}/api/channels/${channelId}/messages`);
    url.searchParams.set('limit', Math.min(limit, 100).toString()); // Cap at 100
    if (before) url.searchParams.set('before', before);
    if (after) url.searchParams.set('after', after);

    const response = await fetchWithTimeout(url.toString());

    if (!response.ok) {
      throw new Error(`Discord service error: ${response.status} ${response.statusText}`);
    }

    const messages = await response.json();

    return {
      success: true,
      data: {
        channelId,
        messageCount: Array.isArray(messages) ? messages.length : 0,
        messages: Array.isArray(messages)
          ? messages.map((msg: any) => ({
              id: msg.id,
              author: msg.author?.username || 'Unknown',
              content: msg.content,
              timestamp: msg.timestamp,
              attachments: msg.attachments?.length || 0,
            }))
          : [],
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
    const url = new URL(`${DISCORD_SERVICE_URL}/api/channels/${channelId}/pins`);
    url.searchParams.set('limit', Math.min(limit, 100).toString());

    const response = await fetchWithTimeout(url.toString());

    if (!response.ok) {
      throw new Error(`Discord service error: ${response.status} ${response.statusText}`);
    }

    const messages = await response.json();

    return {
      success: true,
      data: {
        channelId,
        pinnedCount: Array.isArray(messages) ? messages.length : 0,
        messages: Array.isArray(messages)
          ? messages.map((msg: any) => ({
              id: msg.id,
              author: msg.author?.username || 'Unknown',
              content: msg.content,
              timestamp: msg.timestamp,
              pinnedAt: msg.pinned_timestamp,
            }))
          : [],
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
    const url = new URL(`${DISCORD_SERVICE_URL}/api/channels/${channelId}/messages/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', Math.min(limit, 100).toString());

    const response = await fetchWithTimeout(url.toString());

    if (!response.ok) {
      throw new Error(`Discord service error: ${response.status} ${response.statusText}`);
    }

    const results = await response.json();

    return {
      success: true,
      data: {
        channelId,
        query,
        resultCount: Array.isArray(results) ? results.length : 0,
        messages: Array.isArray(results)
          ? results.map((msg: any) => ({
              id: msg.id,
              author: msg.author?.username || 'Unknown',
              content: msg.content,
              timestamp: msg.timestamp,
            }))
          : [],
      },
    };
  } catch (error) {
    logger.error('❌ Failed to search Discord messages:', error);
    throw error;
  }
}
