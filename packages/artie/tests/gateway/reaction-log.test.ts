import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordReaction,
  getRecentReactions,
  resetReactionLog,
  formatRecentReactionsNote,
} from '../../src/gateway/1-receive/reaction-log.js';

describe('reaction log', () => {
  beforeEach(() => resetReactionLog());

  it('records and reads back reactions for a channel', () => {
    recordReaction({
      messageId: 'm1',
      channelId: 'c1',
      emoji: '👎',
      userLabel: 'Bob',
      at: 1000,
    });
    expect(getRecentReactions('c1', 1000)).toHaveLength(1);
  });

  it('excludes reactions older than the window', () => {
    recordReaction({ messageId: 'm1', channelId: 'c1', emoji: '👍', userLabel: 'Bob', at: 0 });
    const THIRTY_ONE_MIN = 31 * 60 * 1000;
    expect(getRecentReactions('c1', THIRTY_ONE_MIN)).toEqual([]);
  });

  it('keeps the 30-minute window boundary inclusive-ish but excludes well past it', () => {
    recordReaction({ messageId: 'm1', channelId: 'c1', emoji: '👍', userLabel: 'Bob', at: 1000 });
    const TWENTY_NINE_MIN_LATER = 1000 + 29 * 60 * 1000;
    expect(getRecentReactions('c1', TWENTY_NINE_MIN_LATER)).toHaveLength(1);
  });

  it('keeps channels separate', () => {
    recordReaction({ messageId: 'm1', channelId: 'c1', emoji: '👍', userLabel: 'Bob', at: 1000 });
    recordReaction({ messageId: 'm2', channelId: 'c2', emoji: '👎', userLabel: 'Carol', at: 1000 });
    expect(getRecentReactions('c1', 1000)).toHaveLength(1);
    expect(getRecentReactions('c2', 1000)).toHaveLength(1);
  });

  it('caps entries per channel', () => {
    for (let i = 0; i < 80; i++) {
      recordReaction({ messageId: `m${i}`, channelId: 'c1', emoji: '👍', userLabel: 'Bob', at: i });
    }
    expect(getRecentReactions('c1', 1000).length).toBeLessThanOrEqual(50);
  });
});

describe('formatRecentReactionsNote', () => {
  it('is undefined with nothing to show', () => {
    expect(formatRecentReactionsNote([])).toBeUndefined();
  });

  it('names the reactor, emoji, and age', () => {
    const note = formatRecentReactionsNote(
      [{ messageId: 'm1', channelId: 'c1', emoji: '👎', userLabel: 'Bob', at: 0 }],
      5 * 60 * 1000 // 5 minutes later
    );
    expect(note).toContain('@Bob 👎');
    expect(note).toContain('5m ago');
  });

  it('includes a short excerpt of the reacted-to message when available', () => {
    const note = formatRecentReactionsNote([
      {
        messageId: 'm1',
        channelId: 'c1',
        emoji: '👎',
        userLabel: 'Bob',
        messageExcerpt: 'here is my take on the plan',
        at: 0,
      },
    ]);
    expect(note).toContain('on "here is my take on the plan"');
  });

  it('shows the newest reactions first and caps the list', () => {
    const reactions = Array.from({ length: 8 }, (_, i) => ({
      messageId: `m${i}`,
      channelId: 'c1',
      emoji: '👍',
      userLabel: `User${i}`,
      at: i,
    }));
    const note = formatRecentReactionsNote(reactions, 100, 3)!;
    expect(note).toContain('User7');
    expect(note).toContain('User6');
    expect(note).toContain('User5');
    expect(note).not.toContain('User0');
  });
});
