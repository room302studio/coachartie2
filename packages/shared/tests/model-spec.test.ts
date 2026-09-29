import { describe, it, expect } from 'vitest';
import { resolveModelSpec, isAutoRouted } from '../src/utils/model-spec.js';

describe('resolveModelSpec', () => {
  it('passes concrete model ids through untouched', () => {
    expect(resolveModelSpec('anthropic/claude-opus-5.5')).toEqual({ model: 'anthropic/claude-opus-5.5' });
    expect(resolveModelSpec('google/gemini-2.5-flash')).toEqual({ model: 'google/gemini-2.5-flash' });
  });

  it('turns auto:<tier> into openrouter/auto + the auto-router plugin', () => {
    expect(resolveModelSpec('auto:high')).toEqual({
      model: 'openrouter/auto',
      plugins: [{ id: 'auto-router', cost_tier: 'high' }],
    });
  });

  it('adds an allowed-models floor', () => {
    expect(resolveModelSpec('auto:medium:anthropic/*')).toEqual({
      model: 'openrouter/auto',
      plugins: [{ id: 'auto-router', cost_tier: 'medium', allowed_models: ['anthropic/*'] }],
    });
    expect(resolveModelSpec('auto:low:anthropic/*, google/*').plugins).toEqual([
      { id: 'auto-router', cost_tier: 'low', allowed_models: ['anthropic/*', 'google/*'] },
    ]);
  });

  it('defaults bare or unknown tiers to low', () => {
    expect(resolveModelSpec('auto').plugins).toEqual([{ id: 'auto-router', cost_tier: 'low' }]);
    expect(resolveModelSpec('auto:ultra').plugins).toEqual([{ id: 'auto-router', cost_tier: 'low' }]);
  });

  it('knows when billing must use the served model', () => {
    expect(isAutoRouted('openrouter/auto')).toBe(true);
    expect(isAutoRouted('anthropic/claude-opus-5.5')).toBe(false);
  });
});
