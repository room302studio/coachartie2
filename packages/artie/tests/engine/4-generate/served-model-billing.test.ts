import { describe, it, expect } from 'vitest';
import { servedModelName, billedCost } from '../../../src/engine/4-generate/openrouter.js';
import { supportsPromptCaching } from '../../../src/engine/3-context/prompt-cache.js';

const usage = { prompt_tokens: 10_000, completion_tokens: 1_000, total_tokens: 11_000 };

describe('billing follows what OpenRouter served', () => {
  it('bills the served model, not the alias that was asked for', () => {
    expect(servedModelName('anthropic/claude-haiku-5.5', '~anthropic/claude-haiku-latest')).toBe('anthropic/claude-haiku-5.5');
    expect(servedModelName(undefined, 'anthropic/claude-sonnet-5')).toBe('anthropic/claude-sonnet-5');
  });

  it("prefers OpenRouter's reported cost, falls back to the price table", () => {
    expect(billedCost(0.0021, 'anything', usage)).toBe(0.0021);
    expect(billedCost(Number.NaN, 'anthropic/claude-haiku-5.5', usage)).toBeCloseTo(0.0015, 6);
  });

  it('treats ~anthropic aliases as Anthropic for prompt caching', () => {
    expect(supportsPromptCaching('~anthropic/claude-haiku-latest')).toBe(true);
    expect(supportsPromptCaching('~openai/gpt-luna-latest')).toBe(false);
  });
});
