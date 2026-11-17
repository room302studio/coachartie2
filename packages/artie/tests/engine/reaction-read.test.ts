import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/gateway/api.js', () => ({
  addReaction: vi.fn(),
  readMessageReactions: vi.fn(),
  isOk: (r: any) => r.status >= 200 && r.status < 300,
}));

import * as gateway from '../../src/gateway/api.js';
import {
  insertReaction,
  listStandingReactions,
  pruneReactions,
  REACTION_RETENTION_MS,
} from '../../src/shared/db/reaction-store.js';
import { getSyncDb } from '../../src/shared/db/client.js';
import {
  discordReactionCapability,
  snippetOf,
  ageLabel,
  formatPersisted,
} from '../../src/engine/tools/discord/reaction.js';

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;

function add(over: Partial<Parameters<typeof insertReaction>[0]> = {}) {
  insertReaction({
    guildId: 'g1',
    channelId: 'c1',
    messageId: 'm1',
    emoji: '👍',
    userId: 'u1',
    userLabel: 'Alice',
    messageExcerpt: 'hello world',
    action: 'added',
    at: NOW - 5 * MIN,
    ...over,
  });
}

function run(params: any, ctx: any): Promise<any> {
  return discordReactionCapability
    .handler({ action: 'read', ...params }, undefined, ctx)
    .then((s: string) => JSON.parse(s));
}

beforeEach(() => {
  getSyncDb().run(`DELETE FROM reaction_log`);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(gateway.readMessageReactions).mockReset();
});

// Table exists after first touch; create it before the first DELETE.
listStandingReactions({ channelId: 'x', sinceMs: 1 });

describe('reaction store: persistence and pruning', () => {
  it('persists and reads back standing reactions', () => {
    add();
    add({ userId: 'u2', userLabel: 'Bob', emoji: '🔥' });
    const rows = listStandingReactions({ guildId: 'g1', channelId: 'c1', sinceMs: 60 * MIN, now: NOW });
    expect(rows.map((r) => r.userLabel).sort()).toEqual(['Alice', 'Bob']);
  });

  it('a later removal cancels an add; a re-add restores it', () => {
    add({ at: NOW - 10 * MIN });
    add({ action: 'removed', at: NOW - 8 * MIN });
    const q = { guildId: 'g1', channelId: 'c1', sinceMs: 60 * MIN, now: NOW };
    expect(listStandingReactions(q)).toEqual([]);
    add({ at: NOW - 2 * MIN });
    expect(listStandingReactions(q)).toHaveLength(1);
  });

  it('prunes rows older than 14 days and keeps newer ones', () => {
    add({ messageId: 'old', at: NOW - REACTION_RETENTION_MS - MIN });
    add({ messageId: 'new', at: NOW - 13 * 24 * 60 * MIN });
    expect(pruneReactions(NOW)).toBe(1);
    const left = getSyncDb().all<{ message_id: string }>(`SELECT message_id FROM reaction_log`);
    expect(left.map((r) => r.message_id)).toEqual(['new']);
  });
});

describe('reaction read: scope isolation', () => {
  it('never returns another guild or another channel (channel scope)', async () => {
    add({ messageId: 'mine' });
    add({ messageId: 'other-guild', guildId: 'g2', channelId: 'c9' });
    add({ messageId: 'other-channel', channelId: 'c2' });
    const out = await run({}, { guildId: 'g1', channelId: 'c1' });
    expect(out.messages.map((m: any) => m.message_id)).toEqual(['mine']);
  });

  it('guild scope widens to the guild but never past it', async () => {
    add({ messageId: 'mine' });
    add({ messageId: 'sibling', channelId: 'c2' });
    add({ messageId: 'other-guild', guildId: 'g2', channelId: 'c9' });
    const out = await run({ scope: 'guild' }, { guildId: 'g1', channelId: 'c1' });
    expect(out.messages.map((m: any) => m.message_id).sort()).toEqual(['mine', 'sibling']);
  });

  it('model-supplied guild/channel params are ignored', async () => {
    add({ messageId: 'other-guild', guildId: 'g2', channelId: 'c9' });
    const out = await run({ guildId: 'g2', channelId: 'c9', guild_id: 'g2' }, { guildId: 'g1', channelId: 'c1' });
    expect(out.messages).toEqual([]);
  });

  it('a DM sees only its own channel, and never guild rows, even with scope guild', async () => {
    add({ messageId: 'dm', guildId: null, channelId: 'dm1' });
    add({ messageId: 'dm-other', guildId: null, channelId: 'dm2' });
    add({ messageId: 'guild-msg', guildId: 'g1', channelId: 'dm1' });
    const out = await run({ scope: 'guild' }, { channelId: 'dm1' });
    expect(out.messages.map((m: any) => m.message_id)).toEqual(['dm']);
  });

  it('live read passes the conversation scope, not the model params', async () => {
    vi.mocked(gateway.readMessageReactions).mockResolvedValue({
      status: 200,
      body: {
        success: true,
        message: {
          messageId: 'm1',
          channelId: 'c1',
          snippet: 'hi',
          createdAt: NOW - 3 * MIN,
          reactions: [{ emoji: '🔥', count: 2, who: ['A', 'B'] }],
        },
      },
    });
    const out = await run({ message_id: 'm1', channelId: 'evil' }, { guildId: 'g1', channelId: 'c1' });
    expect(gateway.readMessageReactions).toHaveBeenCalledWith('c1', 'm1', 'g1');
    expect(out.source).toBe('live');
    expect(out.messages[0].reactions[0]).toEqual({ emoji: '🔥', count: 2, who: ['A', 'B'] });
  });

  it('live failure falls back to the log, still scoped', async () => {
    vi.mocked(gateway.readMessageReactions).mockResolvedValue({ status: 404, body: { success: false } });
    add({ messageId: 'm1' });
    add({ messageId: 'm1', guildId: 'g2', channelId: 'c9' });
    const out = await run({ message_id: 'm1' }, { guildId: 'g1', channelId: 'c1' });
    expect(out.source).toBe('log');
    expect(out.messages[0].reactions[0].count).toBe(1);
  });
});

describe('recordReaction writes through to the table', () => {
  it('persists adds, logs removals, keeps removals out of the prompt buffer', async () => {
    const { recordReaction, getRecentReactions, resetReactionLog } = await import(
      '../../src/gateway/1-receive/reaction-log.js'
    );
    resetReactionLog();
    const base = { messageId: 'mm', channelId: 'c1', emoji: '🪳', userLabel: 'Zed', guildId: 'g1', userId: 'z' };
    recordReaction({ ...base, at: NOW - 2 * MIN });
    expect(getRecentReactions('c1', NOW)).toHaveLength(1);
    expect(listStandingReactions({ guildId: 'g1', channelId: 'c1', sinceMs: 60 * MIN, now: NOW })).toHaveLength(1);
    recordReaction({ ...base, action: 'removed', at: NOW - MIN });
    expect(getRecentReactions('c1', NOW)).toHaveLength(1);
    expect(listStandingReactions({ guildId: 'g1', channelId: 'c1', sinceMs: 60 * MIN, now: NOW })).toHaveLength(0);
  });
});

describe('reaction read: formatting', () => {
  it('truncates snippets to 80 chars and flattens whitespace', () => {
    expect(snippetOf('a\n\nb')).toBe('a b');
    const s = snippetOf('x'.repeat(200));
    expect(s.length).toBe(80);
    expect(s.endsWith('...')).toBe(true);
  });

  it('labels ages', () => {
    expect(ageLabel(NOW, NOW)).toBe('just now');
    expect(ageLabel(NOW - 5 * MIN, NOW)).toBe('5m ago');
    expect(ageLabel(NOW - 180 * MIN, NOW)).toBe('3h ago');
    expect(ageLabel(NOW - 4 * 24 * 60 * MIN, NOW)).toBe('4d ago');
  });

  it('groups by message then emoji with counts and names', () => {
    const rows = [
      { guildId: 'g', channelId: 'c', messageId: 'm1', emoji: '👍', userId: 'a', userLabel: 'Alice', messageExcerpt: 'hi', action: 'added' as const, at: NOW - MIN },
      { guildId: 'g', channelId: 'c', messageId: 'm1', emoji: '👍', userId: 'b', userLabel: 'Bob', action: 'added' as const, at: NOW - 2 * MIN },
      { guildId: 'g', channelId: 'c', messageId: 'm1', emoji: '🔥', userId: 'a', userLabel: 'Alice', action: 'added' as const, at: NOW - 3 * MIN },
    ];
    const out = formatPersisted(rows, NOW, 10);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ message_id: 'm1', snippet: 'hi', age: '1m ago' });
    expect(out[0].reactions[0]).toEqual({ emoji: '👍', count: 2, who: ['Alice', 'Bob'] });
  });
});

describe('reaction tool declaration', () => {
  it('declares react (discord) and read (read)', () => {
    expect(discordReactionCapability.supportedActions).toEqual(['react', 'read']);
    expect(discordReactionCapability.actions?.react.effect).toBe('discord');
    expect(discordReactionCapability.actions?.read.effect).toBe('read');
  });
});

// Codex 2026-11-17 on the merge.
describe('emoji identity and bulk removals', () => {
  const q = () => listStandingReactions({ guildId: 'g1', channelId: 'c1', sinceMs: 60 * MIN, now: NOW });

  it('two custom emojis with the same name stay separate; removing one keeps the other', async () => {
    const { emojiKey } = await import('../../src/gateway/1-receive/reaction-log.js');
    add({ emoji: emojiKey('party', '111111111') });
    add({ emoji: emojiKey('party', '222222222') });
    add({ emoji: emojiKey('party', '111111111'), action: 'removed', at: NOW - 4 * MIN });
    const rows = q();
    expect(rows).toHaveLength(1);
    expect(rows[0].emoji).toBe(':party:');
  });

  it('clearing all reactions, or one emoji, drops them from read', async () => {
    const { clearLoggedReactions } = await import('../../src/gateway/1-receive/reaction-log.js');
    add({ emoji: '👍' });
    add({ emoji: '🔥' });
    add({ emoji: '👍', messageId: 'm2' });
    clearLoggedReactions('c1', 'm1', '👍');
    expect(q().map((r) => `${r.messageId}${r.emoji}`).sort()).toEqual(['m1🔥', 'm2👍']);
    clearLoggedReactions('c1', 'm1');
    expect(q().map((r) => r.messageId)).toEqual(['m2']);
  });
});
