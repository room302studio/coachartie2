/**
 * Moderation target resolution and error wording (2026-10-30: "salty pancakes" got
 * "Timeout failed" with no cause). The pure half is tested over plain objects; the route half
 * over a fake discord.js client.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parseUserRef,
  resolveByName,
  resolveUserRef,
  parseTimeoutMinutes,
  preflight,
  describeDiscordError,
  type MemberCandidate,
} from '../../src/gateway/routes/moderation-resolve.js';
import { timeoutMember, addRole, resolveTarget } from '../../src/gateway/routes/moderation.js';
import { failureFrom } from '../../src/engine/tools/discord/moderation.js';

const members: MemberCandidate[] = [
  { id: '111111111111111111', username: 'yellowaquarium', globalName: 'Yellow Aquarium', nickname: null },
  { id: '222222222222222222', username: 'pancake_42', globalName: 'Salty Pancakes', nickname: null },
  { id: '333333333333333333', username: 'sam', globalName: 'Sam', nickname: 'Chef' },
  { id: '444444444444444444', username: 'sam2', globalName: 'Dup', nickname: 'chef' },
];

describe('parseUserRef', () => {
  it('reads ids and both mention forms', () => {
    expect(parseUserRef('222222222222222222')).toEqual({ kind: 'id', id: '222222222222222222' });
    expect(parseUserRef('<@222222222222222222>')).toEqual({ kind: 'id', id: '222222222222222222' });
    expect(parseUserRef('<@!222222222222222222>')).toEqual({ kind: 'id', id: '222222222222222222' });
  });
  it('strips a leading @ from names and flags empties', () => {
    expect(parseUserRef('@sam')).toEqual({ kind: 'name', name: 'sam' });
    expect(parseUserRef('  ')).toEqual({ kind: 'empty' });
    expect(parseUserRef(undefined)).toEqual({ kind: 'empty' });
    expect(parseUserRef('@')).toEqual({ kind: 'empty' });
  });
});

describe('resolveByName', () => {
  it('matches username, display name and nickname case-insensitively', () => {
    expect(resolveByName('YellowAquarium', members)).toEqual({ ok: true, id: '111111111111111111' });
    expect(resolveByName('salty pancakes', members)).toEqual({ ok: true, id: '222222222222222222' });
    expect(resolveByName('@SAM2', members)).toEqual({ ok: true, id: '444444444444444444' });
  });
  it('fails an ambiguous name listing candidates with ids', () => {
    const r = resolveByName('chef', members);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('ambiguous');
      expect(r.candidates).toHaveLength(2);
      expect(r.error).toContain('333333333333333333');
      expect(r.error).toContain('444444444444444444');
    }
  });
  it('lists at most 5 candidates', () => {
    const many: MemberCandidate[] = Array.from({ length: 8 }, (_, i) => ({
      id: `5000000000000000${String(i).padStart(2, '0')}`,
      username: `u${i}`,
      nickname: 'twin',
    }));
    const r = resolveByName('twin', many);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.match(/\(id /g)).toHaveLength(5);
      expect(r.error).toContain('3 more');
    }
  });
  it('dedupes the same member seen twice (cache plus search)', () => {
    expect(resolveByName('sam', [members[2], members[2]])).toEqual({ ok: true, id: '333333333333333333' });
  });
  it('says not found, with near misses as hints', () => {
    const r = resolveByName('pancake', members);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('not_found');
      expect(r.status).toBe(404);
      expect(r.error).toContain('No member named "pancake"');
      expect(r.error).toContain('pancake_42');
    }
    const none = resolveByName('zzz', members);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).not.toContain('Closest');
  });
});

describe('resolveUserRef', () => {
  it('passes ids and mentions through without needing candidates', () => {
    expect(resolveUserRef('<@!999999999999999999>', [])).toEqual({ ok: true, id: '999999999999999999' });
  });
  it('rejects an empty reference plainly', () => {
    const r = resolveUserRef('', members);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('No user given');
  });
});

describe('parseTimeoutMinutes', () => {
  it('accepts 1-60 including numeric strings', () => {
    expect(parseTimeoutMinutes('5')).toEqual({ ok: true, minutes: 5 });
    expect(parseTimeoutMinutes(60)).toEqual({ ok: true, minutes: 60 });
  });
  it('rejects out of range and junk instead of clamping', () => {
    for (const bad of [0, 61, -5, 'abc', undefined, '']) {
      const r = parseTimeoutMinutes(bad);
      expect(r.ok, String(bad)).toBe(false);
    }
    const r = parseTimeoutMinutes(120);
    if (!r.ok) expect(r.error).toContain('out of range');
  });
});

describe('preflight', () => {
  it('blocks the owner and admins', () => {
    const owner = preflight({ action: 'timeout', targetName: 'Boss', targetIsOwner: true });
    expect(owner.ok).toBe(false);
    if (!owner.ok) expect(owner.error).toContain('own the server');
    const admin = preflight({ action: 'timeout', targetName: 'Adm', targetIsAdministrator: true });
    if (!admin.ok) expect(admin.error).toContain('Administrator');
    expect(admin.ok).toBe(false);
  });
  it('names the missing permission per action', () => {
    const t = preflight({ action: 'timeout', targetName: 'x', botHasPermission: false });
    const r = preflight({ action: 'role', targetName: 'x', botHasPermission: false });
    expect(!t.ok && t.error).toContain('Moderate Members');
    expect(!r.ok && r.error).toContain('Manage Roles');
  });
  it('blocks a target whose role is at or above the bot', () => {
    const r = preflight({ action: 'timeout', targetName: 'x', botHighestRolePosition: 5, targetHighestRolePosition: 5 });
    expect(!r.ok && r.error).toContain("at or above Artie's");
  });
  it('blocks a role above the bot, and lets unknowns through', () => {
    const r = preflight({ action: 'role', targetName: 'x', botHighestRolePosition: 5, rolePosition: 9, roleName: 'artie-enemy' });
    expect(!r.ok && r.error).toContain('artie-enemy');
    expect(preflight({ action: 'timeout', targetName: 'x' }).ok).toBe(true);
    expect(preflight({ action: 'timeout', targetName: 'x', botHighestRolePosition: 5, targetHighestRolePosition: 2 }).ok).toBe(true);
  });
});

describe('describeDiscordError', () => {
  it('maps API codes to causes', () => {
    expect(describeDiscordError({ code: 50013 }, 'Timeout failed')).toMatchObject({ status: 403 });
    expect(describeDiscordError({ code: 50013 }, 'Timeout failed').error).toContain('missing permissions');
    expect(describeDiscordError({ code: 10007 }, 'x').error).toContain('not a member');
    expect(describeDiscordError({ code: 50035 }, 'x').error).toContain('28 days');
  });
  it('handles rate limits and 403s by status', () => {
    expect(describeDiscordError({ status: 429 }, 'x').status).toBe(429);
    expect(describeDiscordError({ status: 403 }, 'x').error).toContain('403');
  });
  it('keeps the message for unknown errors, never a bare failure', () => {
    expect(describeDiscordError(new Error('socket hang up'), 'Timeout failed').error).toBe('Timeout failed: socket hang up');
    expect(describeDiscordError(null, 'Timeout failed').error).toContain('unknown error');
  });
});

describe('engine failureFrom', () => {
  it('passes the gateway cause through verbatim', () => {
    const out = JSON.parse(failureFrom({ status: 404, body: { error: 'No member named "x"' } }));
    expect(out).toEqual({ success: false, error: 'No member named "x"' });
  });
  it('still gives a cause when the body is empty', () => {
    const out = JSON.parse(failureFrom({ status: 500, body: {} }));
    expect(out.error).toContain('500');
  });
});

function fakeMember(m: MemberCandidate) {
  return { id: m.id, nickname: m.nickname, user: { id: m.id, username: m.username, globalName: m.globalName } };
}

function fakeClient(opts: { timeout?: () => Promise<unknown>; withSearch?: boolean } = {}) {
  const cache = new Map(members.map((m) => [m.id, fakeMember(m)]));
  const target = {
    ...fakeMember(members[1]),
    displayName: 'Salty Pancakes',
    user: { id: members[1].id, username: 'pancake_42', globalName: 'Salty Pancakes', bot: false, tag: 'p#1' },
    roles: { cache: { some: () => false }, highest: { position: 1 } },
    permissions: { has: () => false },
    guild: { ownerId: 'someone-else', members: { me: { permissions: { has: () => true }, roles: { highest: { position: 10 } } } } },
    timeout: vi.fn(opts.timeout ?? (async () => undefined)),
  };
  const search = vi.fn(async () => new Map());
  const guild: any = {
    members: {
      cache,
      fetch: vi.fn(async (id: string) => {
        if (id === members[1].id) return target;
        return null;
      }),
    },
  };
  // discord.js always has members.search; a complete (empty, under-limit) result by default.
  guild.members.search = search;
  return { client: { guilds: { cache: { get: () => guild } } }, target, search };
}

describe('resolveTarget (fake discord.js client)', () => {
  it('finds a display name in the member cache', async () => {
    const { client } = fakeClient();
    expect(await resolveTarget(client, 'g', 'salty pancakes')).toEqual({ ok: true, id: members[1].id });
  });
  it('uses REST search too, without fetching the whole member list', async () => {
    const { client, search } = fakeClient({ withSearch: true });
    await resolveTarget(client, 'g', 'nobody-here');
    expect(search).toHaveBeenCalledWith({ query: 'nobody-here', limit: 25 });
  });
  it('reports ambiguity from the cache', async () => {
    const { client } = fakeClient();
    const r = await resolveTarget(client, 'g', 'chef');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ambiguous');
  });
  // Codex: an incomplete search could hide a second member with the same name.
  it('a failed member search means a name match is not trusted (asks for a mention/id)', async () => {
    const { client, search } = fakeClient();
    search.mockRejectedValueOnce(new Error('rate limited'));
    const r = await resolveTarget(client, 'g', 'salty pancakes');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('uncertain');
  });
  it('a search that hits its result cap is not trusted either', async () => {
    const { client, search } = fakeClient();
    const full = new Map(Array.from({ length: 25 }, (_, i) => [`x${i}`, { id: `9000000000000000${i}`, user: { id: `9000000000000000${i}`, username: `other${i}` } }]));
    search.mockResolvedValueOnce(full as any);
    const r = await resolveTarget(client, 'g', 'salty pancakes');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('uncertain');
  });
  it('an id or mention never needs the search', async () => {
    const { client, search } = fakeClient();
    search.mockRejectedValueOnce(new Error('down'));
    expect(await resolveTarget(client, 'g', `<@${members[1].id}>`)).toEqual({ ok: true, id: members[1].id });
  });
});

describe('timeoutMember errors', () => {
  const unique = () => `guild-resolve-${Date.now()}-${Math.random()}`;

  it('turns a 50013 from discord.js into a permission explanation, not "Timeout failed"', async () => {
    const { client } = fakeClient({
      timeout: async () => {
        throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
      },
    });
    const r = await timeoutMember(client, { guildId: unique(), userId: 'salty pancakes', durationMinutes: 5, reason: 'off-topic' });
    expect(r.status).toBe(403);
    expect((r.body as any).error).toContain('missing permissions');
  });

  it('names a not-found display name', async () => {
    const { client } = fakeClient();
    const r = await timeoutMember(client, { guildId: unique(), user: 'ghost', durationMinutes: 5, reason: 'x' });
    expect(r.status).toBe(404);
    expect((r.body as any).error).toContain('No member named "ghost"');
  });

  it('rejects an out-of-range duration before touching Discord', async () => {
    const { client, target } = fakeClient();
    const r = await timeoutMember(client, { guildId: unique(), user: 'salty pancakes', durationMinutes: 500, reason: 'x' });
    expect(r.status).toBe(400);
    expect((r.body as any).error).toContain('out of range');
    expect(target.timeout).not.toHaveBeenCalled();
  });

  it('refuses a target above the bot with the role explanation', async () => {
    const { client, target } = fakeClient();
    target.roles.highest.position = 10;
    const r = await timeoutMember(client, { guildId: unique(), user: 'salty pancakes', durationMinutes: 5, reason: 'x' });
    expect(r.status).toBe(403);
    expect((r.body as any).error).toContain("at or above Artie's");
    expect(target.timeout).not.toHaveBeenCalled();
  });

  it('resolves a display name and times them out', async () => {
    const { client, target } = fakeClient();
    const r = await timeoutMember(client, { guildId: unique(), user: 'Salty Pancakes', durationMinutes: 5, reason: 'off-topic' });
    expect(r.status).toBe(200);
    expect(target.timeout).toHaveBeenCalledWith(5 * 60_000, 'off-topic');
  });
});

describe('addRole uses the same resolver', () => {
  it('says not found for an unknown name', async () => {
    const { client } = fakeClient();
    const r = await addRole(client, { guildId: 'g', user: 'ghost', roleName: 'artie-enemy' });
    expect(r.status).toBe(404);
    expect((r.body as any).error).toContain('No member named "ghost"');
  });
});

describe('moderation in a DM', () => {
  it('refuses to act on anyone without a server (no Subway Builder fallback from DMs)', async () => {
    const { discordModerationCapability } = await import('../../src/engine/tools/discord/moderation.js');
    for (const action of ['timeout', 'add_enemy_role', 'remove_enemy_role']) {
      const out = await discordModerationCapability.handler(
        { action, user: 'someone', durationMinutes: 5, reason: 'x' },
        undefined,
        { userId: 'dm-user', channelId: 'dm-channel' }
      );
      expect(JSON.parse(out as string).error, action).toMatch(/not in a DM/);
    }
  });
});
