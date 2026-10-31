/**
 * C13 (state-machine audit 2026-10-31): a crash left scribe_sessions rows 'active' forever (no
 * boot reconcile), and stopScribeSession had no 'active' guard, so a second stop ran the paid
 * summary and posted it again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';

const { generateScribeSummaryMock, sendChunkedChannelMessageMock } = vi.hoisted(() => ({
  generateScribeSummaryMock: vi.fn(),
  sendChunkedChannelMessageMock: vi.fn(),
}));

vi.mock('../../../../src/engine/jobs/scribe/summary.js', () => ({
  generateScribeSummary: generateScribeSummaryMock,
}));
vi.mock('../../../../src/engine/jobs/scribe/propose.js', () => ({
  submitScribeProposals: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../../src/gateway/api.js', () => ({
  sendChunkedChannelMessage: sendChunkedChannelMessageMock,
}));

import { startScribeSession, stopScribeSession } from '../../../../src/engine/jobs/scribe/orchestrator.js';
import {
  createScribeSession,
  getScribeSession,
  getActiveScribeSessionForGuild,
  endCrashedScribeSessions,
} from '../../../../src/shared/db/scribe-store.js';

beforeEach(() => {
  generateScribeSummaryMock.mockReset().mockResolvedValue({ summaryText: 'Decisions.', proposals: [] });
  sendChunkedChannelMessageMock.mockReset().mockResolvedValue({ status: 200, body: {} });
});

function start(): string {
  return startScribeSession({
    guildId: `guild-${randomUUID()}`,
    voiceChannelId: 'voice-1',
    textChannelId: 'text-1',
    startedBy: 'owner-1',
  }).sessionId;
}

describe('stopScribeSession guard', () => {
  it('a second stop does not summarize or post again', async () => {
    const sessionId = start();
    await stopScribeSession(sessionId, 'no-humans');
    const again = await stopScribeSession(sessionId, 'shutdown');
    expect(generateScribeSummaryMock).toHaveBeenCalledTimes(1);
    expect(sendChunkedChannelMessageMock).toHaveBeenCalledTimes(1);
    expect(again.posted).toBe(false);
    expect(getScribeSession(sessionId)?.stopReason).toBe('no-humans');
  });

  it('two concurrent stops summarize once', async () => {
    const sessionId = start();
    await Promise.all([
      stopScribeSession(sessionId, 'no-humans'),
      stopScribeSession(sessionId, 'shutdown'),
    ]);
    expect(generateScribeSummaryMock).toHaveBeenCalledTimes(1);
    expect(sendChunkedChannelMessageMock).toHaveBeenCalledTimes(1);
  });
});

describe('endCrashedScribeSessions (boot reconcile)', () => {
  it('closes rows a crash left active, and leaves finished ones alone', async () => {
    const guildId = `guild-${randomUUID()}`;
    const ghost = randomUUID();
    createScribeSession({
      sessionId: ghost,
      guildId,
      voiceChannelId: 'v',
      textChannelId: 't',
      startedBy: 'owner-1',
    });
    const finished = start();
    await stopScribeSession(finished, 'manual-stop');

    expect(endCrashedScribeSessions()).toBeGreaterThanOrEqual(1);

    const row = getScribeSession(ghost);
    expect(row?.status).toBe('error');
    expect(row?.stopReason).toBe('crash');
    expect(row?.endedAt).toBeTruthy();
    expect(getActiveScribeSessionForGuild(guildId)).toBeNull();
    expect(getScribeSession(finished)?.status).toBe('stopped');
    expect(getScribeSession(finished)?.stopReason).toBe('manual-stop');
  });
});
