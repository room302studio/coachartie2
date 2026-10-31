/**
 * Meetings (2026-10-31): the reminder INSERT named a scheduler_job_id column that prod never
 * had, so createMeeting threw after the reminder job was already queued, and the reminder
 * fired even for a meeting the user then cancelled. Temp DATABASE_PATH; the scheduler's
 * Redis side is spied or faked.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { getRawDb, getSyncDb } from '../../../../src/shared/db/client.js';
import { MeetingService } from '../../../../src/engine/tools/people/meeting.js';
import { SchedulerService, schedulerService } from '../../../../src/engine/jobs/scheduler.js';

const FUTURE = '2030-01-15T15:00:00Z';

function meetingsTitled(title: string): Array<{ id: number; status: string }> {
  return getSyncDb().all('SELECT id, status FROM meetings WHERE title = ?', [title]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MeetingService.createMeeting', () => {
  it('saves the meeting and its reminder row, then queues the reminder under a known id', async () => {
    const scheduleOnce = vi.spyOn(schedulerService, 'scheduleOnce').mockResolvedValue(undefined);
    const title = `sync-${randomUUID()}`;

    const out = await MeetingService.getInstance().createMeeting('u-1', title, FUTURE, ['<@123>']);

    expect(out).toContain('✅');
    const [meeting] = meetingsTitled(title);
    expect(meeting).toBeDefined();
    const reminders = getSyncDb().all('SELECT * FROM meeting_reminders WHERE meeting_id = ?', [meeting.id]);
    expect(reminders).toHaveLength(1);
    expect(scheduleOnce).toHaveBeenCalledTimes(1);
    expect(scheduleOnce.mock.calls[0][3]).toBe(`meeting-reminder-${meeting.id}`);
  });

  it('a failed insert rolls back and never queues a reminder', async () => {
    const scheduleOnce = vi.spyOn(schedulerService, 'scheduleOnce').mockResolvedValue(undefined);
    const title = `doomed-${randomUUID()}`;
    // Connection-local trigger: makes this one insert fail without touching other test files.
    getRawDb().exec(
      `CREATE TEMP TRIGGER fail_meeting_reminder BEFORE INSERT ON meeting_reminders
       BEGIN SELECT RAISE(ABORT, 'reminder insert failed'); END`
    );
    try {
      await expect(
        MeetingService.getInstance().createMeeting('u-1', title, FUTURE, ['<@123>'])
      ).rejects.toThrow();
    } finally {
      getRawDb().exec('DROP TRIGGER IF EXISTS temp.fail_meeting_reminder');
    }
    expect(scheduleOnce).not.toHaveBeenCalled();
    expect(meetingsTitled(title)).toHaveLength(0);
  });
});

describe('meeting cancel', () => {
  it('removes the queued reminder and a late-firing one stays silent', async () => {
    vi.spyOn(schedulerService, 'scheduleOnce').mockResolvedValue(undefined);
    const cancelOnce = vi.spyOn(schedulerService, 'cancelOnce').mockResolvedValue(true);
    const title = `cancel-me-${randomUUID()}`;
    await MeetingService.getInstance().createMeeting('u-1', title, FUTURE, ['<@123>']);
    const [meeting] = meetingsTitled(title);

    await MeetingService.getInstance().cancelMeeting('u-1', meeting.id);
    expect(cancelOnce).toHaveBeenCalledWith(`meeting-reminder-${meeting.id}`);

    // The job fires anyway (removal is best effort): nothing may be queued.
    const svc = new SchedulerService() as any;
    const added: string[] = [];
    const fake = {
      async add(name: string) {
        added.push(name);
        return { id: '1' };
      },
    };
    svc.discordQueue = fake;
    svc.incomingQueue = fake;
    await svc.executeScheduledJob({
      name: 'user-reminder',
      data: { type: 'user-reminder', userId: 'u-1', reminderType: 'meeting-reminder', meetingId: meeting.id },
    });
    expect(added).toEqual([]);
  });
});
