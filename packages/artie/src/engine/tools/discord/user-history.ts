/**
 * discord-user-history: what one person has said in this server, newest first. Until 2026-11-23
 * it went to a gateway route that was never served (a 404 on every call). It is now a thin
 * front on discord-search with an author: same scope (this server, channels everyone in the
 * conversation can read, opted-out and banned people never shown), Discord's index instead of
 * a 100-message channel scan, and it works across channels unless one is named.
 */
import { RegisteredCapability, CapabilityContext } from '../../5-tool-loop/registry.js';
import { logger } from '../../../shared/logger.js';
import * as gateway from '../../../gateway/api.js';
import { snowflakeOf } from './search.js';

export async function userHistoryHandler(
  params: Record<string, unknown>,
  context?: CapabilityContext
): Promise<string> {
  if (params.action !== 'get_user_messages') {
    throw new Error(`Unknown discord-user-history action: ${String(params.action)}`);
  }
  const guildId = context?.guildId;
  if (!guildId) {
    return JSON.stringify({ success: false, error: 'user history only works in a server conversation, not in DMs' });
  }
  const authorId = snowflakeOf(params.userId ?? params.user_id);
  if (!authorId) {
    return JSON.stringify({ success: false, error: 'give the person as a user id or <@mention>' });
  }
  try {
    const resp = await gateway.searchGuildMessages(guildId, context?.userId ?? null, {
      authorId,
      channelId: snowflakeOf(params.channelId),
      limit: Number(params.limit),
      sortBy: 'timestamp',
      fromChannelId: context?.channelId,
    });
    return JSON.stringify(resp.body);
  } catch (error) {
    logger.error('[discord-user-history] failed:', error);
    return JSON.stringify({ success: false, error: 'history unavailable: discord may be down' });
  }
}

export const discordUserHistoryCapability: RegisteredCapability = {
  name: 'discord-user-history',
  emoji: '📜',
  actions: {
    get_user_messages: {
      effect: 'read',
      params: {
        userId: { type: 'string', description: 'The person (user id or <@mention>)', required: true, aliases: ['user_id'] },
        channelId: { type: 'string', description: 'Only this channel ("#bugs"); default: every channel you can see' },
        limit: { type: 'integer', description: 'How many (default 10, max 25)' },
      },
    },
  },
  supportedActions: ['get_user_messages'],
  description:
    "A person's recent messages in this server, newest first, from channels everyone in this " +
    'conversation can read. Useful for "have they reported this before?". Same as discord-search ' +
    'with an author.',
  requiredParams: ['action'],
  examples: ['<capability name="discord-user-history" action="get_user_messages" userId="<@123456789012345678>" limit="5" />'],
  handler: async (params: Record<string, unknown>, _content: string | undefined, context?: CapabilityContext) =>
    userHistoryHandler(params, context),
};
