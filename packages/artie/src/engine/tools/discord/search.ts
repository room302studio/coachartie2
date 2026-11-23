/**
 * discord-search: Artie looks things up in the server he's talking in, for his own context.
 * EJ, 2026-11-23: internal use only, current server only. The server and the person he's
 * talking to come from the turn context, never from the model's params, and the gateway keeps
 * results to channels that person can read (gateway/routes/message-search.ts). Results are other
 * people's words, so a search taints the turn (execute.ts TAINTING_CAPABILITIES).
 */
import { RegisteredCapability, CapabilityContext } from '../../5-tool-loop/registry.js';
import { logger } from '../../../shared/logger.js';
import * as gateway from '../../../gateway/api.js';

/** A Discord snowflake, or undefined. Accepts a raw id or a <@id> / <#id> mention. */
export function snowflakeOf(value: unknown): string | undefined {
  const match = /(\d{15,22})/.exec(String(value ?? ''));
  if (!match) {
    return undefined;
  }
  return match[1];
}

/**
 * The sort to use. An explicit choice wins. Otherwise words with no author are a "find that
 * thing" question (best match first), and anything about a person reads newest first.
 */
export function sortFor(sort: unknown, query: string, authorId: string | undefined): 'timestamp' | 'relevance' {
  if (sort === 'relevance' || sort === 'timestamp') {
    return sort;
  }
  if (query && !authorId) {
    return 'relevance';
  }
  return 'timestamp';
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return String(value);
}

export async function searchHandler(params: Record<string, unknown>, context?: CapabilityContext): Promise<string> {
  const guildId = context?.guildId;
  if (!guildId) {
    return JSON.stringify({ success: false, error: 'search only works in a server conversation, not in DMs' });
  }
  const authorId = snowflakeOf(params.author_id);
  const sortBy = sortFor(params.sort, String(params.query || '').trim(), authorId);
  try {
    const resp = await gateway.searchGuildMessages(guildId, context?.userId ?? null, {
      query: optionalString(params.query),
      authorId,
      channelId: snowflakeOf(params.channel_id),
      limit: Number(params.limit),
      sortBy,
      fromChannelId: optionalString(context?.channelId),
      after: optionalString(params.after),
      before: optionalString(params.before),
    });
    return JSON.stringify(resp.body);
  } catch (error) {
    logger.error('[discord-search] failed:', error);
    return JSON.stringify({ success: false, error: 'search unavailable: discord may be down' });
  }
}

export const discordSearchCapability: RegisteredCapability = {
  name: 'discord-search',
  emoji: '🔎',
  actions: {
    search: {
      effect: 'read',
      params: {
        query: { type: 'string', description: 'Words to find in message text' },
        author_id: { type: 'string', description: 'Only messages from this user (id or mention)' },
        channel_id: { type: 'string', description: 'Only this channel (id or mention)' },
        limit: { type: 'integer', description: 'Max results (default 10, max 25)' },
        sort: {
          type: 'string',
          enum: ['timestamp', 'relevance'],
          description:
            'best match or newest first. Default: best match for words alone, newest first when an author is given',
        },
        after: { type: 'string', description: 'Only messages after this date, e.g. 2026-05-01' },
        before: { type: 'string', description: 'Only messages before this date, e.g. 2026-06-01' },
      },
    },
  },
  supportedActions: ['search'],
  description:
    'Search past messages in the server you are talking in, to remember what was said ' +
    '("didn\'t someone post a link about X?", what a person said about Y). Give a query, an ' +
    'author_id, or both; narrow with after/before dates or a channel. Covers channels, forum ' +
    'posts and threads (archived ones too) in this server that the person you are talking to ' +
    'can read; does nothing in DMs. Results are excerpts with author, channel, time and a ' +
    'jump link; `searched` is how many channels and forums were covered (threads included), ' +
    '`more: true` means there were more matches than shown, and `note` says when ' +
    'channels were out of reach. Use it for your own context; quote sparingly and link instead of pasting.',
  requiredParams: [],
  examples: [
    '<capability name="discord-search" action="search" query="signal timing" />',
    '<capability name="discord-search" action="search" query="map export" author_id="123456789012345678" limit="5" />',
  ],
  handler: async (params: Record<string, unknown>, _content: string | undefined, context?: CapabilityContext) =>
    searchHandler(params, context),
};
