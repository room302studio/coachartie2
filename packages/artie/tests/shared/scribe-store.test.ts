import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { getSyncDb } from '../../src/shared/db/client.js';
import {
  createScribeSession,
  getScribeSession,
  getActiveScribeSessionForGuild,
  addScribeUsage,
  markScribeSessionCapped,
  finishScribeSession,
  appendScribeUtterance,
  listScribeUtterances,
  sweepExpiredScribeData,
} from '../../src/shared/db/scribe-store.js';

function newSessionId(): string {
  return randomUUID();
}

describe('scribe-store: sessions', () => {
  it('creates and reads back a session', () => {
    const sessionId = newSessionId();
    createScribeSession({
      sessionId,
      guildId: 'guild-1',
      voiceChannelId: 'voice-1',
      textChannelId: 'text-1',
      startedBy: 'owner-1',
    });
    const session = getScribeSession(sessionId);
    expect(session).not.toBeNull();
    expect(session?.status).toBe('active');
    expect(session?.audioSecondsUsed).toBe(0);
    expect(session?.capped).toBe(false);
    expect(session?.pendingActionIds).toEqual([]);
  });

  it('getActiveScribeSessionForGuild only returns an active session for that guild', () => {
    const sessionId = newSessionId();
    const guildId = `guild-active-${sessionId}`;
    createScribeSession({
      sessionId,
      guildId,
      voiceChannelId: 'voice-1',
      textChannelId: 'text-1',
      startedBy: 'owner-1',
    });
    expect(getActiveScribeSessionForGuild(guildId)?.sessionId).toBe(sessionId);
    expect(getActiveScribeSessionForGuild('no-such-guild')).toBeNull();

    finishScribeSession(sessionId, { summary: 'done', pendingActionIds: [], stopReason: 'test' });
    expect(getActiveScribeSessionForGuild(guildId)).toBeNull();
  });

  it('accumulates audio usage and cost across calls', () => {
    const sessionId = newSessionId();
    createScribeSession({
      sessionId,
      guildId: 'guild-2',
      voiceChannelId: 'voice-2',
      textChannelId: 'text-2',
      startedBy: 'owner-1',
    });
    addScribeUsage(sessionId, 10, 0.001);
    addScribeUsage(sessionId, 5, 0.0005);
    const session = getScribeSession(sessionId);
    expect(session?.audioSecondsUsed).toBeCloseTo(15, 5);
    expect(session?.sttCostUsd).toBeCloseTo(0.0015, 6);
  });

  it('marks a session capped and finishing records the summary/pending ids/stop reason', () => {
    const sessionId = newSessionId();
    createScribeSession({
      sessionId,
      guildId: 'guild-3',
      voiceChannelId: 'voice-3',
      textChannelId: 'text-3',
      startedBy: 'owner-1',
    });
    markScribeSessionCapped(sessionId);
    finishScribeSession(sessionId, {
      summary: 'Decisions: shipped it.',
      pendingActionIds: [7, 9],
      stopReason: 'hard-cap',
    });
    const session = getScribeSession(sessionId);
    expect(session?.capped).toBe(true);
    expect(session?.status).toBe('stopped');
    expect(session?.summary).toBe('Decisions: shipped it.');
    expect(session?.pendingActionIds).toEqual([7, 9]);
    expect(session?.stopReason).toBe('hard-cap');
    expect(session?.endedAt).not.toBeNull();
  });
});

describe('scribe-store: utterances', () => {
  it('appends and lists utterances for a session, oldest first', () => {
    const sessionId = newSessionId();
    createScribeSession({
      sessionId,
      guildId: 'guild-4',
      voiceChannelId: 'voice-4',
      textChannelId: 'text-4',
      startedBy: 'owner-1',
    });
    appendScribeUtterance({
      sessionId,
      speakerId: 'user-1',
      displayName: 'EJ',
      text: 'first thing',
      ts: '2026-10-26T10:00:00.000Z',
      durationSeconds: 1.2,
    });
    appendScribeUtterance({
      sessionId,
      speakerId: 'user-2',
      displayName: 'Collaborator',
      text: 'second thing',
      ts: '2026-10-26T10:00:05.000Z',
      durationSeconds: 2.3,
    });
    const utterances = listScribeUtterances(sessionId);
    expect(utterances).toHaveLength(2);
    expect(utterances[0].text).toBe('first thing');
    expect(utterances[1].displayName).toBe('Collaborator');
  });
});

describe('scribe-store: retention sweep', () => {
  it('deletes sessions (and their utterances) older than the retention window, keeps recent ones', () => {
    const oldSessionId = newSessionId();
    const freshSessionId = newSessionId();
    createScribeSession({
      sessionId: oldSessionId,
      guildId: 'guild-5',
      voiceChannelId: 'voice-5',
      textChannelId: 'text-5',
      startedBy: 'owner-1',
    });
    appendScribeUtterance({
      sessionId: oldSessionId,
      speakerId: 'user-1',
      displayName: 'EJ',
      text: 'ancient text',
      ts: '2020-01-01T00:00:00.000Z',
      durationSeconds: 1,
    });
    createScribeSession({
      sessionId: freshSessionId,
      guildId: 'guild-5',
      voiceChannelId: 'voice-5',
      textChannelId: 'text-5',
      startedBy: 'owner-1',
    });

    // Backdate the old session's created_at directly — createScribeSession always stamps "now".
    getSyncDb().run(`UPDATE scribe_sessions SET created_at = '2020-01-01T00:00:00.000Z' WHERE session_id = ?`, [
      oldSessionId,
    ]);

    const result = sweepExpiredScribeData(7);
    expect(result.sessionsDeleted).toBe(1);
    expect(result.utterancesDeleted).toBe(1);
    expect(getScribeSession(oldSessionId)).toBeNull();
    expect(getScribeSession(freshSessionId)).not.toBeNull();
  });

  it('is a no-op when nothing has aged out', () => {
    const result = sweepExpiredScribeData(7);
    expect(result.sessionsDeleted).toBe(0);
    expect(result.utterancesDeleted).toBe(0);
  });
});
