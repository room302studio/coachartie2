/**
 * discord-reaction rollup (2026-11-19): the privacy rule is the point, so that's what's pinned.
 * Never a reactor's name or id; opted-out and banned people left out; reply text only from the
 * text channel when one is given; removals counted as taken back.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../src/shared/privacy-opt-out.js', () => ({
  isOptedOut: (id?: string | null) => id === 'u-optout',
}));
vi.mock('../../../../src/shared/blocklist.js', () => ({
  isBlockedUser: (id?: string | null) => id === 'u-banned',
}));

import { buildRollup } from '../../../../src/engine/capabilities/discord/reaction.js';
import type { PersistedReaction } from '../../../../src/shared/db/reaction-store.js';

const NOW = 1_000_000_000;

function ev(over: Partial<PersistedReaction>): PersistedReaction {
  return {
    guildId: 'g1',
    channelId: 'c1',
    messageId: 'm1',
    emoji: '👍',
    emojiLabel: '👍',
    userId: 'u-asker',
    userLabel: 'Asker Name',
    messageExcerpt: 'here is how the metro file loads',
    action: 'added',
    at: NOW - 1000,
    ...over,
  };
}

describe('buildRollup', () => {
  it('counts by role, never names anyone, and drops opted-out and banned reactors', () => {
    const rows = [
      ev({ reactorRole: 'asker', messageExcerpt: 'thanks Asker Name and <@u-other>, here is how the metro file loads' }),
      ev({ userId: 'u-other', userLabel: 'Bystander Name', reactorRole: 'other' }),
      ev({ userId: 'u-optout', userLabel: 'Private Person', reactorRole: 'other' }),
      ev({ userId: 'u-banned', userLabel: 'Banned Person', reactorRole: 'other' }),
    ];
    const out = buildRollup(rows, NOW, 10, null);
    expect(out.totals).toEqual([{ emoji: '👍', count: 2, from_asker: 1, from_others: 1, unknown: 0 }]);
    const text = JSON.stringify(out);
    for (const leak of ['Asker Name', 'Bystander Name', 'Private Person', 'u-asker', 'u-other', 'u-optout']) {
      expect(text).not.toContain(leak);
    }
    expect(out.messages[0].snippet).toContain('metro file');
  });

  it('counts a removal after an add as taken back, and it no longer stands', () => {
    const rows = [ev({ emoji: '👎', emojiLabel: '👎' }), ev({ emoji: '👎', emojiLabel: '👎', action: 'removed', at: NOW - 500 })];
    const out = buildRollup(rows, NOW, 10, null);
    expect(out.taken_back).toBe(1);
    expect(out.totals).toEqual([]);
    expect(out.messages).toMatchObject([{ message_id: 'm1', taken_back: 1, reactions: [] }]);
  });

  it('in a server shows reply text only from the current channel', () => {
    const rows = [ev({}), ev({ channelId: 'c-private', messageId: 'm2', messageExcerpt: 'secret mod channel reply' })];
    const out = buildRollup(rows, NOW, 10, 'c1');
    expect(out.totals[0].count).toBe(2);
    expect(out.counted_without_text).toBe(1);
    expect(JSON.stringify(out)).not.toContain('secret mod channel');
  });
});
