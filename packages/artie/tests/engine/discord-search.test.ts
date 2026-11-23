import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/shared/privacy-opt-out.js', () => ({
  isOptedOut: (id: string) => id === '300000000000000003',
}));
vi.mock('../../src/shared/blocklist.js', () => ({
  isBlockedUser: (id: string) => id === '300000000000000004',
}));

const gatewayMock = vi.hoisted(() => ({ searchGuildMessages: vi.fn() }));
vi.mock('../../src/gateway/api.js', () => gatewayMock);

import {
  searchGuildMessages,
  buildSearchQuery,
  pickHits,
  clampLimit,
  excerptOf,
} from '../../src/gateway/routes/message-search.js';
import { searchHandler, snowflakeOf } from '../../src/engine/tools/discord/search.js';

const GUILD = '100000000000000001';
const PUBLIC = '200000000000000001';
const MODS = '200000000000000002';
const PRIVATE_THREAD = '200000000000000003';
const ASKER = '300000000000000001';

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

function fakeClient(searchBodies: any[], opts: { askerIsMember?: boolean; fetchFails?: boolean } = {}) {
  const everyone = { id: 'everyone' };
  const me = { id: 'artie' };
  const asker = { id: ASKER };
  const channels = new Map<string, any>([
    [PUBLIC, channel(PUBLIC, 'general', () => true)],
    // Mods: Artie can read it, the asker and @everyone can't.
    [MODS, channel(MODS, 'mods', (who) => who === 'artie')],
    [PRIVATE_THREAD, channel(PRIVATE_THREAD, 'secret-thread', () => true, 12)],
  ]);
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
    client: { guilds: { cache: new Map([[GUILD, guild]]) }, rest: { get } } as any,
    get,
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
    expect(sent.getAll('channel_id')).toEqual([PUBLIC]);
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
    expect(get.mock.calls[0][1].query.getAll('channel_id')).toEqual([PUBLIC]);
  });

  it('a confirmed non-member (Unknown Member) is judged as @everyone', async () => {
    const { client, get } = fakeClient([{ messages: [] }], { askerIsMember: false });
    await searchGuildMessages(client, GUILD, ASKER, { query: 'x' });
    expect(get.mock.calls[0][1].query.getAll('channel_id')).toEqual([PUBLIC]);
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

  it('takes the guild and asker from context, never from params', async () => {
    await searchHandler({ query: 'x', guildId: '999999999999999999' }, { guildId: GUILD, userId: ASKER });
    expect(gatewayMock.searchGuildMessages).toHaveBeenCalledWith(GUILD, ASKER, expect.objectContaining({ query: 'x' }));
  });

  it('does nothing in a DM', async () => {
    const out = JSON.parse(await searchHandler({ query: 'x', guildId: GUILD }, { userId: ASKER }));
    expect(out.success).toBe(false);
    expect(gatewayMock.searchGuildMessages).not.toHaveBeenCalled();
  });

  it('reads ids from mentions', () => {
    expect(snowflakeOf('<@272782606347796481>')).toBe('272782606347796481');
    expect(snowflakeOf('nobody')).toBeUndefined();
  });
});
