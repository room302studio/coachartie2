import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordChannelActivity,
  getChannelActivity,
  resetChannelActivity,
  pickLandedMessages,
  formatLandedNote,
} from '../../../src/gateway/1-receive/channel-activity.js';

describe('channel activity ring buffer', () => {
  beforeEach(() => resetChannelActivity());

  it('records and reads back entries for a channel', () => {
    recordChannelActivity('chan-1', { messageId: 'm1', authorLabel: 'Alice', content: 'hey', ts: 100 });
    expect(getChannelActivity('chan-1')).toEqual([
      { messageId: 'm1', authorLabel: 'Alice', content: 'hey', ts: 100 },
    ]);
  });

  it('keeps channels separate', () => {
    recordChannelActivity('chan-1', { messageId: 'm1', authorLabel: 'Alice', content: 'a', ts: 1 });
    recordChannelActivity('chan-2', { messageId: 'm2', authorLabel: 'Bob', content: 'b', ts: 1 });
    expect(getChannelActivity('chan-1')).toHaveLength(1);
    expect(getChannelActivity('chan-2')).toHaveLength(1);
  });

  it('drops entries older than the max age on the next write', () => {
    recordChannelActivity('chan-1', { messageId: 'old', authorLabel: 'Alice', content: 'a', ts: 0 });
    recordChannelActivity('chan-1', {
      messageId: 'new',
      authorLabel: 'Bob',
      content: 'b',
      ts: 11 * 60 * 1000, // 11 minutes later — past the 10-minute MAX_AGE_MS
    });
    const entries = getChannelActivity('chan-1');
    expect(entries.map((e) => e.messageId)).toEqual(['new']);
  });

  it('caps the buffer length', () => {
    for (let i = 0; i < 60; i++) {
      recordChannelActivity('chan-1', { messageId: `m${i}`, authorLabel: 'Alice', content: '', ts: i });
    }
    expect(getChannelActivity('chan-1').length).toBeLessThanOrEqual(40);
    // newest entries survive
    expect(getChannelActivity('chan-1').at(-1)?.messageId).toBe('m59');
  });
});

describe('pickLandedMessages', () => {
  const activity = [
    { messageId: 'm1', authorLabel: 'Alice', content: 'in batch', ts: 100 },
    { messageId: 'm2', authorLabel: 'Bob', content: 'landed', ts: 200 },
    { messageId: 'm3', authorLabel: 'Carol', content: 'also landed', ts: 300 },
  ];

  it('excludes the batch itself and anything before sinceTs', () => {
    const landed = pickLandedMessages(activity, 100, new Set(['m1']));
    expect(landed.map((e) => e.messageId)).toEqual(['m2', 'm3']);
  });

  it('caps to the limit, keeping the most recent', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      messageId: `m${i}`,
      authorLabel: 'Alice',
      content: '',
      ts: i,
    }));
    const landed = pickLandedMessages(many, -1, new Set(), 3);
    expect(landed.map((e) => e.messageId)).toEqual(['m7', 'm8', 'm9']);
  });

  it('returns [] when nothing landed', () => {
    expect(pickLandedMessages(activity, 300, new Set())).toEqual([]);
  });
});

describe('formatLandedNote', () => {
  it('is undefined when nothing landed', () => {
    expect(formatLandedNote([])).toBeUndefined();
  });

  it('names authors and quotes content when available', () => {
    const note = formatLandedNote([
      { messageId: 'm2', authorLabel: 'Bob', content: 'nevermind, figured it out', ts: 200 },
    ]);
    expect(note).toContain('Bob: "nevermind, figured it out"');
    expect(note).toContain('1 more message landed');
  });

  it('handles content-less entries (no privileged intents) without a dangling quote', () => {
    const note = formatLandedNote([{ messageId: 'm2', authorLabel: 'Bob', content: '', ts: 200 }]);
    expect(note).toContain('Bob');
    expect(note).not.toContain('""');
  });

  it('pluralizes for more than one landed message', () => {
    const note = formatLandedNote([
      { messageId: 'm2', authorLabel: 'Bob', content: '', ts: 1 },
      { messageId: 'm3', authorLabel: 'Carol', content: '', ts: 2 },
    ]);
    expect(note).toContain('2 more messages landed');
  });

  it('marks side conversations so Artie does not answer half of one', () => {
    const note = formatLandedNote([
      { messageId: 'm2', authorLabel: 'Bob', content: 'did you push it?', ts: 1, toLabel: 'Carol' },
      { messageId: 'm3', authorLabel: 'Carol', content: 'yep', ts: 2, toLabel: 'Bob' },
    ]);
    expect(note).toContain('Bob (to Carol): "did you push it?"');
    expect(note).toContain('Carol (to Bob): "yep"');
    expect(note).toContain('in arrival order');
  });
});
