/**
 * Security audit 2026-10-26 (sec-abuse.md Critical #3): image_gen spend used to be invisible
 * to the daily budget ledger (never written to model_usage_stats, so daily-cap.ts's
 * getTodaySpendUsd never saw it) and had no per-user limit. Three independent fixes:
 *   1. brownout `critical` refuses non-owners
 *   2. a per-user-per-day cap (ARTIE_IMAGE_GEN_PER_USER_DAY, owner exempt)
 *   3. every call is recorded into model_usage_stats (step_type 'image_gen')
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OWNER_USER_ID } from '../../../src/shared/config/owner.js';

vi.mock('../../../src/engine/budget/brownout.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/engine/budget/brownout.js')>();
  return { ...actual, getBrownoutMode: vi.fn() };
});

const { imageGenCapability } = await import('../../../src/engine/capabilities/media/image-gen.js');
const { getBrownoutMode } = await import('../../../src/engine/budget/brownout.js');
const { getUserActionCountToday } = await import('../../../src/engine/budget/daily-cap.js');

function mockFetchOk() {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: 'a picture', images: [{ image_url: { url: 'data:image/png;base64,AAAA' } } ] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.02 },
    }),
  })) as unknown as typeof fetch;
}

describe('image_gen brownout + owner exemption', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    global.fetch = mockFetchOk();
    (getBrownoutMode as ReturnType<typeof vi.fn>).mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.OPENROUTER_API_KEY = originalKey;
  });

  it('refuses a non-owner under brownout critical, with no fetch call', async () => {
    (getBrownoutMode as ReturnType<typeof vi.fn>).mockResolvedValue({ mode: 'critical', runwayHours: 1 });

    const result = await imageGenCapability.handler(
      { action: 'generate', prompt: 'a cat', userId: 'some-random-user' },
      undefined,
      { userId: 'some-random-user' }
    );

    expect(result).toMatch(/lean|paused/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('lets the owner generate even under brownout critical', async () => {
    (getBrownoutMode as ReturnType<typeof vi.fn>).mockResolvedValue({ mode: 'critical', runwayHours: 1 });

    const result = await imageGenCapability.handler(
      { action: 'generate', prompt: 'a cat', userId: OWNER_USER_ID },
      undefined,
      { userId: OWNER_USER_ID }
    );

    expect(result).not.toMatch(/lean|paused/i);
    expect(global.fetch).toHaveBeenCalled();
  });

  it('proceeds normally when brownout is normal', async () => {
    (getBrownoutMode as ReturnType<typeof vi.fn>).mockResolvedValue({ mode: 'normal', runwayHours: 999 });

    const result = await imageGenCapability.handler(
      { action: 'generate', prompt: 'a dog', userId: `non-critical-user-${Date.now()}` },
      undefined,
      { userId: 'non-critical-user' }
    );

    expect(global.fetch).toHaveBeenCalled();
    expect(result).toContain('Image Generated');
  });
});

describe('image_gen per-user daily cap', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalCap = process.env.ARTIE_IMAGE_GEN_PER_USER_DAY;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    process.env.ARTIE_IMAGE_GEN_PER_USER_DAY = '2';
    global.fetch = mockFetchOk();
    (getBrownoutMode as ReturnType<typeof vi.fn>).mockResolvedValue({ mode: 'normal', runwayHours: 999 });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.OPENROUTER_API_KEY = originalKey;
    process.env.ARTIE_IMAGE_GEN_PER_USER_DAY = originalCap;
  });

  it('refuses once a non-owner is already at the cap for today', async () => {
    const userId = `cap-test-user-${Date.now()}`;
    // Seed today's usage at the cap via the real ledger write path (calling the handler
    // twice IS the seed — the cap counts rows the handler itself just wrote).
    await imageGenCapability.handler({ action: 'generate', prompt: 'one', userId }, undefined, { userId });
    await imageGenCapability.handler({ action: 'generate', prompt: 'two', userId }, undefined, { userId });
    expect(getUserActionCountToday(userId, 'image_gen')).toBeGreaterThanOrEqual(2);

    const fetchCallsBefore = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    const third = await imageGenCapability.handler(
      { action: 'generate', prompt: 'three', userId },
      undefined,
      { userId }
    );

    expect(third).toMatch(/limit/i);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(fetchCallsBefore);
  });

  it('the owner is exempt from the per-user cap', async () => {
    await imageGenCapability.handler({ action: 'generate', prompt: 'owner 1', userId: OWNER_USER_ID }, undefined, { userId: OWNER_USER_ID });
    await imageGenCapability.handler({ action: 'generate', prompt: 'owner 2', userId: OWNER_USER_ID }, undefined, { userId: OWNER_USER_ID });
    await imageGenCapability.handler({ action: 'generate', prompt: 'owner 3', userId: OWNER_USER_ID }, undefined, { userId: OWNER_USER_ID });
    const result = await imageGenCapability.handler(
      { action: 'generate', prompt: 'owner fourth', userId: OWNER_USER_ID },
      undefined,
      { userId: OWNER_USER_ID }
    );
    expect(result).not.toMatch(/limit/i);
  });
});
