/**
 * Scheduler dispatch (2026-10-31): jobs route on data.type, not the free-text BullMQ name.
 * `remind` names its jobs `reminder-<ts>`, so dispatching on the name dropped every one-time
 * reminder into the unknown branch. No Redis: the service's queues are swapped for fakes.
 */
import { describe, it, expect, vi } from 'vitest';
import { logger } from '../../../src/shared/logger.js';
import { SchedulerService, resolveJobType } from '../../../src/engine/jobs/scheduler.js';
import { schedulerCapability } from '../../../src/engine/tools/core/reminders.js';

function fakeQueue() {
  const added: Array<{ name: string; data: Record<string, unknown> }> = [];
  return {
    added,
    async add(name: string, data: Record<string, unknown>) {
      added.push({ name, data });
      return { id: String(added.length) };
    },
  };
}

function serviceWithFakes() {
  const svc = new SchedulerService();
  const discord = fakeQueue();
  const incoming = fakeQueue();
  const s = svc as any;
  s.discordQueue = discord;
  s.incomingQueue = incoming;
  return { svc, s, discord, incoming };
}

describe('resolveJobType', () => {
  it('routes reminders by data.type, whatever the job is named', () => {
    expect(resolveJobType('reminder-1761900000000', { type: 'user-reminder' })).toBe('user-reminder');
    expect(resolveJobType('user-reminder', { meetingId: 3 })).toBe('user-reminder');
  });

  it('keeps the built-in crons whose data.type is descriptive, not a handler', () => {
    expect(resolveJobType('health-check', { type: 'system-health' })).toBe('health-check');
    expect(resolveJobType('daily-summary', { type: 'daily-report' })).toBe('daily-summary');
    expect(resolveJobType('cleanup-old-data', { type: 'system-cleanup' })).toBe('cleanup-old-data');
    expect(resolveJobType('heartbeat-immediate', { type: 'heartbeat' })).toBe('heartbeat');
  });

  it('has no handler for user-task or orphans', () => {
    expect(resolveJobType('water plants', { type: 'user-task' })).toBe('');
    expect(resolveJobType('moltbook-social', {})).toBe('');
  });
});

describe('executeScheduledJob', () => {
  it('a reminder-<ts> job DMs the person who set it', async () => {
    const { s, discord } = serviceWithFakes();
    await s.executeScheduledJob({
      name: 'reminder-1761900000000',
      data: { type: 'user-reminder', message: 'stretch', userId: 'u-1', reminderType: 'one-time' },
    });
    expect(discord.added).toHaveLength(1);
    expect(discord.added[0].data).toMatchObject({ userId: 'u-1', content: '⏰ Reminder: stretch' });
  });

  it('an unknown repeatable errors once per boot, then goes quiet', async () => {
    const { s } = serviceWithFakes();
    const err = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    try {
      const job = { id: 'repeat:x', name: 'moltbook-social', data: { taskId: 'moltbook-social' } };
      await s.executeScheduledJob(job);
      await s.executeScheduledJob(job);
      await s.executeScheduledJob(job);
      const unknownErrors = err.mock.calls.filter((c) => String(c[0]).includes('Unknown scheduled job'));
      expect(unknownErrors).toHaveLength(1);
      expect(String(unknownErrors[0][0])).toContain('moltbook-social');
    } finally {
      err.mockRestore();
    }
  });
});

describe('scheduler tool', () => {
  it('refuses recurring user tasks instead of claiming success', async () => {
    const out = await schedulerCapability.handler(
      { action: 'schedule', name: 'water plants', cron: '0 9 * * *' },
      undefined,
      { userId: 'u-1' } as any
    );
    expect(String(out)).not.toContain('✅');
    expect(String(out)).toContain('remind_every');
  });
});
