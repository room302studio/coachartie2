import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';

const {
  transcribeWavMock,
  generateScribeSummaryMock,
  submitScribeProposalsMock,
  getBrownoutModeMock,
  sendChunkedChannelMessageMock,
} = vi.hoisted(() => ({
  transcribeWavMock: vi.fn(),
  generateScribeSummaryMock: vi.fn(),
  submitScribeProposalsMock: vi.fn(),
  getBrownoutModeMock: vi.fn(),
  sendChunkedChannelMessageMock: vi.fn(),
}));

vi.mock('../../../../src/engine/jobs/scribe/stt.js', () => ({
  transcribeWav: transcribeWavMock,
}));
vi.mock('../../../../src/engine/jobs/scribe/summary.js', () => ({
  generateScribeSummary: generateScribeSummaryMock,
}));
vi.mock('../../../../src/engine/jobs/scribe/propose.js', () => ({
  submitScribeProposals: submitScribeProposalsMock,
}));
vi.mock('../../../../src/engine/budget/brownout.js', () => ({
  getBrownoutMode: getBrownoutModeMock,
}));
vi.mock('../../../../src/gateway/api.js', () => ({
  sendChunkedChannelMessage: sendChunkedChannelMessageMock,
}));

import {
  scribeCanStart,
  startScribeSession,
  submitScribeUtterance,
  stopScribeSession,
  getScribeStatus,
  scribeMaxAudioSeconds,
} from '../../../../src/engine/jobs/scribe/orchestrator.js';
import { optOut, optIn } from '../../../../src/shared/privacy-opt-out.js';
import { addScribeUsage, getScribeSession } from '../../../../src/shared/db/scribe-store.js';

function freshSession(guildId = `guild-${randomUUID()}`) {
  const { sessionId } = startScribeSession({
    guildId,
    voiceChannelId: 'voice-1',
    textChannelId: 'text-1',
    startedBy: 'owner-1',
  });
  return { sessionId, guildId };
}

beforeEach(() => {
  transcribeWavMock.mockReset().mockResolvedValue({ text: 'hello world', model: 'openai/whisper-large-v3-turbo' });
  generateScribeSummaryMock.mockReset().mockResolvedValue({ summaryText: 'Decisions: shipped it.', proposals: [] });
  submitScribeProposalsMock.mockReset().mockResolvedValue([]);
  getBrownoutModeMock.mockReset().mockResolvedValue({ mode: 'normal', runwayHours: 100 });
  sendChunkedChannelMessageMock.mockReset().mockResolvedValue({ status: 200, body: {} });
});

describe('scribeCanStart', () => {
  it('refuses when brownout is critical', async () => {
    getBrownoutModeMock.mockResolvedValue({ mode: 'critical', runwayHours: 1 });
    const result = await scribeCanStart();
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('allows when brownout is normal or lean', async () => {
    getBrownoutModeMock.mockResolvedValue({ mode: 'lean', runwayHours: 10 });
    expect((await scribeCanStart()).allowed).toBe(true);
    getBrownoutModeMock.mockResolvedValue({ mode: 'normal', runwayHours: 100 });
    expect((await scribeCanStart()).allowed).toBe(true);
  });
});

describe('startScribeSession', () => {
  it('creates an active session row', () => {
    const { sessionId, guildId } = freshSession();
    const session = getScribeSession(sessionId);
    expect(session?.status).toBe('active');
    expect(session?.guildId).toBe(guildId);
    expect(getScribeStatus(guildId)?.sessionId).toBe(sessionId);
  });
});

describe('submitScribeUtterance: opt-out and blocked filtering', () => {
  it('rejects an opted-out speaker without calling STT', async () => {
    const { sessionId } = freshSession();
    const userId = `user-${randomUUID()}`;
    optOut(userId, ['scribe-test-user']);
    try {
      const result = await submitScribeUtterance({
        sessionId,
        userId,
        displayName: 'Opted Out Person',
        wavBase64: Buffer.from('fake').toString('base64'),
        startedAt: new Date().toISOString(),
        durationSeconds: 1,
      });
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('opted-out-or-blocked');
      expect(transcribeWavMock).not.toHaveBeenCalled();
    } finally {
      optIn(userId);
    }
  });

  it('transcribes and stores an utterance for a normal speaker', async () => {
    const { sessionId } = freshSession();
    const result = await submitScribeUtterance({
      sessionId,
      userId: 'user-normal',
      displayName: 'Normal Person',
      wavBase64: Buffer.from('fake').toString('base64'),
      startedAt: new Date().toISOString(),
      durationSeconds: 1.5,
    });
    expect(result.accepted).toBe(true);
    expect(result.text).toBe('hello world');
    expect(transcribeWavMock).toHaveBeenCalledTimes(1);
  });

  it('rejects when there is no active session for that id', async () => {
    const result = await submitScribeUtterance({
      sessionId: 'no-such-session',
      userId: 'user-1',
      displayName: 'X',
      wavBase64: 'Zg==',
      startedAt: new Date().toISOString(),
      durationSeconds: 1,
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('no-active-session');
    expect(transcribeWavMock).not.toHaveBeenCalled();
  });
});

describe('submitScribeUtterance: audio cap', () => {
  it('stops transcribing once the session hits SCRIBE_MAX_AUDIO_MIN, without calling STT', async () => {
    const { sessionId } = freshSession();
    addScribeUsage(sessionId, scribeMaxAudioSeconds(), 0);

    const result = await submitScribeUtterance({
      sessionId,
      userId: 'user-1',
      displayName: 'X',
      wavBase64: 'Zg==',
      startedAt: new Date().toISOString(),
      durationSeconds: 1,
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('audio-cap-reached');
    expect(transcribeWavMock).not.toHaveBeenCalled();
    expect(getScribeSession(sessionId)?.capped).toBe(true);
  });
});

describe('stopScribeSession', () => {
  it('generates a summary, posts it, and reports zero pending actions when there are none', async () => {
    const { sessionId, guildId } = freshSession();
    await submitScribeUtterance({
      sessionId,
      userId: 'user-1',
      displayName: 'EJ',
      wavBase64: 'Zg==',
      startedAt: new Date().toISOString(),
      durationSeconds: 1,
    });

    const result = await stopScribeSession(sessionId, 'manual-stop');
    expect(result.pendingCount).toBe(0);
    expect(result.posted).toBe(true);
    expect(sendChunkedChannelMessageMock).toHaveBeenCalledTimes(1);
    const [channelId, text] = sendChunkedChannelMessageMock.mock.calls[0];
    expect(channelId).toBe('text-1');
    expect(text).toContain('Decisions: shipped it.');
    expect(getScribeSession(sessionId)?.status).toBe('stopped');
    expect(getScribeStatus(guildId)).toBeNull();
  });

  it('surfaces pending GitHub approval ids in the posted summary', async () => {
    const { sessionId } = freshSession();
    generateScribeSummaryMock.mockResolvedValue({
      summaryText: 'Action items: file the bug.',
      proposals: [{ kind: 'create', repo: 'owner/repo', title: 'Bug', body: 'x' }],
    });
    submitScribeProposalsMock.mockResolvedValue([
      { proposal: { kind: 'create', repo: 'owner/repo', title: 'Bug', body: 'x' }, message: 'pending #11', pendingId: 11 },
    ]);

    const result = await stopScribeSession(sessionId, 'manual-stop');
    expect(result.pendingCount).toBe(1);
    const [, text] = sendChunkedChannelMessageMock.mock.calls[0];
    expect(text).toContain('#11');
  });

  it('still posts a fallback summary if the summary LLM call throws', async () => {
    generateScribeSummaryMock.mockRejectedValue(new Error('model unavailable'));
    const { sessionId } = freshSession();

    const result = await stopScribeSession(sessionId, 'manual-stop');
    expect(result.posted).toBe(true);
    const [, text] = sendChunkedChannelMessageMock.mock.calls[0];
    expect(text).toContain('model unavailable');
    expect(getScribeSession(sessionId)?.status).toBe('stopped');
  });

  it('throws for an unknown session id', async () => {
    await expect(stopScribeSession('nope', 'manual-stop')).rejects.toThrow();
  });
});
