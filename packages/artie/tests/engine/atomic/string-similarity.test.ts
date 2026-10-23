import { describe, it, expect } from 'vitest';

/**
 * ATOMIC UNIT: String Similarity Calculation
 * Tests the core algorithm for fuzzy action matching
 */

function calculateSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  // Check for substring matches
  if (a.includes(b) || b.includes(a)) return 0.8;

  // Check for common substrings
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();

  if (aLower.includes(bLower) || bLower.includes(aLower)) return 0.7;

  // Check for similar starting characters
  let matchingChars = 0;
  const minLength = Math.min(a.length, b.length);

  for (let i = 0; i < minLength; i++) {
    if (aLower[i] === bLower[i]) {
      matchingChars++;
    } else {
      break;
    }
  }

  return matchingChars / Math.max(a.length, b.length);
}

describe('String Similarity (Atomic Unit)', () => {
  it('should return 1.0 for identical strings', () => {
    expect(calculateSimilarity('write', 'write')).toBe(1.0);
  });

  it('should return 0.0 for empty strings', () => {
    expect(calculateSimilarity('', 'write')).toBe(0.0);
    expect(calculateSimilarity('write', '')).toBe(0.0);
  });

  it('should return 0.8 for substring matches', () => {
    expect(calculateSimilarity('write', 'write_file')).toBe(0.8);
    expect(calculateSimilarity('write_file', 'write')).toBe(0.8);
  });

  it('should return 0.7 for case-insensitive substring matches', () => {
    expect(calculateSimilarity('Write', 'write_file')).toBe(0.7);
    expect(calculateSimilarity('WRITE', 'write_file')).toBe(0.7);
  });

  it('should calculate prefix similarity correctly', () => {
    // 'wri' and 'wr' are substrings of 'write', so they return 0.8
    expect(calculateSimilarity('wri', 'write')).toBe(0.8);
    expect(calculateSimilarity('wr', 'write')).toBe(0.8);
    // For true prefix-only matches (no substring), use strings that don't match
    expect(calculateSimilarity('wxy', 'write')).toBe(0.2); // 1/5 - only 'w' matches
  });

  it('should handle completely different strings', () => {
    expect(calculateSimilarity('read', 'write')).toBe(0.0);
    expect(calculateSimilarity('xyz', 'abc')).toBe(0.0);
  });
});

export { calculateSimilarity };
