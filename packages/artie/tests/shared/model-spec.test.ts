import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveModelSpec,
  isAutoRouted,
  autoReasoningFor,
  openRouterUser,
  DEFAULT_AUTO_EXCLUDED_MODELS,
  NO_TRAINING_PROVIDER,
} from '../../src/shared/model-spec.js';

const EXCLUDED = { excluded_models: DEFAULT_AUTO_EXCLUDED_MODELS };

describe('resolveModelSpec', () => {
  let savedExcluded: string | undefined;
  beforeEach(() => {
    savedExcluded = process.env.AUTO_ROUTER_EXCLUDED_MODELS;
    delete process.env.AUTO_ROUTER_EXCLUDED_MODELS;
  });
  afterEach(() => {
    if (savedExcluded === undefined) {
      delete process.env.AUTO_ROUTER_EXCLUDED_MODELS;
    } else {
      process.env.AUTO_ROUTER_EXCLUDED_MODELS = savedExcluded;
    }
  });

  it('passes concrete model ids through untouched', () => {
    expect(resolveModelSpec('anthropic/claude-opus-5.5')).toEqual({ model: 'anthropic/claude-opus-5.5' });
    expect(resolveModelSpec('google/gemini-2.5-flash')).toEqual({ model: 'google/gemini-2.5-flash' });
  });

  it('turns auto:<tier> into openrouter/auto + the auto-router plugin', () => {
    expect(resolveModelSpec('auto:high')).toEqual({
      model: 'openrouter/auto',
      plugins: [{ id: 'auto-router', cost_tier: 'high', ...EXCLUDED }],
    });
  });

  it('adds an allowed-models floor', () => {
    expect(resolveModelSpec('auto:medium:anthropic/*')).toEqual({
      model: 'openrouter/auto',
      plugins: [{ id: 'auto-router', cost_tier: 'medium', allowed_models: ['anthropic/*'], ...EXCLUDED }],
    });
    expect(resolveModelSpec('auto:low:anthropic/*, google/*').plugins).toEqual([
      { id: 'auto-router', cost_tier: 'low', allowed_models: ['anthropic/*', 'google/*'], ...EXCLUDED },
    ]);
  });

  it('defaults bare or unknown tiers to low', () => {
    expect(resolveModelSpec('auto').plugins).toEqual([{ id: 'auto-router', cost_tier: 'low', ...EXCLUDED }]);
    expect(resolveModelSpec('auto:ultra').plugins).toEqual([{ id: 'auto-router', cost_tier: 'low', ...EXCLUDED }]);
  });

  it('sends xhigh/max as high, the router only knows low | medium | high', () => {
    expect(resolveModelSpec('auto:max').plugins).toEqual([{ id: 'auto-router', cost_tier: 'high', ...EXCLUDED }]);
    expect(resolveModelSpec('auto:xhigh').plugins).toEqual([{ id: 'auto-router', cost_tier: 'high', ...EXCLUDED }]);
  });

  it('excludes muse-spark by default', () => {
    expect(DEFAULT_AUTO_EXCLUDED_MODELS).toContain('meta/muse-spark*');
  });

  it('lets AUTO_ROUTER_EXCLUDED_MODELS replace the exclusions, or clear them', () => {
    process.env.AUTO_ROUTER_EXCLUDED_MODELS = 'meta/*, deepseek/deepseek-v4-flash*';
    expect(resolveModelSpec('auto:low').plugins).toEqual([
      { id: 'auto-router', cost_tier: 'low', excluded_models: ['meta/*', 'deepseek/deepseek-v4-flash*'] },
    ]);
    process.env.AUTO_ROUTER_EXCLUDED_MODELS = '';
    expect(resolveModelSpec('auto:low').plugins).toEqual([{ id: 'auto-router', cost_tier: 'low' }]);
  });

  it('knows when billing must use the served model', () => {
    expect(isAutoRouted('openrouter/auto')).toBe(true);
    expect(isAutoRouted('anthropic/claude-opus-5.5')).toBe(false);
  });
});

describe('autoReasoningFor', () => {
  it('turns reasoning off for low/medium auto tiers, keeps it for high+', () => {
    expect(autoReasoningFor(resolveModelSpec('auto:low').plugins)).toEqual({ effort: 'none' });
    expect(autoReasoningFor(resolveModelSpec('auto:medium:anthropic/*').plugins)).toEqual({ effort: 'none' });
    expect(autoReasoningFor(resolveModelSpec('auto:high').plugins)).toBeUndefined();
    expect(autoReasoningFor(resolveModelSpec('auto:max').plugins)).toBeUndefined();
    expect(autoReasoningFor(undefined)).toEqual({ effort: 'none' }); // no plugins = auto default (low)
  });
});

describe('NO_TRAINING_PROVIDER', () => {
  it('denies providers that train on prompts (Discord Developer Policy)', () => {
    expect(NO_TRAINING_PROVIDER).toEqual({ data_collection: 'deny' });
  });
});

describe('openRouterUser', () => {
  it('is keyed: not a plain sha256 of the id that anyone could recompute', async () => {
    const { createHash } = await import('node:crypto');
    const plain = createHash('sha256').update('coachartie:272782606347796481').digest('hex').slice(0, 24);
    const plainBare = createHash('sha256').update('272782606347796481').digest('hex').slice(0, 24);
    const ours = openRouterUser('272782606347796481');
    expect(ours).not.toBe('ca_' + plain);
    expect(ours).not.toBe('ca_' + plainBare);
  });

  it('is a stable pseudonym, never the raw id', () => {
    const a = openRouterUser('272782606347796481');
    expect(a).toMatch(/^ca_[0-9a-f]{24}$/);
    expect(a).toBe(openRouterUser('272782606347796481'));
    expect(a).not.toContain('272782606347796481');
    expect(openRouterUser('965504274970853377')).not.toBe(a);
  });

  it('keeps its key in a private file next to the DB, stable across reloads, replacing empty leftovers', async () => {
    const { mkdtempSync, statSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { vi } = await import('vitest');
    const dir = mkdtempSync(join(tmpdir(), 'or-salt-'));
    const savedDb = process.env.DATABASE_PATH;
    const savedSalt = process.env.OPENROUTER_USER_SALT;
    delete process.env.OPENROUTER_USER_SALT;
    process.env.DATABASE_PATH = join(dir, 'test.db');
    const saltFile = join(dir, '.openrouter-user-salt');
    try {
      // An empty leftover (crash mid-write) must be replaced, not trusted.
      writeFileSync(saltFile, '');
      vi.resetModules();
      const first = await import('../../src/shared/model-spec.js');
      const a = first.openRouterUser('272782606347796481');
      expect(readFileSync(saltFile, 'utf8').trim().length).toBe(64);
      expect(statSync(saltFile).mode & 0o777).toBe(0o600);
      vi.resetModules();
      const second = await import('../../src/shared/model-spec.js');
      expect(second.openRouterUser('272782606347796481')).toBe(a);
    } finally {
      if (savedDb === undefined) {
        delete process.env.DATABASE_PATH;
      } else {
        process.env.DATABASE_PATH = savedDb;
      }
      if (savedSalt !== undefined) {
        process.env.OPENROUTER_USER_SALT = savedSalt;
      }
      rmSync(dir, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it('sends nothing when there is no user', () => {
    expect(openRouterUser(undefined)).toBeUndefined();
    expect(openRouterUser('')).toBeUndefined();
    expect(openRouterUser(null)).toBeUndefined();
  });
});
