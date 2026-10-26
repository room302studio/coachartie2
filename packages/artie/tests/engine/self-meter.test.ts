import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordLlmHiccup,
  recentHiccups,
  resetHiccups,
  selfMeterLine,
} from '../../src/engine/budget/self-meter.js';

const none = { fallback: 0, failed: 0, 'reasoning-retry': 0 };

describe('self-meter', () => {
  beforeEach(() => resetHiccups());

  it('counts hiccups inside the 6h window only', () => {
    const now = Date.now();
    recordLlmHiccup('fallback', now - 7 * 3600_000);
    recordLlmHiccup('fallback', now - 60_000);
    recordLlmHiccup('reasoning-retry', now - 60_000);
    expect(recentHiccups(now)).toEqual({ fallback: 1, failed: 0, 'reasoning-retry': 1 });
  });

  it('shows spend, mode and runway, and says there is room early in the day', () => {
    const line = selfMeterLine(
      { mode: 'normal', runwayHours: 36.7, dailySpendFraction: 0.1 },
      3,
      none
    );
    expect(line).toContain('$0.30 of $3.00 today (10%)');
    expect(line).toContain('mode normal');
    expect(line).toContain('credit runway ~37h');
    expect(line).toContain('no fallbacks');
    expect(line).toContain('Plenty of room');
    expect(line).toContain("don't bring up budget or credits");
  });

  it('gives the soft warning at 40% before brownout kicks in', () => {
    const line = selfMeterLine({ mode: 'normal', runwayHours: null, dailySpendFraction: 0.46 }, 3, none);
    expect(line).toContain('Past 40% of today');
    expect(line).not.toContain('runway');
  });

  it('names brownout mode and the fallbacks', () => {
    const line = selfMeterLine(
      { mode: 'lean', runwayHours: 14, dailySpendFraction: 0.25 },
      3,
      { fallback: 2, failed: 1, 'reasoning-retry': 0 }
    );
    expect(line).toContain("You're in lean mode");
    expect(line).toContain('2 model fallbacks, 1 failed generation');
  });

  it('skips the dollar figure when the cap is off', () => {
    const line = selfMeterLine({ mode: 'normal', runwayHours: null }, null, none);
    expect(line).not.toContain('$');
  });

  it('omits the jar clause entirely when jarUsd is null (unconfigured or no data yet)', () => {
    const line = selfMeterLine({ mode: 'normal', runwayHours: null, dailySpendFraction: 0.1 }, 3, none);
    expect(line).not.toContain('jar');
  });

  it('appends the jar line and the thank-but-never-solicit clause when jarUsd is set', () => {
    const line = selfMeterLine(
      { mode: 'normal', runwayHours: null, dailySpendFraction: 0.1 },
      3,
      none,
      12.5
    );
    expect(line).toContain('jar: $12.50 tipped this month');
    expect(line).toContain('thank them warmly');
    expect(line).toContain('you still never ask');
  });

  it('formats a zero jar total correctly (not treated as falsy/absent)', () => {
    const line = selfMeterLine({ mode: 'normal', runwayHours: null }, null, none, 0);
    expect(line).toContain('jar: $0.00 tipped this month');
  });
});
