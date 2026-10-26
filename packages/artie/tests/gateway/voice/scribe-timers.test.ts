import { describe, it, expect } from 'vitest';
import {
  isUtteranceLongEnough,
  hasHardCapElapsed,
  countNonBotMembers,
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

describe('documented constants', () => {
  it('no-human auto-stop is 2 minutes and silence-cut is ~1s', () => {
    expect(NO_HUMAN_TIMEOUT_MS).toBe(2 * 60 * 1000);
    expect(SILENCE_MS).toBe(1000);
  });
});
