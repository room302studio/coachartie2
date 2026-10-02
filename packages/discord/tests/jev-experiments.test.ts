import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { logger } from '@coachartie/shared';
import {
  shadowQuizJudge,
  shadowSpeakGate,
  shadowSteamReview,
  positiveProbability,
  STEAM_REVIEW_THEMES,
} from '../src/services/jev-experiments.js';

const flush = () => new Promise((r) => setTimeout(r, 0));
const jevReply = (answers: object) =>
  vi.fn().mockResolvedValue({ ok: true, json: async () => ({ answers }) });

describe('discord jev shadow experiments', () => {
  let info: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    process.env.JEV_API_KEY = 'test-key';
    process.env.KILL_SWITCH_PATH = join(tmpdir(), 'jev-no-such-kill-switch');
    info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
  });
  afterEach(() => {
    delete process.env.JEV_API_KEY;
    delete process.env.KILL_SWITCH_PATH;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does nothing without a key', async () => {
    delete process.env.JEV_API_KEY;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    shadowQuizJudge({ question: 'q', correctAnswer: 'a', userAnswer: 'b' }, true, 1);
    shadowSpeakGate({ message: 'hi', channelContext: '' }, { verdict: false, fallback: false }, 1);
    shadowSteamReview({ text: 'great', verdict: '👍', hours: '3' });
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('quiz-judge sends structured state and compares verdicts', async () => {
    const fetch = jevReply({ q: { type: 'noul', noul: 0.2 } });
    vi.stubGlobal('fetch', fetch);
    shadowQuizJudge({ question: 'Capital of France?', correctAnswer: 'Paris', userAnswer: 'paris' }, true, 80);
    await flush();
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.state).toEqual({ question: 'Capital of France?', correctAnswer: 'Paris', userAnswer: 'paris' });
    expect(body.questions.q.type).toBe('noul');
    expect(info).toHaveBeenCalledWith(
      '[jev-shadow]',
      expect.objectContaining({ experiment: 'quiz-judge', micro: true, jev: false, agree: false, microMs: 80 })
    );
  });

  it('quiz-judge marks a null verdict as a fallback with no agreement', async () => {
    vi.stubGlobal('fetch', jevReply({ q: { type: 'noul', noul: 0.95 } }));
    shadowQuizJudge({ question: 'q', correctAnswer: 'a', userAnswer: 'a' }, null, 5);
    await flush();
    const rec = info.mock.calls[0][1];
    expect(rec).toMatchObject({ microFallback: true, jev: true });
    expect(rec.agree).toBeUndefined();
  });

  it('speak-gate logs yes-probability next to the verdict, plus message kind, and clips context', async () => {
    const fetch = jevReply({
      answer: { type: 'noul', noul: 0.83 },
      kind: { type: 'choice', choice: 'question', probabilities: { question: 0.7 }, confidence: 0.5 },
    });
    vi.stubGlobal('fetch', fetch);
    shadowSpeakGate(
      { message: 'how do I fix the signal deadlock?', channelContext: 'k'.repeat(2000) },
      { verdict: false, fallback: false },
      400
    );
    await flush();
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(Object.keys(body.state)).toEqual(['message', 'channelContext']);
    expect(body.state.channelContext.length).toBe(500);
    expect(info.mock.calls[0][1]).toMatchObject({
      experiment: 'speak-gate',
      micro: false,
      jev: true,
      jevProbability: 0.83,
      agree: false,
      parts: { kind: { jev: 'question' } },
    });
  });

  it('steam-themes compares sentiment with the thumbs and logs a theme', async () => {
    const fetch = jevReply({
      theme: { type: 'choice', choice: 'performance', probabilities: { performance: 0.9 }, confidence: 0.85 },
      sentiment: {
        type: 'score',
        score: 0.6,
        probabilities: { '0': 0.5, '1': 0.4, '2': 0.1, '3': 0, '4': 0 },
        confidence: 0.6,
      },
    });
    vi.stubGlobal('fetch', fetch);
    shadowSteamReview({ text: 'lags hard past 50 stations', verdict: '👎', hours: '12.0' });
    await flush();
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(Object.keys(body.questions.theme.criteria)).toEqual(Object.keys(STEAM_REVIEW_THEMES));
    expect(body.questions.sentiment.type).toBe('score');
    expect(info.mock.calls[0][1]).toMatchObject({
      experiment: 'steam-themes',
      micro: 'negative',
      jev: 'negative',
      agree: true,
      parts: { theme: { jev: 'performance' }, sentiment: { jev: 0.6 } },
    });
  });

  it('positiveProbability counts the top levels and half of mixed', () => {
    expect(
      positiveProbability({ type: 'score', probabilities: { '0': 0, '1': 0.2, '2': 0.2, '3': 0.3, '4': 0.3 } })
    ).toBeCloseTo(0.7);
  });
});
