/**
 * Legacy reflections at recall: rows tagged `reflection_v3` skip the read-time in-character
 * filter, older reflection rows still go through it. (The write path that produced the tag,
 * ENABLE_AUTO_REFLECTION, is gone; existing rows stay in the DB.)
 */
import { describe, it, expect } from 'vitest';
import { isStaleNoise } from '../../../src/engine/memory/store.js';

describe('legacy reflections at recall', () => {
  const inCharacter = 'Lap eighteen, comrade. Still counting.';

  it('an old in-character reflection row is still hidden', () => {
    expect(isStaleNoise({ user_id: 'u', tags: '["reflection"]', importance: 3, context: 'reflection', content: inCharacter })).toBe(true);
  });

  it('a reflection_v3 row is not run through the in-character heuristics', () => {
    expect(
      isStaleNoise({ user_id: 'u', tags: '["reflection_v3"]', importance: 3, context: 'reflection', content: inCharacter })
    ).toBe(false);
  });

  it('non-reflection rows are untouched by it', () => {
    expect(isStaleNoise({ user_id: 'u', tags: '[]', importance: 5, context: 'conversation', content: inCharacter })).toBe(false);
  });
});
