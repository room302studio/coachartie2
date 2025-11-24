import { RegisteredCapability } from '../services/capability-registry.js';
import { logger } from '@coachartie/shared';
import fetch from 'node-fetch';

interface DiscordThreadParams {
  action: 'create_thread' | 'get_thread_messages';
  channelId: string;
  threadId?: string;
  threadName?: string;
  message?: string;
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
    const url = `${DISCORD_SERVICE_URL}/api/channels/${channelId}/threads`;
    const body: any = {
      name: threadName,
    };

    if (message) {
      body.message = message;
    }

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Discord service error: ${response.status} ${response.statusText}`);
    }

    const thread = await response.json();

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
    const url = new URL(
      `${DISCORD_SERVICE_URL}/api/channels/${channelId}/threads/${threadId}/messages`
    );
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
        threadId,
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
    logger.error('❌ Failed to fetch Discord thread messages:', error);
    throw error;
  }
}
