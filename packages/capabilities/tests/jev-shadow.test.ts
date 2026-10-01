import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const assertGenerationAllowed = vi.fn();
const info = vi.fn();
vi.mock('@coachartie/shared', () => ({
  assertGenerationAllowed: (...args: unknown[]) => assertGenerationAllowed(...args),
  logger: { info: (...args: unknown[]) => info(...args), debug: vi.fn() },
}));

const { shadowYesNo, shadowPickOne, jevShadowEnabled } = await import(
  '../src/services/llm/jev-shadow.js'
);

const flush = () => new Promise((r) => setTimeout(r, 0));
const jevReply = (answer: object) =>
  vi.fn().mockResolvedValue({ ok: true, json: async () => ({ answers: { q: answer } }) });

describe('jev shadow mode', () => {
  beforeEach(() => {
    process.env.JEV_API_KEY = 'test-key';
    delete process.env.JEV_SHADOW;
    assertGenerationAllowed.mockReset();
    info.mockReset();
  });
  afterEach(() => {
    delete process.env.JEV_API_KEY;
    vi.unstubAllGlobals();
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
    const fetch = jevReply({ type: 'noul', noul: 0.9 });
    vi.stubGlobal('fetch', fetch);
    shadowYesNo('Is this urgent?', 'help it is broken', { result: true, fallback: false }, 42);
    await flush();
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.state).toBe('help it is broken');
    expect(body.questions.q).toMatchObject({ type: 'noul', instructions: 'Is this urgent?' });
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer test-key');
    expect(info).toHaveBeenCalledWith(
      '[jev-shadow]',
      expect.objectContaining({ helper: 'askYesNo', jev: true, jevProbability: 0.9, agree: true })
    );
  });

  it('sends a choice for pickOne with every option as criteria', async () => {
    const fetch = jevReply({
      type: 'choice',
      choice: 'casual',
      probabilities: { casual: 0.7, technical: 0.3 },
      confidence: 0.6,
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
    await flush();
    expect(info).toHaveBeenCalledWith('[jev-shadow]', expect.objectContaining({ error: 'Jev 529' }));
  });

  it('respects the kill switch', async () => {
    assertGenerationAllowed.mockImplementation(() => {
      throw new Error('muted');
    });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    shadowYesNo('q?', 'ctx', { result: true, fallback: false }, 5);
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });
});
