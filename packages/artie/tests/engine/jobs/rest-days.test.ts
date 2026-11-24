import { describe, it, expect } from 'vitest';
import { easternWeekday, easternHour, isEasternSunday, isEasternWeekend } from '../../../src/shared/eastern-day.js';
import { restDayReason } from '../../../src/engine/jobs/scheduler.js';

const PROACTIVE = new Set(['daily-summary', 'morning-briefing', 'trend-digest', 'heartbeat', 'reddit-mentions']);

// 2026-11-01 is a Sunday; DST ends at 2 AM ET that morning.
const SAT_9AM = new Date('2026-10-31T13:00:00Z');
const SAT_LATE = new Date('2026-11-01T03:30:00Z'); // 11:30 PM Saturday ET, already Sunday UTC
const SUN_NOON = new Date('2026-11-01T17:00:00Z'); // EST now: noon ET
const MON_9AM = new Date('2026-11-02T14:00:00Z');

describe('eastern weekdays', () => {
  it('uses the New York calendar, across the DST change', () => {
    expect(easternWeekday(SAT_9AM)).toBe(6);
    expect(easternHour(SAT_9AM)).toBe(9);
    expect(easternWeekday(SAT_LATE)).toBe(6);
    expect(isEasternSunday(SAT_LATE)).toBe(false);
    expect(easternHour(SUN_NOON)).toBe(12);
    expect(isEasternSunday(SUN_NOON)).toBe(true);
    expect(easternHour(MON_9AM)).toBe(9);
    expect(isEasternWeekend(MON_9AM)).toBe(false);
  });
});

describe('restDayReason', () => {
  it('Saturday: daily digests rest, other proactive jobs run', () => {
    expect(restDayReason('morning-briefing', PROACTIVE, SAT_9AM)).toBe('Weekend');
    expect(restDayReason('daily-summary', PROACTIVE, SAT_9AM)).toBe('Weekend');
    expect(restDayReason('heartbeat', PROACTIVE, SAT_9AM)).toBe('');
  });

  it('Sunday: every proactive job rests; maintenance and reminders still run', () => {
    expect(restDayReason('heartbeat', PROACTIVE, SUN_NOON)).toBe('Sunday off');
    expect(restDayReason('reddit-mentions', PROACTIVE, SUN_NOON)).toBe('Sunday off');
    expect(restDayReason('memory-gardening', PROACTIVE, SUN_NOON)).toBe('');
    expect(restDayReason('reminder', PROACTIVE, SUN_NOON)).toBe('');
  });

  it('Monday: back to work', () => {
    expect(restDayReason('morning-briefing', PROACTIVE, MON_9AM)).toBe('');
  });
});
