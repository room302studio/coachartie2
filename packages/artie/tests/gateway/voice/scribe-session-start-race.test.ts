/**
 * C14 (state-machine audit 2026-10-31): startVoiceScribeSession checked activeSessions.has(),
 * then awaited the brownout check, a 15s voice join and the session create before set(), so a
 * /scribe and an auto-start in that window both joined. The guild is now reserved up front.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const { scribeCanStartMock, scribeStartMock, scribeStopMock } = vi.hoisted(() => ({
  scribeCanStartMock: vi.fn(),
  scribeStartMock: vi.fn(),
  scribeStopMock: vi.fn(),
}));

vi.mock('../../../src/engine/api.js', () => ({
  scribeCanStart: scribeCanStartMock,
  scribeStart: scribeStartMock,
  scribeStop: scribeStopMock,
}));

vi.mock('@discordjs/voice', () => ({
  joinVoiceChannel: vi.fn(() => ({
    receiver: { speaking: { on: vi.fn(), off: vi.fn() } },
    on: vi.fn(),
    destroy: vi.fn(),
  })),
  entersState: vi.fn(async () => undefined),
  VoiceConnectionStatus: { Ready: 'ready', Disconnected: 'disconnected' },
  EndBehaviorType: { AfterSilence: 1 },
}));

import {
  startVoiceScribeSession,
  stopVoiceScribeSession,
} from '../../../src/gateway/voice/scribe-session.js';

function channelIn(guildId: string) {
  return {
    id: `voice-${guildId}`,
    guild: { id: guildId, voiceAdapterCreator: vi.fn() },
    members: new Map(),
  } as never;
}

afterEach(async () => {
  scribeStopMock.mockResolvedValue({ pendingCount: 0, posted: false });
  await stopVoiceScribeSession('race-guild', 'test-cleanup');
  await stopVoiceScribeSession('auto-guild', 'test-cleanup');
  vi.clearAllMocks();
});

describe('startVoiceScribeSession', () => {
  it('a second start while the first is still joining is refused', async () => {
    let allow: (v: { allowed: boolean }) => void = () => {};
    scribeCanStartMock.mockReturnValue(
      new Promise((resolve) => {
        allow = resolve;
      })
    );
    scribeStartMock.mockResolvedValue({ sessionId: 'session-1' });

    const first = startVoiceScribeSession({
      client: {} as never,
      channel: channelIn('race-guild'),
      textChannelId: 'text-1',
      startedBy: 'owner',
    });
    const second = await Promise.race([
      startVoiceScribeSession({
        client: {} as never,
        channel: channelIn('race-guild'),
        textChannelId: 'text-1',
        startedBy: 'auto',
        summaryOnly: true,
      }),
      new Promise((resolve) => setTimeout(() => resolve('still-joining'), 200)),
    ]);
    expect(second).toMatchObject({ ok: false });

    allow({ allowed: true });
    expect(await first).toMatchObject({ ok: true, sessionId: 'session-1' });
    expect(scribeStartMock).toHaveBeenCalledTimes(1);
  });

  it('an auto-scribe (summaryOnly) start still skips the brownout gate', async () => {
    scribeStartMock.mockResolvedValue({ sessionId: 'session-auto' });
    const result = await startVoiceScribeSession({
      client: {} as never,
      channel: channelIn('auto-guild'),
      textChannelId: 'text-1',
      startedBy: 'auto',
      summaryOnly: true,
    });
    expect(result).toMatchObject({ ok: true, sessionId: 'session-auto' });
    expect(scribeCanStartMock).not.toHaveBeenCalled();
    expect(scribeStartMock).toHaveBeenCalledWith(expect.objectContaining({ summaryOnly: true }));
  });
});
