import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@coachartie/shared';

const { shadowYesNo, shadowPickOne, shadowPreflightBatch, jevShadowEnabled } = await import(
  '../src/services/llm/jev-shadow.js'
);

const flush = () => new Promise((r) => setTimeout(r, 0));
const jevReply = (answers: object) =>
  vi.fn().mockResolvedValue({ ok: true, json: async () => ({ answers }) });

describe('jev shadow mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-shadow-'));
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.JEV_API_KEY = 'test-key';
    process.env.KILL_SWITCH_PATH = join(dir, 'KILL_SWITCH_absent');
    delete process.env.JEV_SHADOW;
    delete process.env.JEV_SHADOW_LOG;
    info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
  });
  afterEach(() => {
    delete process.env.JEV_API_KEY;
    delete process.env.KILL_SWITCH_PATH;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is off without a key, and makes no request', async () => {
    delete process.env.JEV_API_KEY;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    shadowYesNo('q?', 'ctx', { result: true, fallback: false }, 10);
    await flush();
    expect(jevShadowEnabled()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('JEV_SHADOW=0 turns it off even with a key', () => {
    process.env.JEV_SHADOW = '0';
    expect(jevShadowEnabled()).toBe(false);
  });

  it('sends a noul for askYesNo and records agreement', async () => {
    const fetch = jevReply({ q: { type: 'noul', noul: 0.9 } });
    vi.stubGlobal('fetch', fetch);
    shadowYesNo('Is this urgent?', 'help it is broken', { result: true, fallback: false }, 42);
    await flush();
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.state).toBe('help it is broken');
    expect(body.questions.q).toMatchObject({ type: 'noul', instructions: 'Is this urgent?' });
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer test-key');
    expect(info).toHaveBeenCalledWith(
      '[jev-shadow]',
      expect.objectContaining({
        experiment: 'micro-yesno',
        helper: 'askYesNo',
        jev: true,
        jevProbability: 0.9,
        agree: true,
      })
    );
  });

  it('sends a choice for pickOne with every option as criteria', async () => {
    const fetch = jevReply({
      q: { type: 'choice', choice: 'casual', probabilities: { casual: 0.7, technical: 0.3 }, confidence: 0.6 },
    });
    vi.stubGlobal('fetch', fetch);
    shadowPickOne('Tone?', 'lol nice', ['casual', 'technical'], { result: 'technical', fallback: false }, 30);
    await flush();
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(Object.keys(body.questions.q.criteria)).toEqual(['casual', 'technical']);
    expect(info).toHaveBeenCalledWith(
      '[jev-shadow]',
      expect.objectContaining({ helper: 'pickOne', jev: 'casual', jevProbability: 0.7, agree: false })
    );
  });

  it('logs an error instead of throwing when Jev fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 529 }));
    shadowYesNo('q?', 'ctx', { result: false, fallback: true }, 5);
    await flush();
    expect(info).toHaveBeenCalledWith('[jev-shadow]', expect.objectContaining({ error: 'Jev 529' }));
  });

  it('respects the kill switch', async () => {
    const killSwitch = join(dir, 'KILL_SWITCH');
    writeFileSync(killSwitch, 'manual');
    process.env.KILL_SWITCH_PATH = killSwitch;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    shadowYesNo('q?', 'ctx', { result: true, fallback: false }, 5);
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('preflight-batch asks all three questions in one request and scores each', async () => {
    const fetch = jevReply({
      tone: { type: 'choice', choice: 'casual', probabilities: { casual: 0.9 }, confidence: 0.8 },
      format: { type: 'choice', choice: 'list', probabilities: { list: 0.6 }, confidence: 0.4 },
      complexity: { type: 'choice', choice: 'simple', probabilities: { simple: 0.85 }, confidence: 0.7 },
    });
    vi.stubGlobal('fetch', fetch);
    shadowPreflightBatch('what time is it in tokyo right now', {
      tone: { question: 'Tone?', options: ['casual', 'formal'], result: 'casual', fallback: false, ms: 100 },
      format: { question: 'Format?', options: ['chat', 'list'], result: 'chat', fallback: false, ms: 300 },
      complexity: { question: 'Complex?', options: ['simple', 'complex'], result: 'simple', fallback: true, ms: 200 },
    });
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Object.keys(JSON.parse(fetch.mock.calls[0][1].body).questions)).toEqual(['tone', 'format', 'complexity']);
    const rec = info.mock.calls[0][1];
    expect(rec).toMatchObject({
      experiment: 'preflight-batch',
      micro: 'casual/chat/simple',
      jev: 'casual/list/simple',
      microMs: 600,
      microWallMs: 300,
      microFallback: true,
      agree: false,
    });
    expect(rec.parts.tone.agree).toBe(true);
    expect(rec.parts.format).toMatchObject({ micro: 'chat', jev: 'list', agree: false });
    expect(rec.parts.complexity.microFallback).toBe(true);
  });

  it('writes JSONL with every string clipped to 200 chars', async () => {
    const log = join(dir, 'shadow.jsonl');
    process.env.JEV_SHADOW_LOG = log;
    vi.stubGlobal('fetch', jevReply({ q: { type: 'noul', noul: 0.1 } }));
    shadowYesNo('q?', 'x'.repeat(5000), { result: true, fallback: false }, 5);
    for (let i = 0; i < 50 && !existsSync(log); i++) await flush();
    const line = JSON.parse(readFileSync(log, 'utf8').trim());
    expect(line.text.length).toBe(200);
    expect(line).toMatchObject({ experiment: 'micro-yesno', agree: false });
  });
});
