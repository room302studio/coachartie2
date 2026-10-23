import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getSyncDb,
  readKillSwitch,
  writeBudgetOverride,
  reportToAnomalywatch,
  createMemoryAlertRateStore,
  isGenerationMuted,
  assertGenerationAllowed,
  GenerationMutedError,
} from '@coachartie/shared';
import {
  decideBudgetAction,
  checkDailyBudget,
  getDailyBudgetUsd,
  getTodaySpendUsd,
  BUDGET_ALERT_KIND,
} from '../src/services/monitoring/daily-budget.js';

// 2026-09-29 is EDT (UTC-4): the ET day runs 04:00Z → 04:00Z next day.
const NOON_ET = new Date('2026-09-29T16:00:00Z');
const LATE_ET = new Date('2026-09-30T03:59:00Z'); // 23:59 ET, same day
const NEXT_DAY_ET = new Date('2026-09-30T04:01:00Z'); // 00:01 ET, next day

describe('decideBudgetAction', () => {
  const base = { spentUsd: 0, budgetUsd: 3, today: '2026-09-29', overrideDay: null };

  it('mutes when spend reaches the budget', () => {
    expect(decideBudgetAction({ ...base, state: { muted: false }, spentUsd: 2.99 })).toBe('none');
    expect(decideBudgetAction({ ...base, state: { muted: false }, spentUsd: 3 })).toBe('mute');
  });

  it('never touches a manual mute — not to lift it, not to relabel it', () => {
    const manual = { muted: true as const, kind: 'manual' as const };
    expect(decideBudgetAction({ ...base, state: manual, spentUsd: 99 })).toBe('none');
    expect(decideBudgetAction({ ...base, state: manual, today: '2026-10-05' })).toBe('none');
  });

  it('lifts a budget mute only once the ET day has changed', () => {
    const budget = {
      muted: true as const,
      kind: 'budget' as const,
      day: '2026-09-29',
      spentUsd: 3.2,
      budgetUsd: 3,
      at: '',
    };
    expect(decideBudgetAction({ ...base, state: budget, spentUsd: 5 })).toBe('none');
    expect(decideBudgetAction({ ...base, state: budget, today: '2026-09-30' })).toBe('unmute');
  });

  it('respects a same-day manual override, and only for that day', () => {
    expect(
      decideBudgetAction({ ...base, state: { muted: false }, spentUsd: 9, overrideDay: '2026-09-29' })
    ).toBe('none');
    expect(
      decideBudgetAction({ ...base, state: { muted: false }, spentUsd: 9, overrideDay: '2026-09-28' })
    ).toBe('mute');
  });

  it('does nothing when the cap is disabled', () => {
    expect(decideBudgetAction({ ...base, state: { muted: false }, spentUsd: 99, budgetUsd: null })).toBe(
      'none'
    );
  });
});

describe('getDailyBudgetUsd', () => {
  const saved = process.env.DAILY_BUDGET_USD;
  afterEach(() => {
    if (saved === undefined) delete process.env.DAILY_BUDGET_USD;
    else process.env.DAILY_BUDGET_USD = saved;
  });

  it('defaults to $3', () => {
    delete process.env.DAILY_BUDGET_USD;
    expect(getDailyBudgetUsd()).toBe(3);
  });
  it('reads the env', () => {
    process.env.DAILY_BUDGET_USD = '7.5';
    expect(getDailyBudgetUsd()).toBe(7.5);
  });
  it('0 / off disables it', () => {
    process.env.DAILY_BUDGET_USD = '0';
    expect(getDailyBudgetUsd()).toBeNull();
    process.env.DAILY_BUDGET_USD = 'off';
    expect(getDailyBudgetUsd()).toBeNull();
  });
});

describe('checkDailyBudget', () => {
  let path: string;
  const savedBudget = process.env.DAILY_BUDGET_USD;

  beforeEach(() => {
    path = join(mkdtempSync(join(tmpdir(), 'artie-budget-')), 'KILL_SWITCH');
    process.env.DAILY_BUDGET_USD = '3';
  });
  afterEach(() => {
    if (savedBudget === undefined) delete process.env.DAILY_BUDGET_USD;
    else process.env.DAILY_BUDGET_USD = savedBudget;
  });

  it('stays unmuted under budget', async () => {
    const report = vi.fn();
    const r = await checkDailyBudget({ now: NOON_ET, killSwitchPath: path, spend: () => 2.5, report });
    expect(r.action).toBe('none');
    expect(existsSync(path)).toBe(false);
    expect(report).not.toHaveBeenCalled();
  });

  it('mutes with a budget marker and reports exactly once per trip', async () => {
    const report = vi.fn().mockResolvedValue('sent');
    const r = await checkDailyBudget({ now: NOON_ET, killSwitchPath: path, spend: () => 3.4, report });
    expect(r.action).toBe('mute');
    const state = readKillSwitch(path);
    expect(state).toMatchObject({ muted: true, kind: 'budget', day: '2026-09-29', budgetUsd: 3 });
    expect(isGenerationMuted(path)).toBe(true);
    expect(() => assertGenerationAllowed('test', path)).toThrow(GenerationMutedError);

    // Later the same day: already muted → no second notification.
    await checkDailyBudget({ now: LATE_ET, killSwitchPath: path, spend: () => 3.4, report });
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toBe('warning');
    expect(report.mock.calls[0][2]).toMatchObject({ kind: BUDGET_ALERT_KIND });
  });

  it('auto-unmutes at the next ET midnight', async () => {
    const report = vi.fn().mockResolvedValue('sent');
    await checkDailyBudget({ now: NOON_ET, killSwitchPath: path, spend: () => 4, report });
    expect(isGenerationMuted(path)).toBe(true);

    // Still 23:59 ET — stays muted.
    await checkDailyBudget({ now: LATE_ET, killSwitchPath: path, spend: () => 4, report });
    expect(isGenerationMuted(path)).toBe(true);

    // 00:01 ET — lifted; the new day's spend is evaluated fresh.
    const r = await checkDailyBudget({ now: NEXT_DAY_ET, killSwitchPath: path, spend: () => 0, report });
    expect(r.action).toBe('none');
    expect(isGenerationMuted(path)).toBe(false);
  });

  it('never overrides or lifts a manual mute', async () => {
    writeFileSync(path, 'muted at 2026-09-29T12:00:00Z\n');
    const report = vi.fn();
    await checkDailyBudget({ now: NOON_ET, killSwitchPath: path, spend: () => 50, report });
    await checkDailyBudget({ now: NEXT_DAY_ET, killSwitchPath: path, spend: () => 0, report });
    expect(readFileSync(path, 'utf8')).toBe('muted at 2026-09-29T12:00:00Z\n');
    expect(report).not.toHaveBeenCalled();
  });

  it('a manual mute written over a budget mute is no longer auto-lifted', async () => {
    const report = vi.fn().mockResolvedValue('sent');
    await checkDailyBudget({ now: NOON_ET, killSwitchPath: path, spend: () => 4, report });
    writeFileSync(path, 'muted at 2026-09-29T17:00:00Z\n'); // POST /api/killswitch {enabled:true}
    await checkDailyBudget({ now: NEXT_DAY_ET, killSwitchPath: path, spend: () => 0, report });
    expect(readKillSwitch(path)).toEqual({ muted: true, kind: 'manual' });
  });

  it('a same-day manual unmute (override) is not immediately re-tripped', async () => {
    const report = vi.fn().mockResolvedValue('sent');
    writeBudgetOverride('2026-09-29', path);
    const r = await checkDailyBudget({ now: NOON_ET, killSwitchPath: path, spend: () => 10, report });
    expect(r.action).toBe('none');
    expect(isGenerationMuted(path)).toBe(false);
    // ...but the override expires with the day.
    const next = await checkDailyBudget({ now: NEXT_DAY_ET, killSwitchPath: path, spend: () => 10, report });
    expect(next.action).toBe('mute');
  });

  it('sends at most one anomalywatch notification per ET day even if re-tripped', async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    const store = createMemoryAlertRateStore();
    const report: typeof reportToAnomalywatch = (level, message, opts) =>
      reportToAnomalywatch(level, message, { ...opts, store, scriptPath: '/fake/alert.sh', exec });

    await checkDailyBudget({ now: NOON_ET, killSwitchPath: path, spend: () => 4, report });
    // Someone deletes the file by hand (no override), and the cap trips again the same day.
    unlinkSync(path);
    await checkDailyBudget({ now: LATE_ET, killSwitchPath: path, spend: () => 4.5, report });
    expect(isGenerationMuted(path)).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);

    // Next day's trip is a new notification.
    await checkDailyBudget({ now: NEXT_DAY_ET, killSwitchPath: path, spend: () => 5, report });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('a failed spend lookup never mutes', async () => {
    const report = vi.fn();
    const r = await checkDailyBudget({
      now: NOON_ET,
      killSwitchPath: path,
      spend: () => {
        throw new Error('db locked');
      },
      report,
    });
    expect(r.action).toBe('error');
    expect(isGenerationMuted(path)).toBe(false);
  });
});

describe('getTodaySpendUsd', () => {
  it('sums model_usage_stats within the ET day only', () => {
    const db = getSyncDb();
    const insert = (ts: string, cost: number) =>
      db.run(
        `INSERT INTO model_usage_stats (model_name, user_id, message_id, estimated_cost, timestamp)
         VALUES ('m', 'budget-test', 'x', ?, ?)`,
        [cost, ts]
      );
    const before = getTodaySpendUsd(new Date('2027-01-15T17:00:00Z'));
    // 2027-01-15 is EST (UTC-5): the ET day is 05:00Z → 05:00Z.
    insert('2027-01-15 04:59:59', 100); // 23:59:59 ET on the 14th — excluded
    insert('2027-01-15 05:00:00', 1.25); // 00:00 ET — included
    insert('2027-01-15 23:00:00', 0.5); // 18:00 ET — included
    insert('2027-01-16 04:59:59', 0.25); // 23:59:59 ET — included
    insert('2027-01-16 05:00:00', 100); // next ET day — excluded
    expect(getTodaySpendUsd(new Date('2027-01-15T17:00:00Z')) - before).toBeCloseTo(2.0, 6);
  });
});
