import { describe, it, expect, afterEach } from 'vitest';
import { UsageTracker } from '../src/services/monitoring/usage-tracker.js';

const OPUS = 'anthropic/claude-opus-4.8'; // $5 / $25 per M

describe('UsageTracker.calculateCost with prompt caching', () => {
  const saved = process.env.PROMPT_CACHE_TTL;
  afterEach(() => {
    if (saved === undefined) delete process.env.PROMPT_CACHE_TTL;
    else process.env.PROMPT_CACHE_TTL = saved;
  });

  it('bills uncached input at list price', () => {
    expect(UsageTracker.calculateCost(OPUS, { prompt_tokens: 10_000, completion_tokens: 0, total_tokens: 10_000 })).toBeCloseTo(0.05, 6);
  });

  it('bills cache reads at 0.1x', () => {
    const cost = UsageTracker.calculateCost(OPUS, {
      prompt_tokens: 10_000,
      completion_tokens: 0,
      total_tokens: 10_000,
      cached_tokens: 8_000,
    });
    expect(cost).toBeCloseTo(0.01 + 0.004, 6); // 2k full + 8k at 0.1x
  });

  it('bills cache writes at 2x on the default 1h TTL', () => {
    const cost = UsageTracker.calculateCost(OPUS, {
      prompt_tokens: 10_000,
      completion_tokens: 0,
      total_tokens: 10_000,
      cache_write_tokens: 8_000,
    });
    expect(cost).toBeCloseTo(0.01 + 0.08, 6); // 2k full + 8k at 2x
  });

  it('bills cache writes at 1.25x on the 5m TTL', () => {
    process.env.PROMPT_CACHE_TTL = '5m';
    const cost = UsageTracker.calculateCost(OPUS, {
      prompt_tokens: 10_000,
      completion_tokens: 0,
      total_tokens: 10_000,
      cache_write_tokens: 8_000,
    });
    expect(cost).toBeCloseTo(0.01 + 0.05, 6);
  });

  it('never counts a token as both read and written', () => {
    const cost = UsageTracker.calculateCost(OPUS, {
      prompt_tokens: 10_000,
      completion_tokens: 0,
      total_tokens: 10_000,
      cached_tokens: 10_000,
      cache_write_tokens: 5_000,
    });
    expect(cost).toBeCloseTo(0.005, 6);
  });
});
