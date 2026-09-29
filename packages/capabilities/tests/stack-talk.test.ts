import { describe, it, expect, afterEach } from 'vitest';
import {
  buildFtsQuery,
  packMemories,
  packBudget,
  contextWindowFor,
  formatMemoryLine,
  DEFAULT_MODEL,
  DEFAULT_DEEP_MODEL,
  type MemoryRow,
} from '../src/services/stack-talk/stack-talk.js';

const row = (id: number, content: string, user = 'u1'): MemoryRow => ({
  id,
  user_id: user,
  guild_id: null,
  content,
  timestamp: '2026-07-12T10:00:00Z',
  importance: 5,
});

describe('buildFtsQuery', () => {
  it('ORs distinct quoted keywords and drops stopwords/short words', () => {
    expect(buildFtsQuery('What does Artie know about the Subway Builder bridges?')).toBe(
      '"subway" OR "builder" OR "bridges"'
    );
  });

  it('returns null when nothing is searchable', () => {
    expect(buildFtsQuery('who is it?')).toBeNull();
  });

  it('neutralises FTS syntax characters', () => {
    const q = buildFtsQuery('tunnels AND "bridges" NEAR(x)')!;
    expect(q).toContain('"tunnels"');
    expect(q).not.toMatch(/NEAR\(/);
  });
});

describe('packMemories', () => {
  it('puts keyword matches first, dedupes, and stops at the budget', () => {
    const matched = [row(2, 'bridges on terrain'), row(1, 'tunnel talk')];
    const background = [row(1, 'tunnel talk'), row(3, 'x'.repeat(400)), row(4, 'short')];
    const budget =
      [matched[0], matched[1]].reduce((t, m) => t + Math.ceil(formatMemoryLine(m).length / 4) + 1, 0) + 5;
    const pack = packMemories(matched, background, budget);
    expect(pack.lines[0]).toContain('#2');
    expect(pack.lines[1]).toContain('#1');
    expect(pack.lines.filter((l) => l.includes('#1 '))).toHaveLength(1);
    expect(pack.lines.some((l) => l.includes('#3'))).toBe(false); // too big for what's left
    expect(pack.matchedIncluded).toBe(2);
    expect(pack.tokens).toBeLessThanOrEqual(budget);
  });

  it('skips blocked users and empty memories', () => {
    const pack = packMemories([], [row(5, '   '), row(6, 'kept')], 10_000);
    expect(pack.lines).toHaveLength(1);
    expect(pack.lines[0]).toContain('#6');
  });
});

describe('budgets', () => {
  afterEach(() => {
    delete process.env.STACK_TALK_MAX_PACK_TOKENS;
    delete process.env.STACK_TALK_CONTEXT_TOKENS;
  });

  it('sizes the pack to ~80% of the model window', () => {
    expect(contextWindowFor(DEFAULT_MODEL)).toBe(262_144);
    const kimi = packBudget(DEFAULT_MODEL, 'q', 2000);
    expect(kimi).toBeGreaterThan(200_000);
    expect(kimi).toBeLessThan(262_144 * 0.8);
    expect(packBudget(DEFAULT_DEEP_MODEL, 'q', 2000)).toBe(900_000); // capped by the default ceiling
  });

  it('treats unknown models conservatively and honours overrides', () => {
    expect(contextWindowFor('someone/new-model')).toBe(131_072);
    process.env.STACK_TALK_MAX_PACK_TOKENS = '50000';
    expect(packBudget(DEFAULT_DEEP_MODEL, 'q', 2000)).toBe(50_000);
  });
});
