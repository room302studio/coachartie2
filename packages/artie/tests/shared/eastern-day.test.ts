import { describe, it, expect } from 'vitest';
import { easternDayKey, easternDayBounds, toSqliteUtc } from '../src/utils/eastern-day.js';

describe('easternDayKey', () => {
  it('uses the New York calendar, not UTC', () => {
    expect(easternDayKey(new Date('2026-09-30T03:59:59Z'))).toBe('2026-09-29'); // 23:59:59 EDT
    expect(easternDayKey(new Date('2026-09-30T04:00:00Z'))).toBe('2026-09-30'); // 00:00 EDT
    expect(easternDayKey(new Date('2026-01-15T04:59:00Z'))).toBe('2026-01-14'); // 23:59 EST
    expect(easternDayKey(new Date('2026-01-15T05:00:00Z'))).toBe('2026-01-15'); // 00:00 EST
  });
});

describe('easternDayBounds', () => {
  const hours = (b: { start: Date; end: Date }) => (b.end.getTime() - b.start.getTime()) / 3_600_000;

  it('is midnight to midnight in EDT', () => {
    const b = easternDayBounds(new Date('2026-09-29T18:00:00Z'));
    expect(b.start.toISOString()).toBe('2026-09-29T04:00:00.000Z');
    expect(b.end.toISOString()).toBe('2026-09-30T04:00:00.000Z');
  });

  it('is midnight to midnight in EST', () => {
    const b = easternDayBounds(new Date('2026-01-15T12:00:00Z'));
    expect(b.start.toISOString()).toBe('2026-01-15T05:00:00.000Z');
    expect(hours(b)).toBe(24);
  });

  it('handles the 23-hour spring-forward day', () => {
    const b = easternDayBounds(new Date('2026-03-08T12:00:00Z'));
    expect(b.start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(b.end.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(hours(b)).toBe(23);
  });

  it('handles the 25-hour fall-back day', () => {
    const b = easternDayBounds(new Date('2026-11-01T12:00:00Z'));
    expect(b.start.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(b.end.toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(hours(b)).toBe(25);
  });

  it('contains the instant it was computed from, right up to the boundary', () => {
    const late = new Date('2026-09-30T03:59:59Z');
    const b = easternDayBounds(late);
    expect(late >= b.start && late < b.end).toBe(true);
  });
});

describe('toSqliteUtc', () => {
  it('matches the CURRENT_TIMESTAMP format', () => {
    expect(toSqliteUtc(new Date('2026-09-29T04:00:00.123Z'))).toBe('2026-09-29 04:00:00');
  });
});
