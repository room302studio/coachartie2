import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BurstScheduler, combineBurstContent, renderBurstForContext, burstDebounceMs } from '../../../src/gateway/3-ask-engine/burst.js';

describe('burstDebounceMs', () => {
  const original = process.env.BURST_DEBOUNCE_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.BURST_DEBOUNCE_MS;
    else process.env.BURST_DEBOUNCE_MS = original;
  });

  it('defaults to 2500ms', () => {
    delete process.env.BURST_DEBOUNCE_MS;
    expect(burstDebounceMs()).toBe(2500);
  });

  it('reads the env override', () => {
    process.env.BURST_DEBOUNCE_MS = '500';
    expect(burstDebounceMs()).toBe(500);
  });

  it('falls back to the default on garbage input', () => {
    process.env.BURST_DEBOUNCE_MS = 'not-a-number';
    expect(burstDebounceMs()).toBe(2500);
  });

  it('allows 0 (batching disabled, still folds same-tick arrivals)', () => {
    process.env.BURST_DEBOUNCE_MS = '0';
    expect(burstDebounceMs()).toBe(0);
  });
});

describe('combineBurstContent', () => {
  it('passes a lone message through unchanged', () => {
    expect(combineBurstContent([{ messageId: '1', authorLabel: 'Alice', content: 'hey' }])).toBe('hey');
  });

  it('labels each line in a real burst', () => {
    const out = combineBurstContent([
      { messageId: '1', authorLabel: 'Alice', content: 'hey' },
      { messageId: '2', authorLabel: 'Bob', content: 'what up' },
    ]);
    expect(out).toBe('Alice: hey\nBob: what up');
  });

  it('shows [no text] for a burst member with blank content (no privileged intents)', () => {
    const out = combineBurstContent([
      { messageId: '1', authorLabel: 'Alice', content: 'hey artie' },
      { messageId: '2', authorLabel: 'Bob', content: '' },
    ]);
    expect(out).toBe('Alice: hey artie\nBob: [no text]');
  });

  it('returns empty string for an empty batch', () => {
    expect(combineBurstContent([])).toBe('');
  });
});

describe('renderBurstForContext', () => {
  it('is undefined for a single message (byte-identical pre-batching context)', () => {
    expect(renderBurstForContext([{ messageId: '1', authorLabel: 'Alice', content: 'hey' }])).toBeUndefined();
  });

  it('lists every message for a real burst', () => {
    const out = renderBurstForContext([
      { messageId: '1', authorLabel: 'Alice', content: 'hey' },
      { messageId: '2', authorLabel: 'Bob', content: 'yo' },
    ]);
    expect(out).toEqual([
      { author: 'Alice', content: 'hey', messageId: '1' },
      { author: 'Bob', content: 'yo', messageId: '2' },
    ]);
  });
});

describe('BurstScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('flushes a single item after the window', () => {
    const scheduler = new BurstScheduler<string>();
    const flush = vi.fn();
    scheduler.add('chan-1', 'msg-a', flush, 2500);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2499);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(flush).toHaveBeenCalledWith(['msg-a']);
  });

  it('folds later arrivals into the same batch without resetting the deadline', () => {
    const scheduler = new BurstScheduler<string>();
    const flush = vi.fn();
    scheduler.add('chan-1', 'msg-a', flush, 2500);
    vi.advanceTimersByTime(2000);
    scheduler.add('chan-1', 'msg-b', flush, 2500); // joins, does NOT push the deadline to 2000+2500
    vi.advanceTimersByTime(500); // total 2500ms since msg-a — must fire now, not later
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(['msg-a', 'msg-b']);
  });

  it('a single message never waits longer than the window, no matter how many join', () => {
    const scheduler = new BurstScheduler<string>();
    const flush = vi.fn();
    scheduler.add('chan-1', 'first', flush, 1000);
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(40); // 20 * 40 = 800ms of trickling arrivals
      scheduler.add('chan-1', `extra-${i}`, flush, 1000);
    }
    vi.advanceTimersByTime(200); // total 1000ms since 'first' — must have fired by now
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(['first', ...Array.from({ length: 20 }, (_, i) => `extra-${i}`)]);
  });

  it('an arrival right after flush starts a brand-new batch, never joins the flushed one', () => {
    const scheduler = new BurstScheduler<string>();
    const seen: string[][] = [];
    const flush = (items: string[]) => {
      seen.push(items);
    };
    scheduler.add('chan-1', 'batch-1-a', flush, 1000);
    vi.advanceTimersByTime(1000); // flush fires, buffer deleted
    scheduler.add('chan-1', 'batch-2-a', flush, 1000); // must NOT join batch 1
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([['batch-1-a'], ['batch-2-a']]);
  });

  it('separate channels never share a batch', () => {
    const scheduler = new BurstScheduler<string>();
    const flush = vi.fn();
    scheduler.add('chan-1', 'a', flush, 1000);
    scheduler.add('chan-2', 'b', flush, 1000);
    vi.advanceTimersByTime(1000);
    expect(flush).toHaveBeenCalledWith(['a']);
    expect(flush).toHaveBeenCalledWith(['b']);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('pendingCount reflects the open batch', () => {
    const scheduler = new BurstScheduler<string>();
    expect(scheduler.pendingCount('chan-1')).toBe(0);
    scheduler.add('chan-1', 'a', vi.fn(), 1000);
    expect(scheduler.pendingCount('chan-1')).toBe(1);
    scheduler.add('chan-1', 'b', vi.fn(), 1000);
    expect(scheduler.pendingCount('chan-1')).toBe(2);
  });

  it('flushAll flushes every pending channel immediately, bypassing timers', () => {
    const scheduler = new BurstScheduler<string>();
    scheduler.add('chan-1', 'a', vi.fn(), 10_000);
    scheduler.add('chan-2', 'b', vi.fn(), 10_000);
    const flushed: Record<string, string[]> = {};
    scheduler.flushAll((channelId, items) => {
      flushed[channelId] = items;
    });
    expect(flushed).toEqual({ 'chan-1': ['a'], 'chan-2': ['b'] });
    expect(scheduler.pendingCount('chan-1')).toBe(0);
  });
});
