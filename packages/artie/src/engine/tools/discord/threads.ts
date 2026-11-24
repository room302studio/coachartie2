/**
 * discord-threads: start a thread, or read one. Until 2026-11-23 both actions went to a gateway
 * route that was never served, so every call got a 404 and Artie thought he could use threads.
 * Reading now goes through the same scope as discord-channels (readChannelMessages: this server,
 * only threads everyone in the conversation can read). Starting one follows
 * gateway/routes/discord-write.ts: the channel we're talking in anywhere, any channel in Room 302,
 * never a ping. The server and conversation channel come from the turn context, never params.
 * Channel names work ("#general"); the registry resolves them first.
 */
import { RegisteredCapability, CapabilityContext } from '../../5-tool-loop/registry.js';
import { logger } from '../../../shared/logger.js';
import * as gateway from '../../../gateway/api.js';

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return String(value);
}

export async function threadsHandler(params: Record<string, unknown>, context?: CapabilityContext): Promise<string> {
  const action = String(params.action || '');
  const guildId = context?.guildId ?? null;
  if (!guildId) {
    return JSON.stringify({ success: false, error: 'threads only work in a server conversation, not in DMs' });
  }
  try {
    if (action === 'get_thread_messages') {
      const threadId = optionalString(params.threadId) || optionalString(context?.channelId);
      if (!threadId) {
        return JSON.stringify({ success: false, error: 'name a thread (threadId)' });
      }
      const resp = await gateway.readChannelMessages(guildId, context?.userId ?? null, {
        channelId: threadId,
        fromChannelId: optionalString(context?.channelId),
        limit: Number(params.limit),
        before: optionalString(params.before),
      });
      return JSON.stringify(resp.body);
    }
    if (action === 'create_thread') {
      const resp = await gateway.createThread(guildId, context?.channelId, {
        channelId: optionalString(params.channelId),
        name: String(params.threadName || params.name || ''),
        message: optionalString(params.message),
        messageId: optionalString(params.messageId),
      });
      return JSON.stringify(resp.body);
    }
    throw new Error(`Unknown discord-threads action: ${action}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Unknown discord-threads action')) {
      throw error;
    }
    logger.error('[discord-threads] failed:', error);
    return JSON.stringify({ success: false, error: 'threads unavailable: discord may be down' });
  }
}

export const discordThreadsCapability: RegisteredCapability = {
  name: 'discord-threads',
  emoji: '🧵',
  actions: {
    create_thread: {
      effect: 'discord',
      params: {
        threadName: { type: 'string', description: 'Thread title (max 100 chars)', required: true, aliases: ['name'] },
        message: { type: 'string', description: 'Optional first message in the thread' },
        messageId: { type: 'string', description: 'Start the thread from this existing message' },
        channelId: {
          type: 'string',
          description: 'Where to start it ("#general"); defaults to this channel. Other channels only in Room 302 and the SB2 alpha server.',
        },
      },
    },
    get_thread_messages: {
      effect: 'read',
      params: {
        threadId: { type: 'string', description: 'The thread (id, <#mention> or its title); defaults to this one' },
        limit: { type: 'integer', description: 'How many recent messages (default 10, max 25)' },
        before: { type: 'string', description: 'Only messages before this message id (page back)' },
      },
    },
  },
  supportedActions: ['create_thread', 'get_thread_messages'],
  description:
    'Start a thread (in the channel you are talking in, or any channel in Room 302 or the SB2 alpha server) or read a ' +
    'thread you can see, oldest first with message ids. Replies to someone inside a thread already ' +
    'land in that thread, so you only need this to start one or read another.',
  requiredParams: ['action'],
  examples: [
    '<capability name="discord-threads" action="create_thread" threadName="Crossover bug notes" message="Collecting repro steps here." />',
    '<capability name="discord-threads" action="get_thread_messages" threadId="Crash on load" />',
  ],
  handler: async (params: Record<string, unknown>, _content: string | undefined, context?: CapabilityContext) =>
    threadsHandler(params, context),
};
