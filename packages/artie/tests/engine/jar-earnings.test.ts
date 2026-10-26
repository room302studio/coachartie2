import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isJarEarningsConfigured,
  sumCompletedCheckoutSessionsCents,
  getJarTippedUsd,
  resetJarEarningsCacheForTests,
} from '../../src/engine/budget/jar-earnings.js';

const READ_KEY = 'rk_test_123';
const LINK_ID = 'plink_test_abc';

function setEnv(): void {
  process.env.STRIPE_JAR_READ_KEY = READ_KEY;
  process.env.ARTIE_TIP_JAR_PAYMENT_LINK_ID = LINK_ID;
}

function clearEnv(): void {
  delete process.env.STRIPE_JAR_READ_KEY;
  delete process.env.ARTIE_TIP_JAR_PAYMENT_LINK_ID;
}

describe('isJarEarningsConfigured', () => {
  afterEach(clearEnv);

  it('false with nothing set', () => {
    clearEnv();
    expect(isJarEarningsConfigured()).toBe(false);
  });

  it('false with only the key set', () => {
    process.env.STRIPE_JAR_READ_KEY = READ_KEY;
    expect(isJarEarningsConfigured()).toBe(false);
  });

  it('false when the key has the wrong prefix', () => {
    process.env.STRIPE_JAR_READ_KEY = 'sk_live_whoops';
    process.env.ARTIE_TIP_JAR_PAYMENT_LINK_ID = LINK_ID;
    expect(isJarEarningsConfigured()).toBe(false);
  });

  it('true with both set and well-formed', () => {
    setEnv();
    expect(isJarEarningsConfigured()).toBe(true);
  });
});

describe('sumCompletedCheckoutSessionsCents — pagination', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sums amount_total across two pages', async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: any) => {
      calls.push(String(url));
      if (!String(url).includes('starting_after')) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: 'cs_1', amount_total: 500 },
              { id: 'cs_2', amount_total: 300 },
            ],
            has_more: true,
          }),
        } as any;
      }
      return {
        ok: true,
        json: async () => ({
          data: [{ id: 'cs_3', amount_total: 200 }],
          has_more: false,
        }),
      } as any;
    }) as unknown as typeof fetch;

    const total = await sumCompletedCheckoutSessionsCents(LINK_ID, 1700000000, READ_KEY);
    expect(total).toBe(1000);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('starting_after=cs_2');
    expect(calls[0]).toContain(`payment_link=${LINK_ID}`);
    expect(calls[0]).toContain('status=complete');
  });

  it('treats a missing amount_total as 0', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'cs_1', amount_total: null }], has_more: false }),
    })) as unknown as typeof fetch;

    expect(await sumCompletedCheckoutSessionsCents(LINK_ID, 0, READ_KEY)).toBe(0);
  });

  it('throws on a non-ok response (caller is responsible for fail-soft)', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'bad key' } }),
    })) as unknown as typeof fetch;

    await expect(sumCompletedCheckoutSessionsCents(LINK_ID, 0, READ_KEY)).rejects.toThrow();
  });
});

describe('getJarTippedUsd — cache, fail-soft, month boundary', () => {
  beforeEach(() => {
    resetJarEarningsCacheForTests();
    setEnv();
  });
  afterEach(() => {
    clearEnv();
    resetJarEarningsCacheForTests();
    vi.restoreAllMocks();
  });

  it('null when not configured, regardless of any cached value', async () => {
    clearEnv();
    expect(await getJarTippedUsd()).toBeNull();
  });

  it('fetches once, caches, and uses the ET calendar month start as created[gte]', async () => {
    let capturedUrl = '';
    global.fetch = vi.fn(async (url: any) => {
      capturedUrl = String(url);
      return { ok: true, json: async () => ({ data: [{ id: 'cs_1', amount_total: 1234 }], has_more: false }) } as any;
    }) as unknown as typeof fetch;

    // 2026-11-01T02:00Z is Oct 31 ET (DST ends later that day) — Oct 1 ET month start.
    const now = new Date('2026-11-01T02:00:00Z').getTime();
    const usd = await getJarTippedUsd(now);
    expect(usd).toBe(12.34);
    expect((global.fetch as any).mock.calls.length).toBe(1);

    // Oct 1 2026 00:00 ET == 2026-10-01T04:00:00Z == unix seconds 1759291200
    const expectedGte = Math.floor(new Date('2026-10-01T04:00:00.000Z').getTime() / 1000);
    expect(capturedUrl).toContain(`created%5Bgte%5D=${expectedGte}`);
  });

  it('serves the cache on a second call within 15 minutes — no second fetch', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'cs_1', amount_total: 100 }], has_more: false }),
    })) as unknown as typeof fetch;

    const now = Date.now();
    await getJarTippedUsd(now);
    await getJarTippedUsd(now + 60_000);
    expect((global.fetch as any).mock.calls.length).toBe(1);
  });

  it('refreshes again once the ET calendar month rolls over, even within 15 minutes', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'cs_1', amount_total: 100 }], has_more: false }),
    })) as unknown as typeof fetch;

    // ET midnight Nov 1 is 04:00Z (DST doesn't end until 06:00Z that day) — these two
    // instants are 10 minutes apart in UTC (well under the 15-min cache window) but land on
    // opposite sides of that ET midnight, i.e. different ET calendar months.
    const lastOctoberMinute = new Date('2026-11-01T03:55:00Z').getTime(); // Oct 31 23:55 ET
    const firstNovemberMinutes = new Date('2026-11-01T04:05:00Z').getTime(); // Nov 1 00:05 ET
    await getJarTippedUsd(lastOctoberMinute);
    expect((global.fetch as any).mock.calls.length).toBe(1);

    await getJarTippedUsd(firstNovemberMinutes);
    expect((global.fetch as any).mock.calls.length).toBe(2);
  });

  it('fails soft: keeps the last known value and does not throw when the refresh errors', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'cs_1', amount_total: 500 }], has_more: false }),
    })) as unknown as typeof fetch;

    const t0 = Date.now();
    expect(await getJarTippedUsd(t0)).toBe(5.0);

    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    // Force staleness (past the 15-min window) so the next call actually attempts a refresh.
    const later = t0 + 16 * 60_000;
    await expect(getJarTippedUsd(later)).resolves.toBe(5.0);
  });
});
