import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isUtteranceLongEnough,
  hasHardCapElapsed,
  countNonBotMembers,
  noHumanStep,
  MIN_UTTERANCE_SECONDS,
  HARD_CAP_MS,
  NO_HUMAN_TIMEOUT_MS,
  SILENCE_MS,
} from '../../../src/gateway/voice/scribe-timers.js';

describe('isUtteranceLongEnough', () => {
  it('drops utterances under 0.6s', () => {
    expect(isUtteranceLongEnough(0.59)).toBe(false);
    expect(isUtteranceLongEnough(0.1)).toBe(false);
    expect(isUtteranceLongEnough(0)).toBe(false);
  });

  it('keeps utterances at or above 0.6s', () => {
    expect(isUtteranceLongEnough(0.6)).toBe(true);
    expect(isUtteranceLongEnough(5)).toBe(true);
  });

  it('respects a custom threshold', () => {
    expect(isUtteranceLongEnough(1, 2)).toBe(false);
    expect(isUtteranceLongEnough(2, 2)).toBe(true);
  });

  it('matches the documented default (0.6s)', () => {
    expect(MIN_UTTERANCE_SECONDS).toBe(0.6);
  });
});

describe('hasHardCapElapsed', () => {
  it('is false before the cap and true at/after it', () => {
    const start = 1_000_000;
    expect(hasHardCapElapsed(start, start + HARD_CAP_MS - 1, HARD_CAP_MS)).toBe(false);
    expect(hasHardCapElapsed(start, start + HARD_CAP_MS, HARD_CAP_MS)).toBe(true);
    expect(hasHardCapElapsed(start, start + HARD_CAP_MS + 1, HARD_CAP_MS)).toBe(true);
  });

  it('defaults to the documented 2h cap', () => {
    expect(HARD_CAP_MS).toBe(2 * 60 * 60 * 1000);
  });
});

describe('countNonBotMembers', () => {
  it('counts only non-bot members', () => {
    const members = [{ user: { bot: false } }, { user: { bot: true } }, { user: { bot: false } }];
    expect(countNonBotMembers(members)).toBe(2);
  });

  it('is 0 for an empty or all-bot channel', () => {
    expect(countNonBotMembers([])).toBe(0);
    expect(countNonBotMembers([{ user: { bot: true } }])).toBe(0);
  });
});

describe('noHumanStep: the 2-minute no-human auto-stop, with fake timers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resets to null (never stops) while someone human is present', () => {
    const result = noHumanStep({ noHumanSince: 50_000, humanCount: 1, nowMs: Date.now() });
    expect(result.noHumanSince).toBeNull();
    expect(result.shouldStop).toBe(false);
  });

  it('starts the countdown the moment the channel goes empty', () => {
    const result = noHumanStep({ noHumanSince: null, humanCount: 0, nowMs: Date.now() });
    expect(result.noHumanSince).toBe(0);
    expect(result.shouldStop).toBe(false);
  });

  it('does not stop just before the 2-minute mark, and does stop at/after it', () => {
    const started = noHumanStep({ noHumanSince: null, humanCount: 0, nowMs: Date.now() });
    expect(started.shouldStop).toBe(false);

    vi.advanceTimersByTime(NO_HUMAN_TIMEOUT_MS - 1_000);
    const almost = noHumanStep({ noHumanSince: started.noHumanSince, humanCount: 0, nowMs: Date.now() });
    expect(almost.shouldStop).toBe(false);
    expect(almost.noHumanSince).toBe(started.noHumanSince); // countdown keeps running, unchanged

    vi.advanceTimersByTime(1_000); // now exactly NO_HUMAN_TIMEOUT_MS since it went empty
    const atLimit = noHumanStep({ noHumanSince: started.noHumanSince, humanCount: 0, nowMs: Date.now() });
    expect(atLimit.shouldStop).toBe(true);
  });

  it('a human rejoining mid-countdown cancels it — the full 2 minutes must be unbroken', () => {
    const started = noHumanStep({ noHumanSince: null, humanCount: 0, nowMs: Date.now() });
    vi.advanceTimersByTime(NO_HUMAN_TIMEOUT_MS - 1);

    const rejoined = noHumanStep({ noHumanSince: started.noHumanSince, humanCount: 1, nowMs: Date.now() });
    expect(rejoined.noHumanSince).toBeNull();
    expect(rejoined.shouldStop).toBe(false);

    // Immediately empty again: the countdown starts over from now, not from where it left off.
    const restarted = noHumanStep({ noHumanSince: rejoined.noHumanSince, humanCount: 0, nowMs: Date.now() });
    expect(restarted.noHumanSince).toBe(Date.now());
    vi.advanceTimersByTime(NO_HUMAN_TIMEOUT_MS - 1);
    expect(
      noHumanStep({ noHumanSince: restarted.noHumanSince, humanCount: 0, nowMs: Date.now() }).shouldStop
    ).toBe(false);
  });
});

describe('documented constants', () => {
  it('no-human auto-stop is 2 minutes and silence-cut is ~1s', () => {
    expect(NO_HUMAN_TIMEOUT_MS).toBe(2 * 60 * 1000);
    expect(SILENCE_MS).toBe(1000);
  });
});
