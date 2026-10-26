/**
 * Security audit 2026-10-26 (sec-authority.md MEDIUM — autonomous moderation is fully
 * LLM-discretionary with no human sign-off). The feature stays, but an Artie-initiated
 * timeout is now capped: at most 1 per target per 24h, at most 3 per guild per hour.
 */
import { describe, it, expect, vi } from 'vitest';
import { timeoutMember } from '../../src/gateway/routes/moderation.js';
import { moderationService } from '../../src/gateway/routes/moderation-service.js';

function makeMember(username: string) {
  return {
    user: { bot: false, username, tag: `${username}#0001` },
    displayName: username,
    roles: { cache: { some: () => false } },
    timeout: vi.fn().mockResolvedValue(undefined),
  };
}

function makeClient(members: Record<string, ReturnType<typeof makeMember>>) {
  const guild = {
    members: {
      fetch: vi.fn(async (userId: string) => members[userId] ?? null),
    },
  };
  return { guilds: { cache: { get: () => guild } } };
}

describe('autonomous timeout rate limits', () => {
  it('refuses a second timeout on the same target within 24h', async () => {
    const guildId = `guild-rl-target-${Date.now()}`;
    const targetId = `target-rl-${Date.now()}`;
    const client = makeClient({ [targetId]: makeMember('target') });

    const first = await timeoutMember(client as any, {
      guildId,
      userId: targetId,
      durationMinutes: 5,
      reason: 'test',
    });
    expect(first.status).toBe(200);

    const second = await timeoutMember(client as any, {
      guildId,
      userId: targetId,
      durationMinutes: 5,
      reason: 'test again',
    });
    expect(second.status).toBe(429);
    expect(JSON.stringify(second.body)).toContain('24h');
  });

  it('refuses the 4th autonomous timeout in a guild within an hour, even for new targets', async () => {
    const guildId = `guild-rl-guildcap-${Date.now()}`;
    const targets = ['a', 'b', 'c', 'd'].map((suffix) => `target-${suffix}-${Date.now()}`);
    const members: Record<string, ReturnType<typeof makeMember>> = {};
    for (const t of targets) members[t] = makeMember(t);
    const client = makeClient(members);

    const results = [];
    for (const t of targets) {
      results.push(
        await timeoutMember(client as any, {
          guildId,
          userId: t,
          durationMinutes: 5,
          reason: 'test',
        })
      );
    }

    expect(results[0].status).toBe(200);
    expect(results[1].status).toBe(200);
    expect(results[2].status).toBe(200);
    expect(results[3].status).toBe(429);
    expect(JSON.stringify(results[3].body)).toContain('hour');
  });

  it('a different guild is not affected by another guild hitting its cap', async () => {
    const busyGuild = `guild-busy-${Date.now()}`;
    const quietGuild = `guild-quiet-${Date.now()}`;
    const targets = ['a', 'b', 'c'].map((s) => `t-${s}-${Date.now()}`);
    const quietTarget = `t-quiet-${Date.now()}`;
    const members: Record<string, ReturnType<typeof makeMember>> = {};
    for (const t of [...targets, quietTarget]) members[t] = makeMember(t);
    const client = makeClient(members);

    for (const t of targets) {
      await timeoutMember(client as any, { guildId: busyGuild, userId: t, durationMinutes: 5, reason: 'x' });
    }

    const quiet = await timeoutMember(client as any, {
      guildId: quietGuild,
      userId: quietTarget,
      durationMinutes: 5,
      reason: 'x',
    });
    expect(quiet.status).toBe(200);
  });
});

describe('moderationService autonomous-timeout counters', () => {
  it('counts only rows within the window', () => {
    const target = `counter-target-${Date.now()}`;
    const guildId = `counter-guild-${Date.now()}`;
    moderationService.recordAutonomousTimeout(target, guildId);
    moderationService.recordAutonomousTimeout(target, guildId);

    const since = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(moderationService.countAutonomousTimeoutsForTarget(target, since)).toBe(2);
    expect(moderationService.countAutonomousTimeoutsForTarget(target, future)).toBe(0);
    expect(moderationService.countAutonomousTimeoutsForGuild(guildId, since)).toBe(2);
    expect(moderationService.countAutonomousTimeoutsForGuild(undefined, since)).toBe(0);
  });
});
