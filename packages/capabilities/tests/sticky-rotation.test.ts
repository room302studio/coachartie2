import { describe, it, expect } from 'vitest';
import { stickyRotationIndex } from '../src/services/llm/openrouter.js';

describe('stickyRotationIndex', () => {
  it('maps a conversation to the same model every time', () => {
    const first = stickyRotationIndex('channel:123', 2);
    for (let i = 0; i < 20; i++) expect(stickyRotationIndex('channel:123', 2)).toBe(first);
  });

  it('stays in range and spreads conversations across the rotation', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++) {
      const idx = stickyRotationIndex(`channel:${i}`, 3);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(3);
      seen.add(idx);
    }
    expect(seen.size).toBe(3);
  });

  it('handles an empty rotation', () => {
    expect(stickyRotationIndex('x', 0)).toBe(0);
  });
});
