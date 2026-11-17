/**
 * While broke, the cooldown used to expire every 5 min and let a paid call probe (and fail).
 * Now expiry asks the free balance endpoint first; only a recovered (or unreadable) balance
 * resumes calls.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { creditMonitor } from '../../src/engine/budget/openrouter-balance.js';

const COOLDOWN_MS = 5 * 60 * 1000;

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe('credit exhaustion recheck', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    creditMonitor.clearExhaustedFlag();
  });

  function exhaustAndExpire(): void {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T12:00:00Z'));
    process.env.CREDIT_ALERTS_DISABLED = 'true';
    creditMonitor.markCreditsExhausted();
    vi.setSystemTime(new Date(Date.now() + COOLDOWN_MS + 1000));
  }

  it('stays exhausted after the cooldown while the balance is still dry', async () => {
    exhaustAndExpire();
    const spy = vi.spyOn(creditMonitor, 'getRemainingBalance').mockResolvedValue(-0.2);
    expect(creditMonitor.areCreditsExhausted()).toBe(true);
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(creditMonitor.areCreditsExhausted()).toBe(true);
  });

  it('resumes once the balance has recovered', async () => {
    exhaustAndExpire();
    vi.spyOn(creditMonitor, 'getRemainingBalance').mockResolvedValue(14.8);
    expect(creditMonitor.areCreditsExhausted()).toBe(true);
    await settle();
    expect(creditMonitor.areCreditsExhausted()).toBe(false);
  });

  it('resumes when the balance cannot be read (old behavior)', async () => {
    exhaustAndExpire();
    vi.spyOn(creditMonitor, 'getRemainingBalance').mockResolvedValue(null);
    creditMonitor.areCreditsExhausted();
    await settle();
    expect(creditMonitor.areCreditsExhausted()).toBe(false);
  });

  it('ignores a stale dry result after a top-up cleared the flag mid-read', async () => {
    exhaustAndExpire();
    let release: (v: number) => void = () => {};
    vi.spyOn(creditMonitor, 'getRemainingBalance').mockImplementation(
      () => new Promise<number>((r) => (release = r))
    );
    creditMonitor.areCreditsExhausted();
    creditMonitor.clearExhaustedFlag();
    release(-0.2);
    await settle();
    expect(creditMonitor.areCreditsExhausted()).toBe(false);
  });

  it('only runs one recheck at a time', async () => {
    exhaustAndExpire();
    let release: (v: number) => void = () => {};
    const spy = vi
      .spyOn(creditMonitor, 'getRemainingBalance')
      .mockImplementation(() => new Promise<number>((r) => (release = r)));
    creditMonitor.areCreditsExhausted();
    creditMonitor.areCreditsExhausted();
    creditMonitor.areCreditsExhausted();
    expect(spy).toHaveBeenCalledTimes(1);
    release(-0.2);
    await settle();
  });
});
