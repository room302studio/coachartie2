/**
 * discord-channels: read recent or pinned messages in a channel of the server Artie is talking
 * in. Until 2026-11-23 the gateway never served this tool's routes, so every call got a 404 and
 * Artie believed he could read channels when he couldn't. It now goes through the same scope as
 * discord-search (gateway/routes/message-search.ts readChannelMessages): the server, the person
 * and the conversation channel come from the turn context, never from params, and only channels
 * everyone in the conversation can read are allowed. Results are other people's words, so a
 * read taints the turn (execute.ts TAINTING_CAPABILITIES). Channel names work ("#general"):
 * the registry resolves them first (5-tool-loop/channel-names.ts).
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

export async function channelsHandler(params: Record<string, unknown>, context?: CapabilityContext): Promise<string> {
  const action = String(params.action || '');
  if (action !== 'get_messages' && action !== 'get_pinned_messages') {
    throw new Error(`Unknown discord-channels action: ${action}`);
  }
  const guildId = context?.guildId;
  if (!guildId) {
    return JSON.stringify({ success: false, error: 'reading a channel only works in a server conversation, not in DMs' });
  }
  // Default to the channel Artie is talking in when none is named.
  const channelId = optionalString(params.channelId) || optionalString(context?.channelId);
  if (!channelId) {
    return JSON.stringify({ success: false, error: 'name a channel, e.g. channelId="#general"' });
  }
  try {
    const resp = await gateway.readChannelMessages(guildId, context?.userId ?? null, {
      channelId,
      fromChannelId: optionalString(context?.channelId),
      limit: Number(params.limit),
      before: optionalString(params.before),
      after: optionalString(params.after),
      pinned: action === 'get_pinned_messages',
    });
    return JSON.stringify(resp.body);
  } catch (error) {
    logger.error('[discord-channels] failed:', error);
    return JSON.stringify({ success: false, error: 'reading unavailable: discord may be down' });
  }
}

const CHANNEL_PARAMS = {
  channelId: {
    type: 'string',
    description: 'Channel or thread: "#general", a <#mention>, or an id. Defaults to this channel.',
  },
} as const;

export const discordChannelsCapability: RegisteredCapability = {
  name: 'discord-channels',
  emoji: '💬',
  actions: {
    get_messages: {
      effect: 'read',
      params: {
        ...CHANNEL_PARAMS,
        limit: { type: 'integer', description: 'How many recent messages (default 10, max 25)' },
        before: { type: 'string', description: 'Only messages before this message id (page back)' },
        after: { type: 'string', description: 'Only messages after this message id' },
      },
    },
    get_pinned_messages: {
      effect: 'read',
      params: { ...CHANNEL_PARAMS },
    },
  },
  supportedActions: ['get_messages', 'get_pinned_messages'],
  description:
    'Read recent or pinned messages in a channel or thread of the server you are talking in, ' +
    'oldest first, each with its message id (so you can react to or link a specific one). Only ' +
    'channels everyone in this conversation can read; not in DMs. To find older messages by ' +
    'words, person or date use discord-search.',
  requiredParams: ['action'],
  examples: [
    '<capability name="discord-channels" action="get_messages" channelId="#general" limit="5" />',
    '<capability name="discord-channels" action="get_pinned_messages" channelId="#rules" />',
  ],
  handler: async (params: Record<string, unknown>, _content: string | undefined, context?: CapabilityContext) =>
    channelsHandler(params, context),
};
