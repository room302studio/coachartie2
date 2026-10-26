import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  isSubstantialReply,
  isJarButtonThrottled,
  recordJarButtonShown,
  resetJarButtonThrottleForTests,
  buildJarButtonRow,
  decideJarButton,
  JAR_BUTTON_LABEL,
} from '../../src/gateway/4-reply/jar-button.js';

const JAR_URL = 'https://buy.stripe.com/jar';

describe('isSubstantialReply', () => {
  it('false just under the 900-char threshold', () => {
    expect(isSubstantialReply({ replyLength: 899, usedQualifyingTool: false })).toBe(false);
  });

  it('true at exactly the 900-char threshold', () => {
    expect(isSubstantialReply({ replyLength: 900, usedQualifyingTool: false })).toBe(true);
  });

  it('true for a short reply that used a qualifying tool', () => {
    expect(isSubstantialReply({ replyLength: 10, usedQualifyingTool: true })).toBe(true);
  });
});

describe('jar button row shape', () => {
  it('is a link button: style Link, a url, NO custom_id', () => {
    const row = buildJarButtonRow(JAR_URL) as any;
    expect(row.type).toBe(1);
    expect(row.components).toHaveLength(1);
    const button = row.components[0];
    expect(button.type).toBe(2);
    expect(button.label).toBe(JAR_BUTTON_LABEL);
    expect(button.url).toBe(JAR_URL);
    expect(button.custom_id).toBeUndefined();
    expect(button.style).toBe(5); // discord.js ButtonStyle.Link
  });
});

describe('jar button throttle (6h per channel)', () => {
  beforeEach(() => {
    resetJarButtonThrottleForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is not throttled before anything has shown', () => {
    expect(isJarButtonThrottled('chan-1')).toBe(false);
  });

  it('throttles the same channel right after a show', () => {
    recordJarButtonShown('chan-1', Date.now());
    expect(isJarButtonThrottled('chan-1', Date.now())).toBe(true);
  });

  it('clears after 6 hours', () => {
    const t0 = Date.now();
    recordJarButtonShown('chan-1', t0);
    expect(isJarButtonThrottled('chan-1', t0 + 6 * 3600_000 - 1)).toBe(true);
    expect(isJarButtonThrottled('chan-1', t0 + 6 * 3600_000)).toBe(false);
  });

  it('two different channels are throttled independently', () => {
    recordJarButtonShown('chan-1', Date.now());
    expect(isJarButtonThrottled('chan-1')).toBe(true);
    expect(isJarButtonThrottled('chan-2')).toBe(false);
  });
});

describe('decideJarButton — the combined decision', () => {
  beforeEach(() => {
    resetJarButtonThrottleForTests();
  });

  const base = {
    url: JAR_URL,
    channelId: 'chan-1',
    userBlocked: false,
    replyLength: 1000,
    usedQualifyingTool: false,
    existingRowCount: 0,
  };

  it('returns a row for a substantial, unthrottled, configured reply', () => {
    expect(decideJarButton(base)).not.toBeNull();
  });

  it('returns null when the url is not configured/invalid', () => {
    expect(decideJarButton({ ...base, url: null })).toBeNull();
  });

  it('returns null with no channel to throttle against', () => {
    expect(decideJarButton({ ...base, channelId: undefined })).toBeNull();
    expect(decideJarButton({ ...base, channelId: null })).toBeNull();
  });

  it('returns null for a blocked user', () => {
    expect(decideJarButton({ ...base, userBlocked: true })).toBeNull();
  });

  it('returns null for a short reply that used no qualifying tool', () => {
    expect(decideJarButton({ ...base, replyLength: 100 })).toBeNull();
  });

  it('appends as its own row when there is room (existing rows < 5)', () => {
    const row = decideJarButton({ ...base, existingRowCount: 4 });
    expect(row).not.toBeNull();
  });

  it('skips (never bumps an existing row) when already at the 5-row cap', () => {
    expect(decideJarButton({ ...base, existingRowCount: 5 })).toBeNull();
  });

  it('skips once this channel already got one within 6h, and allows after', () => {
    const now = Date.now();
    recordJarButtonShown('chan-1', now);
    expect(decideJarButton({ ...base, now: now + 1000 })).toBeNull();
    expect(decideJarButton({ ...base, now: now + 6 * 3600_000 + 1 })).not.toBeNull();
  });
});
