import { describe, it, expect, vi } from 'vitest';
import {
  decideSpeakRoute,
  runSpeakGate,
  resolveAmbientMode,
  isReplyToBot,
  type SpeakInputs,
} from '../src/services/speak-gate.js';
import { shouldSkipPassiveGeneration } from '../../capabilities/src/queues/passive-observation.js';

const quiet: SpeakInputs = {
  botMentioned: false,
  repliedToBot: false,
  isDMAllowed: false,
  ambientCandidate: false,
  gateAlreadyPassed: false,
  ambientMode: 'gated',
};

describe('decideSpeakRoute', () => {
  it('@mention → addressed (persona model may run)', () => {
    expect(decideSpeakRoute({ ...quiet, botMentioned: true })).toEqual({ route: 'addressed' });
  });

  it('reply to Artie → addressed, even without a ping', () => {
    expect(decideSpeakRoute({ ...quiet, repliedToBot: true })).toEqual({ route: 'addressed' });
  });

  it('allowed DM → addressed', () => {
    expect(decideSpeakRoute({ ...quiet, isDMAllowed: true })).toEqual({ route: 'addressed' });
  });

  it('addressed wins even in a mention-only guild', () => {
    expect(decideSpeakRoute({ ...quiet, botMentioned: true, ambientMode: 'never' })).toEqual({
      route: 'addressed',
    });
  });

  it('other messages the router would not answer → silent, no gate call', () => {
    expect(decideSpeakRoute(quiet)).toMatchObject({ route: 'silent' });
  });

  it('other messages the router WOULD answer → must pass the cheap gate', () => {
    expect(decideSpeakRoute({ ...quiet, ambientCandidate: true })).toEqual({ route: 'gate' });
  });

  it('proactive path already judged yes → no second judgment', () => {
    expect(
      decideSpeakRoute({ ...quiet, ambientCandidate: true, gateAlreadyPassed: true })
    ).toEqual({ route: 'ambient-approved' });
  });

  it("ambientMode 'never' → silent without consulting the gate", () => {
    expect(
      decideSpeakRoute({ ...quiet, ambientCandidate: true, gateAlreadyPassed: true, ambientMode: 'never' })
    ).toMatchObject({ route: 'silent' });
  });
});

describe('runSpeakGate', () => {
  it('speaks only on an explicit true', async () => {
    expect(await runSpeakGate(async () => true)).toBe(true);
    expect(await runSpeakGate(async () => false)).toBe(false);
    expect(await runSpeakGate(async () => 'yes' as unknown as boolean)).toBe(false);
  });

  it('gate error → silent', async () => {
    expect(await runSpeakGate(async () => Promise.reject(new Error('402 Payment Required')))).toBe(false);
    expect(
      await runSpeakGate(() => {
        throw new Error('sync throw');
      })
    ).toBe(false);
  });

  it('gate timeout → silent', async () => {
    vi.useFakeTimers();
    const verdict = runSpeakGate(() => new Promise<boolean>(() => {}), 1000);
    vi.advanceTimersByTime(1001);
    expect(await verdict).toBe(false);
    vi.useRealTimers();
  });
});

describe('resolveAmbientMode', () => {
  it("defaults to 'gated' everywhere", () => {
    expect(resolveAmbientMode(null)).toBe('gated');
    expect(resolveAmbientMode({})).toBe('gated');
    expect(resolveAmbientMode({ ambientMode: 'never' })).toBe('never');
  });
});

describe('isReplyToBot', () => {
  const BOT = 'bot-id';
  const msg = (over: Record<string, unknown>) => over as never;

  it('not a reply → false', async () => {
    expect(await isReplyToBot(msg({ reference: null, mentions: { repliedUser: null } }), BOT)).toBe(false);
  });

  it('reply to Artie (repliedUser filled even without a ping) → true', async () => {
    expect(
      await isReplyToBot(msg({ reference: { messageId: '1' }, mentions: { repliedUser: { id: BOT } } }), BOT)
    ).toBe(true);
  });

  it('reply to someone else → false', async () => {
    expect(
      await isReplyToBot(msg({ reference: { messageId: '1' }, mentions: { repliedUser: { id: 'human' } } }), BOT)
    ).toBe(false);
  });

  it('falls back to fetching the reference, and a failed fetch is not addressed', async () => {
    const ok = msg({
      reference: { messageId: '1' },
      mentions: { repliedUser: null },
      fetchReference: async () => ({ author: { id: BOT } }),
    });
    expect(await isReplyToBot(ok, BOT)).toBe(true);
    const gone = msg({
      reference: { messageId: '1' },
      mentions: { repliedUser: null },
      fetchReference: async () => {
        throw new Error('Unknown Message');
      },
    });
    expect(await isReplyToBot(gone, BOT)).toBe(false);
  });
});

describe('passive Discord observation (capabilities worker)', () => {
  it('never generates on unaddressed Discord messages by default', () => {
    expect(shouldSkipPassiveGeneration({ source: 'discord', context: { shouldRespond: false } }, {})).toBe(true);
    expect(
      shouldSkipPassiveGeneration({ source: 'api', context: { shouldRespond: false, platform: 'discord' } }, {})
    ).toBe(true);
  });

  it('addressed messages and non-Discord passive traffic still generate', () => {
    expect(shouldSkipPassiveGeneration({ source: 'discord', context: { shouldRespond: true } }, {})).toBe(false);
    expect(shouldSkipPassiveGeneration({ source: 'discord', context: {} }, {})).toBe(false);
    expect(shouldSkipPassiveGeneration({ source: 'reddit' as never, context: { shouldRespond: false } }, {})).toBe(
      false
    );
  });

  it('PASSIVE_OBSERVATION_GENERATE=true restores the old behaviour', () => {
    expect(
      shouldSkipPassiveGeneration(
        { source: 'discord', context: { shouldRespond: false } },
        { PASSIVE_OBSERVATION_GENERATE: 'true' }
      )
    ).toBe(false);
  });
});
