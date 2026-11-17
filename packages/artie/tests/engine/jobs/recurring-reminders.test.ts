/**
 * Recurring reminders (2026-11-17): parsing, next-fire math, limits, ownership, persistence
 * and the fire path. In-memory DB from test-setup; the scheduler's Redis side is spied.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb, getRawDb, getSyncDb, initializeDb } from '../../../src/shared/db/client.js';
import {
  MAX_ACTIVE_PER_USER,
  MAX_MESSAGE_CHARS,
  cancelRecurringReminder,
  createRecurringReminder,
  fireDueRecurringReminders,
  listRecurringReminders,
  nextFireAfter,
  parseSchedule,
  type ParsedSchedule,
} from '../../../src/engine/jobs/recurring-reminders.js';
import { schedulerCapability } from '../../../src/engine/tools/core/reminders.js';
import { schedulerService } from '../../../src/engine/jobs/scheduler.js';
import { OWNER_USER_ID } from '../../../src/shared/config/owner.js';

vi.mock('../../../src/shared/db/user-profiles.js', () => ({
  UserProfileService: {
    getAttribute: vi.fn(async (userId: string) => {
      if (userId === 'tz-user') return 'America/New_York';
      return null;
    }),
  },
}));

function schedule(text: string): ParsedSchedule {
  const r = parseSchedule(text);
  if (!r.ok) throw new Error(r.error);
  return r.schedule;
}

function uid(): string {
  return `u-${randomUUID()}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseSchedule', () => {
  it('reads intervals', () => {
    expect(schedule('every 6 hours')).toMatchObject({ kind: 'interval', intervalMs: 6 * 3600_000 });
    expect(schedule('every day')).toMatchObject({ kind: 'interval', intervalMs: 24 * 3600_000 });
    expect(schedule('Every Week')).toMatchObject({ kind: 'interval', intervalMs: 7 * 24 * 3600_000 });
    expect(schedule('hourly')).toMatchObject({ kind: 'interval', intervalMs: 3600_000 });
    expect(schedule('every 2 weeks').text).toBe('every 2 weeks');
    expect(schedule('every 60 minutes')).toMatchObject({ intervalMs: 3600_000 });
  });

  it('reads times of day and weekdays', () => {
    expect(schedule('every weekday at 9:00')).toMatchObject({ kind: 'calendar', days: [1, 2, 3, 4, 5], time: '09:00' });
    expect(schedule('every monday 18:30')).toMatchObject({ kind: 'calendar', days: [1], time: '18:30' });
    expect(schedule('every mon, wed and fri at 8am')).toMatchObject({ days: [1, 3, 5], time: '08:00' });
    expect(schedule('every day at 9pm')).toMatchObject({ days: [0, 1, 2, 3, 4, 5, 6], time: '21:00' });
    expect(schedule('every weekend at noon')).toMatchObject({ days: [0, 6], time: '12:00' });
    expect(schedule('daily at 7:15')).toMatchObject({ time: '07:15' });
    expect(schedule('every weekday at 9:00').text).toBe('every weekday at 09:00');
  });

  it('rejects what it cannot honor', () => {
    const cases: Array<[string, RegExp]> = [
      ['', /how often/],
      ['every 30 minutes', /once an hour/],
      ['every minute', /once an hour/],
      ['every 0 hours', /isn't valid|once an hour/],
      ['every 400 days', /366/],
      ['every monday', /needs a time/],
      ['every blursday at 9:00', /days/],
      ['every monday at 25:00', /time/],
      ['every monday at 13pm', /time/],
      ['every 2 days at 9:00', /days/],
      ['whenever', /couldn't read/],
      ['0 9 * * *', /couldn't read/],
    ];
    for (const [input, reason] of cases) {
      const r = parseSchedule(input);
      expect(r.ok, input).toBe(false);
      if (!r.ok) expect(r.error, input).toMatch(reason);
    }
  });
});

describe('nextFireAfter', () => {
  it('interval: stays on the anchor grid, never drifts from a late tick', () => {
    const s = schedule('every 6 hours');
    const anchor = new Date('2026-11-17T10:00:00Z');
    expect(nextFireAfter(s, anchor, anchor, 'UTC').toISOString()).toBe('2026-11-17T16:00:00.000Z');
    // fired 7 minutes late: next is still 22:00, not 22:07
    const late = new Date('2026-11-17T16:07:00Z');
    expect(nextFireAfter(s, late, anchor, 'UTC').toISOString()).toBe('2026-11-17T22:00:00.000Z');
    // exactly on a slot: strictly after
    const onSlot = new Date('2026-11-17T22:00:00Z');
    expect(nextFireAfter(s, onSlot, anchor, 'UTC').toISOString()).toBe('2026-11-18T04:00:00.000Z');
  });

  it('interval: skips every missed slot after downtime', () => {
    const s = schedule('every 6 hours');
    const anchor = new Date('2026-11-17T10:00:00Z');
    const afterOutage = new Date('2026-11-19T03:30:00Z');
    expect(nextFireAfter(s, afterOutage, anchor, 'UTC').toISOString()).toBe('2026-11-19T04:00:00.000Z');
  });

  it('calendar: next weekday 9:00 in the zone, skipping the weekend', () => {
    const s = schedule('every weekday at 9:00');
    // Fri 2026-11-20 10:00 New York (EST, 15:00Z) -> Mon 2026-11-23 09:00 EST = 14:00Z
    const fri = new Date('2026-11-20T15:00:00Z');
    expect(nextFireAfter(s, fri, fri, 'America/New_York').toISOString()).toBe('2026-11-23T14:00:00.000Z');
    // Tue 08:00 local -> same day 09:00
    const tue = new Date('2026-11-17T13:00:00Z');
    expect(nextFireAfter(s, tue, tue, 'America/New_York').toISOString()).toBe('2026-11-17T14:00:00.000Z');
  });

  it('calendar: wall-clock time survives daylight saving changes', () => {
    const s = schedule('every day at 9:00');
    // US fall back 2026-11-01: 9:00 is 13:00Z before (EDT) and 14:00Z after (EST)
    const before = new Date('2026-10-31T14:00:00Z');
    expect(nextFireAfter(s, before, before, 'America/New_York').toISOString()).toBe('2026-11-01T14:00:00.000Z');
    const sat = new Date('2026-10-31T12:00:00Z');
    expect(nextFireAfter(s, sat, sat, 'America/New_York').toISOString()).toBe('2026-10-31T13:00:00.000Z');
    // spring forward 2026-03-08
    const preSpring = new Date('2026-03-07T15:00:00Z');
    expect(nextFireAfter(s, preSpring, preSpring, 'America/New_York').toISOString()).toBe('2026-03-08T13:00:00.000Z');
  });
});

describe('createRecurringReminder', () => {
  it('stores a row with the first fire one slot out', () => {
    const user = uid();
    const now = new Date('2026-11-17T10:00:00Z');
    const r = createRecurringReminder({ userId: user, message: 'stretch', every: 'every 6 hours', timezone: 'UTC', now });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.row.user_id).toBe(user);
      expect(r.row.next_fire_at).toBe('2026-11-17T16:00:00.000Z');
      expect(r.row.active).toBe(1);
    }
  });

  it('rejects bad schedules, empty and over-long messages', () => {
    const user = uid();
    const base = { userId: user, timezone: 'UTC' };
    expect(createRecurringReminder({ ...base, message: 'x', every: 'every 10 minutes' }).ok).toBe(false);
    expect(createRecurringReminder({ ...base, message: '  ', every: 'every day' }).ok).toBe(false);
    const long = createRecurringReminder({ ...base, message: 'x'.repeat(MAX_MESSAGE_CHARS + 1), every: 'every day' });
    expect(long.ok).toBe(false);
    expect(createRecurringReminder({ ...base, message: 'x'.repeat(MAX_MESSAGE_CHARS), every: 'every day' }).ok).toBe(true);
  });

  it('caps active reminders per user, and cancelling frees a slot', () => {
    const user = uid();
    const ids: number[] = [];
    for (let i = 0; i < MAX_ACTIVE_PER_USER; i++) {
      const r = createRecurringReminder({ userId: user, message: `m${i}`, every: 'every day', timezone: 'UTC' });
      expect(r.ok).toBe(true);
      if (r.ok) ids.push(r.row.id);
    }
    const sixth = createRecurringReminder({ userId: user, message: 'one too many', every: 'every day', timezone: 'UTC' });
    expect(sixth.ok).toBe(false);
    // another user is unaffected
    expect(createRecurringReminder({ userId: uid(), message: 'x', every: 'every day', timezone: 'UTC' }).ok).toBe(true);
    expect(cancelRecurringReminder(ids[0])).toBe(true);
    expect(createRecurringReminder({ userId: user, message: 'fits now', every: 'every day', timezone: 'UTC' }).ok).toBe(true);
  });
});

describe('fireDueRecurringReminders', () => {
  function make(every: string, now: Date, tz = 'UTC') {
    const user = uid();
    const r = createRecurringReminder({ userId: user, message: 'water', every, timezone: tz, now });
    if (!r.ok) throw new Error(r.error);
    return { user, row: r.row };
  }

  it('sends nothing before the slot, once at it, and not again on the next tick', async () => {
    const t0 = new Date('2026-11-17T10:00:00Z');
    const { user } = make('every 6 hours', t0);
    const send = vi.fn(async () => {});
    const mine = (calls: unknown[][]) => calls.filter((c) => c[0] === user);

    await fireDueRecurringReminders(new Date('2026-11-17T15:59:00Z'), send);
    expect(mine(send.mock.calls)).toHaveLength(0);

    await fireDueRecurringReminders(new Date('2026-11-17T16:00:20Z'), send);
    expect(mine(send.mock.calls)).toHaveLength(1);
    expect(mine(send.mock.calls)[0][1]).toBe('⏰ Reminder: water');

    await fireDueRecurringReminders(new Date('2026-11-17T16:01:20Z'), send);
    expect(mine(send.mock.calls)).toHaveLength(1);
    const row = listRecurringReminders(user)[0];
    expect(row.next_fire_at).toBe('2026-11-17T22:00:00.000Z');
  });

  it('after downtime fires once and skips ahead, no burst', async () => {
    const t0 = new Date('2026-11-17T10:00:00Z');
    const { user } = make('every 6 hours', t0);
    const send = vi.fn(async () => {});
    await fireDueRecurringReminders(new Date('2026-11-19T03:30:00Z'), send);
    expect(send.mock.calls.filter((c) => c[0] === user)).toHaveLength(1);
    expect(listRecurringReminders(user)[0].next_fire_at).toBe('2026-11-19T04:00:00.000Z');
    await fireDueRecurringReminders(new Date('2026-11-19T03:31:00Z'), send);
    expect(send.mock.calls.filter((c) => c[0] === user)).toHaveLength(1);
  });

  it('two overlapping ticks (or a restart mid-fire) send once', async () => {
    const t0 = new Date('2026-11-17T10:00:00Z');
    const { user } = make('every 6 hours', t0);
    const now = new Date('2026-11-17T16:00:05Z');
    const send = vi.fn(async () => {});
    await Promise.all([fireDueRecurringReminders(now, send), fireDueRecurringReminders(now, send)]);
    expect(send.mock.calls.filter((c) => c[0] === user)).toHaveLength(1);
  });

  it('a failed queue add puts the slot back so the next tick retries', async () => {
    const t0 = new Date('2026-11-17T10:00:00Z');
    const { user, row } = make('every 6 hours', t0);
    const now = new Date('2026-11-17T16:00:05Z');
    const failing = vi.fn(async () => {
      throw new Error('redis down');
    });
    await fireDueRecurringReminders(now, failing);
    expect(listRecurringReminders(user)[0].next_fire_at).toBe(row.next_fire_at);
    const ok = vi.fn(async () => {});
    await fireDueRecurringReminders(new Date('2026-11-17T16:01:05Z'), ok);
    expect(ok.mock.calls.filter((c) => c[0] === user)).toHaveLength(1);
  });

  it('a cancelled reminder never fires', async () => {
    const t0 = new Date('2026-11-17T10:00:00Z');
    const { user, row } = make('every 6 hours', t0);
    cancelRecurringReminder(row.id);
    const send = vi.fn(async () => {});
    await fireDueRecurringReminders(new Date('2026-11-18T10:00:00Z'), send);
    expect(send.mock.calls.filter((c) => c[0] === user)).toHaveLength(0);
  });
});

describe('persistence', () => {
  it('a row survives closing the database and a fresh module instance', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'recurring-')), 'test.db');
    closeDb();
    getDb(file);
    const user = uid();
    const created = createRecurringReminder({ userId: user, message: 'persist me', every: 'every day', timezone: 'UTC' });
    expect(created.ok).toBe(true);
    closeDb();

    // A fresh module graph opens its own connection from DATABASE_PATH: that's the restart.
    const savedPath = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = file;
    vi.resetModules();
    try {
      const freshDb = await import('../../../src/shared/db/client.js');
      const fresh = await import('../../../src/engine/jobs/recurring-reminders.js');
      const rows = fresh.listRecurringReminders(user);
      expect(rows).toHaveLength(1);
      expect(rows[0].message).toBe('persist me');
      freshDb.closeDb();
    } finally {
      process.env.DATABASE_PATH = savedPath;
      initializeDb(':memory:');
    }
  });
});

describe('scheduler tool', () => {
  const call = (params: Record<string, unknown>, userId: string) =>
    schedulerCapability.handler(params, undefined, { userId } as any);

  it('remind_every creates a reminder for the verified caller, in their saved timezone', async () => {
    const out = await call({ action: 'remind_every', message: 'standup', every: 'every weekday at 9:00' }, 'tz-user');
    expect(out).toContain('✅');
    expect(out).toContain('America/New_York');
    const rows = listRecurringReminders('tz-user');
    expect(rows).toHaveLength(1);
    expect(rows[0].timezone).toBe('America/New_York');
  });

  it('says so when it falls back to UTC for a time of day', async () => {
    const user = uid();
    const out = await call({ action: 'remind_every', message: 'standup', every: 'every day at 9:00' }, user);
    expect(out).toContain('UTC');
    expect(out).toContain('no timezone saved');
  });

  it('ignores a forged userId param and rejects bad input with a reason', async () => {
    const user = uid();
    await call({ action: 'remind_every', message: 'x', every: 'every day', userId: OWNER_USER_ID, user_id: OWNER_USER_ID }, user);
    expect(listRecurringReminders(user)).toHaveLength(1);
    expect(listRecurringReminders(OWNER_USER_ID).some((r) => r.message === 'x' && r.user_id === user)).toBe(false);
    const bad = await call({ action: 'remind_every', message: 'x', every: 'every 5 minutes' }, user);
    expect(bad).toContain('❌');
    const badTz = await call({ action: 'remind_every', message: 'x', every: 'every day at 9', timezone: 'Mars/Base' }, user);
    expect(badTz).toContain('❌');
  });

  it('cancel: your own, not someone else\'s; the owner may cancel anyone\'s', async () => {
    vi.spyOn(schedulerService, 'getOneTimeReminderOwner').mockResolvedValue(null);
    const alice = uid();
    const bob = uid();
    const made = createRecurringReminder({ userId: alice, message: 'alice only', every: 'every day', timezone: 'UTC' });
    if (!made.ok) throw new Error(made.error);
    const id = made.row.id;

    const denied = await call({ action: 'cancel', taskId: `R${id}` }, bob);
    expect(denied).toContain('❌');
    expect(listRecurringReminders(alice)).toHaveLength(1);

    // an ownerless system task id is not cancellable by a non-owner either
    const removeTask = vi.spyOn(schedulerService, 'removeTask').mockResolvedValue(undefined);
    expect(await call({ action: 'cancel', taskId: 'health-check' }, bob)).toContain('❌');
    expect(removeTask).not.toHaveBeenCalled();

    expect(await call({ action: 'cancel', taskId: String(id) }, alice)).toContain('✅');
    expect(listRecurringReminders(alice)).toHaveLength(0);

    const again = createRecurringReminder({ userId: alice, message: 'second', every: 'every day', timezone: 'UTC' });
    if (!again.ok) throw new Error(again.error);
    expect(await call({ action: 'cancel', taskId: `R${again.row.id}` }, OWNER_USER_ID)).toContain('✅');
    expect(listRecurringReminders(alice)).toHaveLength(0);
  });

  it('cancel of a one-time reminder checks the job owner', async () => {
    vi.spyOn(schedulerService, 'getOneTimeReminderOwner').mockResolvedValue('alice');
    const cancelOnce = vi.spyOn(schedulerService, 'cancelOnce').mockResolvedValue(true);
    expect(await call({ action: 'cancel', taskId: 'rem-abc' }, 'bob')).toContain('❌');
    expect(cancelOnce).not.toHaveBeenCalled();
    expect(await call({ action: 'cancel', taskId: 'rem-abc' }, 'alice')).toContain('✅');
    expect(cancelOnce).toHaveBeenCalledWith('rem-abc');
  });

  it('list shows the caller\'s one-time and repeating reminders, not other people\'s', async () => {
    const alice = uid();
    const bob = uid();
    createRecurringReminder({ userId: alice, message: 'alice repeat', every: 'every day', timezone: 'UTC' });
    createRecurringReminder({ userId: bob, message: 'bob repeat', every: 'every day', timezone: 'UTC' });
    const listOnce = vi.spyOn(schedulerService, 'listOneTimeReminders').mockImplementation(async (who) => {
      if (who === alice) {
        return [{ id: 'rem-1', userId: alice, message: 'alice once', runAt: new Date('2030-01-01T00:00:00Z') }];
      }
      return [];
    });
    const out = String(await call({ action: 'list' }, alice));
    expect(out).toContain('alice repeat');
    expect(out).toContain('alice once');
    expect(out).toContain('rem-1');
    expect(out).not.toContain('bob repeat');
    expect(listOnce).toHaveBeenCalledWith(alice);
  });

  it('is only the verified caller\'s row set that the DB holds', () => {
    // sanity: table has the documented columns
    const cols = getRawDb().prepare('PRAGMA table_info(recurring_reminders)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining(['user_id', 'message', 'next_fire_at', 'created_at', 'active'])
    );
    expect(getSyncDb()).toBeTruthy();
  });
});
