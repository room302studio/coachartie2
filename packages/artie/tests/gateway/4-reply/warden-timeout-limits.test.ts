/**
 * W9 (state-machine audit 2026-10-31): the warden timeout ([TIMEOUT] marker, antibody) used
 * only a 2-minute in-memory cooldown, stamped AFTER the await, and skipped the moderation
 * service's DB limiter (1 per target per 24h, 3 per guild per hour) and its audit log.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { getRawDb } from '../../../src/shared/db/client.js';
import { wardenTimeout } from '../../../src/gateway/4-reply/discord-reply.js';
import { SUBWAY_BUILDER_GUILD_ID } from '../../../src/gateway/4-reply/outbound-gate.js';

// prod's `.schema moderation_audit`, verbatim (nothing in the codebase creates it)
beforeAll(() => {
  getRawDb().exec(`CREATE TABLE IF NOT EXISTS moderation_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issued_by_user_id TEXT NOT NULL,
    issued_by_name TEXT,
    target_user_id TEXT NOT NULL,
    target_username TEXT,
    action TEXT NOT NULL,
    duration_minutes INTEGER,
    reason TEXT,
    discord_until TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    revoked_at TIMESTAMP,
    status TEXT DEFAULT "active"
  )`);
});

afterEach(() => {
  vi.useRealTimers();
});

let n = 0;
function makeMessage(timeoutImpl: () => Promise<unknown> = async () => undefined) {
  n += 1;
  const id = `90000000000000${String(n).padStart(4, '0')}`;
  const member = {
    id,
    user: { bot: false, username: `spammer${n}`, tag: `spammer${n}#0001` },
    displayName: `spammer${n}`,
    roles: { cache: { some: () => false } },
    guild: { id: SUBWAY_BUILDER_GUILD_ID },
    timeout: vi.fn(timeoutImpl),
  };
  const message = {
    guildId: SUBWAY_BUILDER_GUILD_ID,
    channel: { isDMBased: () => false, name: 'coach-artie' },
    author: { tag: member.user.tag, id },
    member,
  };
  return { message: message as never, member };
}

function auditRows(targetId: string): number {
  const row = getRawDb()
    .prepare(`SELECT COUNT(*) AS n FROM moderation_audit WHERE target_user_id = ?`)
    .get(targetId) as { n: number };
  return row.n;
}

describe('wardenTimeout', () => {
  it('lands once, is audited, and the DB limit refuses a second within 24h', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
    const { message, member } = makeMessage();

    expect(await wardenTimeout(message, 60, 'spam', 't1')).toBe(true);
    expect(auditRows(member.id)).toBe(1);

    // past the 2-minute in-memory cooldown, but inside the 24h DB window
    vi.setSystemTime(new Date('2026-10-31T12:10:00Z'));
    expect(await wardenTimeout(message, 60, 'spam again', 't2')).toBe(false);
    expect(member.timeout).toHaveBeenCalledTimes(1);
  });

  it('two racing timeouts for the same person land once', async () => {
    let release: () => void = () => {};
    const { message, member } = makeMessage(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const first = wardenTimeout(message, 60, 'spam', 'r1');
    const second = wardenTimeout(message, 60, 'spam', 'r2');
    release();
    expect(await Promise.all([first, second])).toEqual([true, false]);
    expect(member.timeout).toHaveBeenCalledTimes(1);
  });

  it('a lost casino stake is audited but does not count toward the discipline limit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T12:00:00Z'));
    const { message, member } = makeMessage();

    expect(await wardenTimeout(message, 30, 'roulette', 'g1', { game: true })).toBe(true);
    expect(auditRows(member.id)).toBe(1);
    vi.setSystemTime(new Date('2026-11-01T12:10:00Z'));
    expect(await wardenTimeout(message, 60, 'spam', 'g2')).toBe(true);
  });
});
