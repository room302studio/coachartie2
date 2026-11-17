/**
 * Artie 2026-11-17: "memory is lossy". The asker's own important facts (importance >= 7) always
 * ride along, so keyword ranking can't drop "I'm vegetarian" from a question about dinner.
 */
import { describe, it, expect } from 'vitest';
import { withAboutYou } from '../../src/engine/memory/recall.js';

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

describe('withAboutYou', () => {
  it('prepends the asker\'s important facts, most important first, skipping low ones', () => {
    const out = withAboutYou(ranked, own);
    expect(out.content.startsWith(
      "About the person you're talking to: name is Sam; is vegetarian; lives in Queens."
    )).toBe(true);
    expect(out.content).not.toContain('likes trains');
    expect(out.content).toContain('the dinner thread');
    expect(out.memoryCount).toBe(4);
  });

  it('does not repeat a fact the ranked layers already picked', () => {
    const out = withAboutYou({ ...ranked, content: 'This reminds me of: is vegetarian.' }, own);
    expect(out.content.match(/is vegetarian/g)).toHaveLength(1);
  });

  it('fills an otherwise empty recall', () => {
    const out = withAboutYou(
      { content: '', confidence: 0, memoryCount: 0, categories: ['no_matches'], memoryIds: [] },
      own
    );
    expect(out.memoryCount).toBe(3);
    expect(out.categories).toEqual(['about_you']);
  });

  it('is a no-op with nothing important', () => {
    expect(withAboutYou(ranked, [own[1]])).toBe(ranked);
  });
});
