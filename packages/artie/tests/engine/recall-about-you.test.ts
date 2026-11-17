/**
 * Artie 2026-11-17: "memory is lossy". The asker's own personal facts (scope "me", importance
 * >= 6) always ride along, so keyword ranking can't drop "I'm vegetarian" from a question about
 * dinner. Picked before ranking, sized inside the budget.
 */
import { describe, it, expect } from 'vitest';
import { aboutYou, withAboutYou } from '../../src/engine/memory/recall.js';

const ranked = {
  content: 'This reminds me of: the dinner thread.',
  confidence: 0.5,
  memoryCount: 1,
  categories: ['semantic_only'],
  memoryIds: ['tfidf_0'],
};

const own = [
  { content: 'is vegetarian', importance: 8, date: '2026-11-01' },
  { content: 'likes trains', importance: 5, date: '2026-11-10' },
  { content: 'lives in Queens', importance: 6, date: '2026-11-12' },
  { content: 'name is Sam', importance: 9, date: '2026-10-01' },
];

describe('aboutYou', () => {
  it('picks importance >= 6, most important first', () => {
    const a = aboutYou(own, 1000);
    expect(a.line).toBe("About the person you're talking to: name is Sam; is vegetarian; lives in Queens.");
    expect(a.picked).toEqual(['name is Sam', 'is vegetarian', 'lives in Queens']);
  });

  it('never exceeds its character cap, dropping whole facts', () => {
    const a = aboutYou(own, 70);
    expect(a.line.length).toBeLessThanOrEqual(70);
    expect(a.picked).toEqual(['name is Sam', 'is vegetarian']);
    expect(aboutYou(own, 10).line).toBe('');
  });
});

describe('withAboutYou', () => {
  it('prepends the line to ranked recall', () => {
    const out = withAboutYou(ranked, aboutYou(own, 1000));
    expect(out.content.startsWith("About the person you're talking to:")).toBe(true);
    expect(out.content).toContain('the dinner thread');
    expect(out.memoryCount).toBe(4);
  });

  it('fills an otherwise empty recall', () => {
    const out = withAboutYou(
      { content: '', confidence: 0, memoryCount: 0, categories: ['no_matches'], memoryIds: [] },
      aboutYou(own, 1000)
    );
    expect(out.memoryCount).toBe(3);
    expect(out.categories).toEqual(['about_you']);
  });

  it('is a no-op with nothing personal', () => {
    expect(withAboutYou(ranked, aboutYou([own[1]], 1000))).toBe(ranked);
  });
});
