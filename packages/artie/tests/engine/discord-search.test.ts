import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/shared/privacy-opt-out.js', () => ({
  isOptedOut: (id: string) => id === '300000000000000003',
}));
vi.mock('../../src/shared/blocklist.js', () => ({
  isBlockedUser: (id: string) => id === '300000000000000004',
}));

const gatewayMock = vi.hoisted(() => ({ searchGuildMessages: vi.fn(), readChannelMessages: vi.fn() }));
vi.mock('../../src/gateway/api.js', () => gatewayMock);

import {
  searchGuildMessages,
  buildSearchQuery,
  pickHits,
  clampLimit,
  excerptOf,
  snowflakeAt,
  audienceCanRead,
  hasTargetedDeny,
  readChannelMessages,
  contentMarkers,
} from '../../src/gateway/routes/message-search.js';
import { whereLines, isDiscordTurn, addChannelVibes } from '../../src/engine/3-context/sources/discord.js';
import { searchHandler, snowflakeOf, sortFor } from '../../src/engine/tools/discord/search.js';
import { channelsHandler } from '../../src/engine/tools/discord/channels.js';

const GUILD = '100000000000000001';
const PUBLIC = '200000000000000001';
const MODS = '200000000000000002';
const PRIVATE_THREAD = '200000000000000003';
const ASKER = '300000000000000001';
const FORUM = '200000000000000004';
const ARCHIVED_POST = '200000000000000005';

/** Permissions object: `readable` = ViewChannel + ReadMessageHistory. */
function perms(readable: boolean) {
  return { has: () => readable };
}

function channel(id: string, name: string, readableBy: (who: string) => boolean, type = 0) {
  return {
    id,
    name,
    type,
    isTextBased: () => true,
    permissionsFor: (who: any) => perms(readableBy(who.id)),
  };
}

function msg(id: string, channelId: string, authorId: string, content: string) {
  return { id, channel_id: channelId, author: { id: authorId, username: `u${authorId.slice(-1)}` }, content, timestamp: '2026-11-20T00:00:00Z' };
}

function fakeClient(
  searchBodies: any[],
  opts: { askerIsMember?: boolean; fetchFails?: boolean; askerIsMod?: boolean } = {}
) {
  const everyone = { id: 'everyone' };
  const me = { id: 'artie' };
  const asker = { id: ASKER };
  const channels = new Map<string, any>([
    [PUBLIC, channel(PUBLIC, 'general', () => true)],
    // Mods: Artie can read it, the asker and @everyone can't.
    [MODS, channel(MODS, 'mods', (who) => who === 'artie' || (Boolean(opts.askerIsMod) && who === ASKER))],
    [PRIVATE_THREAD, channel(PRIVATE_THREAD, 'secret-thread', () => true, 12)],
    // A forum: not text-based in discord.js, searched through its parent id.
    [FORUM, { ...channel(FORUM, 'bug-reports', () => true, 15), isTextBased: () => false }],
  ]);
  const liveMsg = (id: string, authorId: string, content: string, at: string) => ({
    id,
    author: { id: authorId, username: `u${authorId.slice(-1)}` },
    content,
    createdAt: new Date(at),
  });
  const publicFetch = vi.fn(
    async () =>
      new Map([
        ['m3', liveMsg('m3', '300000000000000002', 'third', '2026-11-20T03:00:00Z')],
        ['m2', liveMsg('m2', '300000000000000003', 'opted out', '2026-11-20T02:00:00Z')],
        ['m1', liveMsg('m1', '300000000000000002', 'first', '2026-11-20T01:00:00Z')],
      ])
  );
  const modsFetch = vi.fn(async () => new Map());
  const get = vi.fn();
  for (const body of searchBodies) {
    get.mockResolvedValueOnce(body);
  }
  const guild = {
    roles: { everyone },
    members: {
      me,
      cache: new Map(),
      fetch: vi.fn(async (id: string) => {
        if (opts.fetchFails) {
          throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        }
        if (opts.askerIsMember === false || id !== ASKER) {
          throw Object.assign(new Error('Unknown Member'), { code: 10007 });
        }
        return asker;
      }),
    },
    channels: { cache: channels },
  };
  return {
    client: {
      guilds: { cache: new Map([[GUILD, guild]]) },
      rest: { get },
      // Uncached threads: an archived public forum post and a public thread under #mods.
      channels: {
        fetch: vi.fn(async (id: string) => {
          const threads: Record<string, any> = {
            [ARCHIVED_POST]: { type: 11, parentId: FORUM, name: 'Crash on load', guildId: GUILD },
            '200000000000000006': { type: 11, parentId: MODS, name: 'mod thread', guildId: GUILD },
            // Readable channels for discord-channels: messages newest first, as Discord returns them.
            [PUBLIC]: { id: PUBLIC, guildId: GUILD, messages: { fetch: publicFetch, fetchPinned: publicFetch } },
            [MODS]: { id: MODS, guildId: GUILD, messages: { fetch: modsFetch, fetchPinned: modsFetch } },
            [FORUM]: { id: FORUM, guildId: GUILD, type: 15 },
          };
          if (!threads[id]) {
            throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
          }
          return threads[id];
        }),
      },
    } as any,
    get,
    modsFetch,
  };
}

describe('message-search helpers', () => {
  it('clamps limits to 1..25, default 10', () => {
    expect(clampLimit(undefined)).toBe(10);
    expect(clampLimit(0)).toBe(10);
    expect(clampLimit(5)).toBe(5);
    expect(clampLimit(500)).toBe(25);
  });

  it('builds repeated channel_id params and trims the query', () => {
    const q = buildSearchQuery({ query: '  maps  ', limit: 3 }, ['1', '2']);
    expect(q.get('content')).toBe('maps');
    expect(q.getAll('channel_id')).toEqual(['1', '2']);
    expect(q.get('limit')).toBe('3');
    expect(q.has('sort_by')).toBe(false);
  });

  it('takes the flagged hit from each group', () => {
    expect(pickHits([[{ id: 'a' }, { id: 'b', hit: true }], [{ id: 'c' }], []]).map((m) => m.id)).toEqual(['b', 'c']);
    expect(pickHits(undefined)).toEqual([]);
  });

  it('flattens and cuts excerpts', () => {
    expect(excerptOf('a\n\n b')).toBe('a b');
    expect(excerptOf('x'.repeat(400)).length).toBe(300);
  });
});

describe('searchGuildMessages scope', () => {
  it('refuses outside a server', async () => {
    const { client } = fakeClient([]);
    const r = await searchGuildMessages(client, null, ASKER, { query: 'x' });
    expect(r.status).toBe(400);
  });

  it('searches only channels the asker can read, never mods or private threads', async () => {
    const { client, get } = fakeClient([{ total_results: 1, messages: [[msg('m1', PUBLIC, '300000000000000002', 'map export is broken')]] }]);
    const r = await searchGuildMessages(client, GUILD, ASKER, { query: 'map' });
    const sent: URLSearchParams = get.mock.calls[0][1].query;
    expect(get.mock.calls[0][0]).toBe(`/guilds/${GUILD}/messages/search`);
    expect(sent.getAll('channel_id')).toEqual([PUBLIC, FORUM]);
    expect(r.body.results).toHaveLength(1);
    expect(r.body.results[0]).toMatchObject({ channel: 'general', url: `https://discord.com/channels/${GUILD}/${PUBLIC}/m1` });
  });

  it('drops hits from channels outside the allowed set even if Discord returns them', async () => {
    const { client } = fakeClient([{ messages: [[msg('m1', MODS, '300000000000000002', 'mod talk')]] }]);
    const r = await searchGuildMessages(client, GUILD, ASKER, { query: 'mod' });
    expect(r.body.results).toEqual([]);
  });

  it('a non-member asker (system turn) is judged as @everyone', async () => {
    const { client, get } = fakeClient([{ messages: [] }], { askerIsMember: false });
    await searchGuildMessages(client, GUILD, 'observational-system', { query: 'x' });
    expect(get.mock.calls[0][1].query.getAll('channel_id')).toEqual([PUBLIC, FORUM]);
  });

  it('a confirmed non-member (Unknown Member) is judged as @everyone', async () => {
    const { client, get } = fakeClient([{ messages: [] }], { askerIsMember: false });
    await searchGuildMessages(client, GUILD, ASKER, { query: 'x' });
    expect(get.mock.calls[0][1].query.getAll('channel_id')).toEqual([PUBLIC, FORUM]);
  });

  it('fails closed when the member lookup errors for any other reason', async () => {
    const { client, get } = fakeClient([], { fetchFails: true });
    const r = await searchGuildMessages(client, GUILD, ASKER, { query: 'x' });
    expect(r.body.success).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  it('never reveals whether an opted-out author matched', async () => {
    const { client, get } = fakeClient([]);
    const r = await searchGuildMessages(client, GUILD, ASKER, { query: 'x', authorId: '300000000000000003' });
    expect(get).not.toHaveBeenCalled();
    expect(r.body).toEqual({ success: true, total: 0, results: [] });
  });

  it('reports the filtered count, not Discord\'s total', async () => {
    const { client } = fakeClient([
      { total_results: 40, messages: [[msg('m1', PUBLIC, '300000000000000003', 'x')], [msg('m2', PUBLIC, '300000000000000002', 'x')]] },
    ]);
    const r = await searchGuildMessages(client, GUILD, ASKER, { query: 'x' });
    expect(r.body.total).toBe(1);
  });

  it('asks Discord for a full page and trims after filtering', async () => {
    const { client, get } = fakeClient([
      { messages: [[msg('m1', PUBLIC, '300000000000000003', 'hidden')], [msg('m2', PUBLIC, '300000000000000002', 'seen')]] },
    ]);
    const r = await searchGuildMessages(client, GUILD, ASKER, { query: 'x', limit: 1 });
    expect(get.mock.calls[0][1].query.get('limit')).toBe('25');
    expect(r.body.results.map((h: any) => h.excerpt)).toEqual(['seen']);
  });

  it('a channel filter outside the allowed set searches nothing', async () => {
    const { client, get } = fakeClient([]);
    const r = await searchGuildMessages(client, GUILD, ASKER, { query: 'x', channelId: MODS });
    expect(get).not.toHaveBeenCalled();
    expect(r.body.results).toEqual([]);
  });

  it('drops opted-out and banned authors', async () => {
    const { client } = fakeClient([
      {
        messages: [
          [msg('m1', PUBLIC, '300000000000000003', 'opted out')],
          [msg('m2', PUBLIC, '300000000000000004', 'banned')],
          [msg('m3', PUBLIC, '300000000000000002', 'fine')],
        ],
      },
    ]);
    const r = await searchGuildMessages(client, GUILD, ASKER, { query: 'x' });
    expect(r.body.results.map((h: any) => h.excerpt)).toEqual(['fine']);
  });

  it('retries while the index warms, then gives up politely', async () => {
    vi.useFakeTimers();
    const warming = { code: 110000, retry_after: 0 };
    const { client, get } = fakeClient([warming, warming, warming]);
    const p = searchGuildMessages(client, GUILD, ASKER, { query: 'x' });
    await vi.runAllTimersAsync();
    const r = await p;
    vi.useRealTimers();
    expect(get).toHaveBeenCalledTimes(3);
    expect(r.body.note).toMatch(/indexing/);
  });

  it('searches forums by parent and keeps public posts under a readable parent', async () => {
    const { client, get } = fakeClient([
      {
        messages: [
          [msg('m1', ARCHIVED_POST, '300000000000000002', 'crash on load')],
          [msg('m2', '200000000000000006', '300000000000000002', 'mod-only thread')],
          [msg('m3', '200000000000000007', '300000000000000002', 'private post')],
        ],
        threads: [
          { id: ARCHIVED_POST, type: 11, parent_id: FORUM, name: 'Crash on load' },
          { id: '200000000000000006', type: 11, parent_id: MODS, name: 'mod thread' },
          { id: '200000000000000007', type: 12, parent_id: FORUM, name: 'private' },
        ],
      },
    ]);
    const r = await searchGuildMessages(client, GUILD, ASKER, { query: 'crash' });
    expect(get.mock.calls[0][1].query.getAll('channel_id')).toEqual([PUBLIC, FORUM]);
    expect(r.body.results.map((h: any) => h.channel)).toEqual(['Crash on load (in #bug-reports)']);
    expect(r.body.note).toMatch(/cannot read were not searched/);
  });

  it('reads further pages when hidden hits crowd a page, and flags more only for a real extra hit', async () => {
    const page = (n: number, tag: string) => Array.from({ length: n }, (_, i) => [msg(`${tag}${i}`, PUBLIC, '300000000000000002', 'x')]);
    const hiddenFirst = [[msg('h', PUBLIC, '300000000000000003', 'opted out')], ...page(24, 'a')];
    const { client, get } = fakeClient([{ messages: hiddenFirst }, { messages: page(2, 'b') }]);
    const r = await searchGuildMessages(client, GUILD, ASKER, { query: 'x', limit: 25 });
    expect(get.mock.calls[1][1].query.get('offset')).toBe('25');
    expect(r.body.results).toHaveLength(25);
    expect(r.body.more).toBe(true);
    const exact = fakeClient([{ messages: page(25, 'c') }, { messages: [] }]);
    expect((await searchGuildMessages(exact.client, GUILD, ASKER, { query: 'x', limit: 25 })).body.more).toBe(false);
  });

  it('a channel filter on an uncached thread checks its parent', async () => {
    const ok = fakeClient([{ messages: [] }]);
    await searchGuildMessages(ok.client, GUILD, ASKER, { query: 'x', channelId: ARCHIVED_POST });
    expect(ok.get.mock.calls[0][1].query.getAll('channel_id')).toEqual([ARCHIVED_POST]);
    const hidden = fakeClient([]);
    const r = await searchGuildMessages(hidden.client, GUILD, ASKER, { query: 'x', channelId: '200000000000000006' });
    expect(hidden.get).not.toHaveBeenCalled();
    expect(r.body.results).toEqual([]);
  });

  it('a moderator asking in a public channel never reaches mod channels; in #mods they do', async () => {
    const pub = fakeClient([{ messages: [] }], { askerIsMod: true });
    await searchGuildMessages(pub.client, GUILD, ASKER, { query: 'x', fromChannelId: PUBLIC });
    expect(pub.get.mock.calls[0][1].query.getAll('channel_id')).toEqual([PUBLIC, FORUM]);
    const unknown = fakeClient([{ messages: [] }], { askerIsMod: true });
    await searchGuildMessages(unknown.client, GUILD, ASKER, { query: 'x' });
    expect(unknown.get.mock.calls[0][1].query.getAll('channel_id')).toEqual([PUBLIC, FORUM]);
    const mods = fakeClient([{ messages: [] }], { askerIsMod: true });
    await searchGuildMessages(mods.client, GUILD, ASKER, { query: 'x', fromChannelId: MODS });
    expect(mods.get.mock.calls[0][1].query.getAll('channel_id')).toEqual([PUBLIC, MODS, FORUM]);
  });

  it('on a server that gates #general behind a member role, the role is the audience', () => {
    const everyone = { id: 'everyone' };
    const member = { id: 'member-role' };
    const mod = { id: 'mod-role' };
    const ch = (id: string, readers: string[]) => ({
      id,
      permissionsFor: (who: any) => perms(readers.includes(who.id)),
    });
    const general = ch('general', ['member-role', 'mod-role']);
    const art = ch('art', ['member-role', 'mod-role']);
    const modsRoom = ch('mods', ['mod-role']);
    const guild = {
      roles: { everyone, cache: new Map([['everyone', everyone], ['member-role', member], ['mod-role', mod]]) },
      channels: { cache: new Map([['general', general], ['art', art], ['mods', modsRoom]]) },
      members: { cache: new Map() },
    };
    const inGeneral = audienceCanRead(guild, 'general');
    expect(inGeneral(art)).toBe(true);
    expect(inGeneral(modsRoom)).toBe(false);
    expect(audienceCanRead(guild, 'mods')(modsRoom)).toBe(true);
    expect(audienceCanRead(guild, undefined)(art)).toBe(false);
  });

  it('leaves out channels that deny a single member or a non-everyone role', () => {
    const deny = (id: string) => ({ id, deny: { has: (p: string) => p === 'ViewChannel' } });
    const guild = { id: 'g', roles: { everyone: { id: 'g' } }, channels: { cache: new Map() } };
    const withOverwrites = (list: any[]) => ({ permissionOverwrites: { cache: new Map(list.map((o) => [o.id, o])) } });
    expect(hasTargetedDeny(guild, withOverwrites([deny('g')]))).toBe(false);
    expect(hasTargetedDeny(guild, withOverwrites([deny('muted-role')]))).toBe(true);
    expect(hasTargetedDeny(guild, withOverwrites([deny('300000000000000009')]))).toBe(true);
    // A restriction role also shut out of the conversation can't be in the audience.
    const general = withOverwrites([deny('muted-role')]);
    expect(hasTargetedDeny(guild, withOverwrites([deny('muted-role')]), general)).toBe(false);
    // ...unless some role allow on the conversation could let its holders back in.
    const gated = withOverwrites([deny('muted-role'), { id: 'member-role', type: 0, allow: { has: () => true } }]);
    expect(hasTargetedDeny(guild, withOverwrites([deny('muted-role')]), gated)).toBe(true);
  });

  it('a thread lookup outage is an error, not an empty result', async () => {
    const { client } = fakeClient([]);
    client.channels.fetch = vi.fn(async () => {
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    });
    const r = await searchGuildMessages(client, GUILD, ASKER, { query: 'x', channelId: '200000000000000009' });
    expect(r.body.success).toBe(false);
  });

  it('a before date earlier than Discord matches nothing', async () => {
    const { client, get } = fakeClient([]);
    const r = await searchGuildMessages(client, GUILD, ASKER, { query: 'x', before: '2014-01-01' });
    expect(get).not.toHaveBeenCalled();
    expect(r.body.total).toBe(0);
  });

  it('turns dates into snowflake bounds', () => {
    const q = buildSearchQuery({ query: 'x', after: '2026-05-01', before: 'nonsense' }, []);
    expect(BigInt(q.get('min_id')!) >> 22n).toBe(BigInt(Date.parse('2026-05-01') - 1420070400000));
    expect(q.has('max_id')).toBe(false);
    expect(snowflakeAt('2014-01-01')).toBeUndefined();
  });

  it('needs a query or an author', async () => {
    const { client } = fakeClient([]);
    const r = await searchGuildMessages(client, GUILD, ASKER, {});
    expect(r.status).toBe(400);
  });
});

describe('discord-search tool', () => {
  beforeEach(() => {
    gatewayMock.searchGuildMessages.mockReset();
    gatewayMock.searchGuildMessages.mockResolvedValue({ status: 200, body: { success: true, results: [] } });
  });

  it('takes the guild, asker and conversation channel from context, never from params', async () => {
    await searchHandler(
      { query: 'x', guildId: '999999999999999999', fromChannelId: MODS },
      { guildId: GUILD, userId: ASKER, channelId: PUBLIC }
    );
    expect(gatewayMock.searchGuildMessages).toHaveBeenCalledWith(
      GUILD,
      ASKER,
      expect.objectContaining({ query: 'x', fromChannelId: PUBLIC })
    );
  });

  it('does nothing in a DM', async () => {
    const out = JSON.parse(await searchHandler({ query: 'x', guildId: GUILD }, { userId: ASKER }));
    expect(out.success).toBe(false);
    expect(gatewayMock.searchGuildMessages).not.toHaveBeenCalled();
  });

  it('defaults to best match for words alone, newest first for a person', () => {
    expect(sortFor(undefined, 'map export', undefined)).toBe('relevance');
    expect(sortFor(undefined, 'map export', ASKER)).toBe('timestamp');
    expect(sortFor('timestamp', 'map export', undefined)).toBe('timestamp');
  });

  it('reads ids from mentions', () => {
    expect(snowflakeOf('<@272782606347796481>')).toBe('272782606347796481');
    expect(snowflakeOf('nobody')).toBeUndefined();
  });
});

describe('discord-channels read (readChannelMessages)', () => {
  it('reads a readable channel oldest first, with ids, minus opted-out authors', async () => {
    const { client } = fakeClient([]);
    const r = await readChannelMessages(client, GUILD, ASKER, { channelId: PUBLIC, fromChannelId: PUBLIC });
    expect(r.status).toBe(200);
    expect(r.body.messages.map((m: any) => [m.id, m.excerpt])).toEqual([
      ['m1', 'first'],
      ['m3', 'third'],
    ]);
  });

  it('a moderator asking in #general cannot read #mods, and nothing is fetched', async () => {
    const { client, modsFetch } = fakeClient([], { askerIsMod: true });
    const r = await readChannelMessages(client, GUILD, ASKER, { channelId: MODS, fromChannelId: PUBLIC });
    expect(r.status).toBe(403);
    expect(modsFetch).not.toHaveBeenCalled();
  });

  it('a forum parent says to read a post instead; no server means no read', async () => {
    const { client } = fakeClient([]);
    expect((await readChannelMessages(client, GUILD, ASKER, { channelId: FORUM, fromChannelId: PUBLIC })).status).toBe(400);
    expect((await readChannelMessages(client, null, ASKER, { channelId: PUBLIC })).status).toBe(400);
  });

  it('the tool takes server, person and conversation channel from context, defaulting to this channel', async () => {
    const readMock = gatewayMock.readChannelMessages;
    readMock.mockResolvedValue({ status: 200, body: { success: true, messages: [] } });
    await channelsHandler({ action: 'get_messages', guildId: '999999999999999999' }, { guildId: GUILD, userId: ASKER, channelId: PUBLIC });
    expect(readMock).toHaveBeenCalledWith(GUILD, ASKER, expect.objectContaining({ channelId: PUBLIC, fromChannelId: PUBLIC }));
    const dm = JSON.parse(await channelsHandler({ action: 'get_messages' }, { userId: ASKER }));
    expect(dm.success).toBe(false);
  });
});

describe('what a non-text message holds (Artie: blank excerpts)', () => {
  it('labels attachments, embeds and stickers', () => {
    expect(
      contentMarkers({
        attachments: [
          { filename: 'map.png', content_type: 'image/png' },
          { filename: 'memo.ogg', content_type: 'audio/ogg' },
          { filename: 'notes.pdf' },
        ],
        embeds: [{ title: 'Signal timing' }, {}],
        sticker_items: [{ name: 'wave' }],
      })
    ).toEqual(['[image: map.png]', '[audio: memo.ogg]', '[file: notes.pdf]', '[embed: Signal timing]', '[embed]', '[sticker: wave]']);
    expect(contentMarkers({})).toEqual([]);
    // A forward (flag 16384): no content of its own, the text is in the snapshot.
    expect(
      contentMarkers({ message_snapshots: [{ message: { content: 'v1.4 is out', embeds: [{ url: 'https://x.test/r' }] } }] })
    ).toEqual(['[forwarded: v1.4 is out [embed: https://x.test/r]]']);
    expect(contentMarkers({ message_snapshots: [{ message: {} }] })).toEqual(['[forwarded: a message]']);
  });
});

describe('where this turn is (Artie: "I don\'t know where I am")', () => {
  it('gives the ids his tools take, and only real ids', () => {
    expect(
      whereLines({ channelId: '300000000000000001', parentChannelId: '300000000000000002', parentChannelName: 'studio', messageId: '300000000000000003', replyingTo: '300000000000000004' })
    ).toEqual([
      '- Channel id: 300000000000000001 (the default for channel tools)',
      '- This is a thread off #studio (id 300000000000000002)',
      "- The message you're answering: id 300000000000000003",
      '- It replies to message id 300000000000000004',
    ]);
    expect(whereLines({ channelId: 'slack-C123', messageId: null })).toEqual([]);
    // A forum post is also a thread whose parent is the forum: the forum line wins.
    expect(
      whereLines({ forumId: '300000000000000005', forumName: 'ideas', parentChannelId: '300000000000000005', parentChannelName: 'ideas' })
    ).toEqual(['- This is a forum post in ideas (forum id 300000000000000005)']);
  });
});

describe('channel sources reach real turns (the assembler mocks source as "capabilities")', () => {
  it('a Discord context counts as a Discord turn whatever message.source says', () => {
    expect(isDiscordTurn({ source: 'capabilities', context: { platform: 'discord' } } as any)).toBe(true);
    expect(isDiscordTurn({ source: 'discord', context: undefined } as any)).toBe(true);
    expect(isDiscordTurn({ source: 'api', context: { guildId: '1' } } as any)).toBe(false);
  });

  it('channel vibes (with the where-am-I ids) land for the mock message assemble.ts builds', async () => {
    const sources: any[] = [];
    await addChannelVibes(
      {
        message: 'you here?',
        userId: '688448399879438340',
        id: 'context-gen',
        source: 'capabilities',
        respondTo: { type: 'api' },
        timestamp: new Date(),
        retryCount: 0,
        context: { platform: 'discord', channelId: '300000000000000001', channelName: 'general', messageId: '300000000000000003' },
      } as any,
      sources
    );
    expect(sources.map((s) => s.name)).toEqual(['channel_vibes']);
    expect(sources[0].content).toContain('- Channel id: 300000000000000001');
    expect(sources[0].content).toContain("- The message you're answering: id 300000000000000003");
  });
});

describe('which reads taint the turn (EJ: "skip the taint", search too on 2026-11-24)', () => {
  it('Discord reads do not taint; outside-web text still does', async () => {
    const { TAINTING_CAPABILITIES } = await import('../../src/engine/5-tool-loop/execute.js');
    for (const read of ['discord-search', 'discord-channels', 'discord-forums']) {
      expect(TAINTING_CAPABILITIES.has(read)).toBe(false);
    }
    for (const outside of ['http', 'web', 'github', 'reddit', 'mediawiki']) {
      expect(TAINTING_CAPABILITIES.has(outside)).toBe(true);
    }
  });
});
