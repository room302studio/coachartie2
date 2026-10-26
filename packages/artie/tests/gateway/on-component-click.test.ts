import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  parseArtieCustomId,
  checkClickCap,
  recordClick,
  resetClickCountersForTests,
  buildClickTurnText,
} from '../../src/gateway/1-receive/on-component-click.js';

describe('parseArtieCustomId', () => {
  it('parses artie:<turn>:<index>', () => {
    expect(parseArtieCustomId('artie:abc123:0')).toEqual({ turnId: 'abc123', index: 0 });
    expect(parseArtieCustomId('artie:abc123:4')).toEqual({ turnId: 'abc123', index: 4 });
  });

  it('rejects anything else — including other capabilities\' custom ids', () => {
    expect(parseArtieCustomId('btn_0')).toBeNull();
    expect(parseArtieCustomId('ask_123_yes')).toBeNull();
    expect(parseArtieCustomId('daily:guess:2026-10-26')).toBeNull();
    expect(parseArtieCustomId('artie:abc')).toBeNull(); // missing index
    expect(parseArtieCustomId('artie:abc:x')).toBeNull(); // non-numeric index
  });
});

describe('component click caps', () => {
  beforeEach(() => {
    resetClickCountersForTests();
  });

  it('allows the first click from each of several distinct users', () => {
    expect(checkClickCap('msg-1', 'user-a')).toEqual({ allowed: true });
    recordClick('msg-1', 'user-a');
    expect(checkClickCap('msg-1', 'user-b')).toEqual({ allowed: true });
  });

  it('blocks a second click from the SAME user on the SAME message (duplicate)', () => {
    expect(checkClickCap('msg-1', 'user-a')).toEqual({ allowed: true });
    recordClick('msg-1', 'user-a');
    expect(checkClickCap('msg-1', 'user-a')).toEqual({ allowed: false, reason: 'duplicate' });
  });

  it('the same user clicking a DIFFERENT message is not a duplicate', () => {
    recordClick('msg-1', 'user-a');
    expect(checkClickCap('msg-2', 'user-a')).toEqual({ allowed: true });
  });

  it('blocks the 9th distinct-user click on one message (default cap 8)', () => {
    for (let i = 0; i < 8; i++) {
      const userId = `user-${i}`;
      expect(checkClickCap('msg-cap', userId)).toEqual({ allowed: true });
      recordClick('msg-cap', userId);
    }
    expect(checkClickCap('msg-cap', 'user-9')).toEqual({ allowed: false, reason: 'cap' });
  });

  it('honors ARTIE_BUTTON_CLICK_CAP when set', () => {
    const prev = process.env.ARTIE_BUTTON_CLICK_CAP;
    process.env.ARTIE_BUTTON_CLICK_CAP = '2';
    try {
      expect(checkClickCap('msg-env', 'u1')).toEqual({ allowed: true });
      recordClick('msg-env', 'u1');
      expect(checkClickCap('msg-env', 'u2')).toEqual({ allowed: true });
      recordClick('msg-env', 'u2');
      expect(checkClickCap('msg-env', 'u3')).toEqual({ allowed: false, reason: 'cap' });
    } finally {
      if (prev === undefined) delete process.env.ARTIE_BUTTON_CLICK_CAP;
      else process.env.ARTIE_BUTTON_CLICK_CAP = prev;
    }
  });

  it('checkClickCap alone (without recordClick) does not consume the cap', () => {
    expect(checkClickCap('msg-peek', 'user-a')).toEqual({ allowed: true });
    expect(checkClickCap('msg-peek', 'user-a')).toEqual({ allowed: true }); // still allowed, never recorded
  });
});

describe('buildClickTurnText', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats "[button] <name> picked "<label>" on your message "<snippet>" (<n>s after you posted)"', () => {
    vi.useFakeTimers();
    const postedAt = 0;
    vi.setSystemTime(12_000);
    const text = buildClickTurnText('ejfox', 'Yes', 'Should I deploy?', postedAt);
    expect(text).toBe('[button] ejfox picked "Yes" on your message "Should I deploy?" (12s after you posted)');
  });

  it('truncates the original message to 80 chars', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const longMessage = 'x'.repeat(200);
    const text = buildClickTurnText('ejfox', 'Yes', longMessage, 0);
    const snippet = text.match(/on your message "(.*)" \(/)?.[1];
    expect(snippet?.length).toBe(80);
  });

  it('never reports negative elapsed time (clock skew clamps to 0)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const text = buildClickTurnText('ejfox', 'Yes', 'msg', 5000); // "posted" in the future
    expect(text).toContain('(0s after you posted)');
  });
});
