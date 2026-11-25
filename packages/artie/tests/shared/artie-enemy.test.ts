import { describe, it, expect } from 'vitest';
import { hasArtieEnemyRole, isArtieEnemyRole } from '../../src/shared/artie-enemy.js';

// 2026-11-24: the role was handed out but never read back, so enemies still got replies.
describe('artie-enemy role', () => {
  it('matches the role name exactly, any case', () => {
    expect(isArtieEnemyRole('artie-enemy')).toBe(true);
    expect(isArtieEnemyRole('Artie-Enemy')).toBe(true);
    expect(isArtieEnemyRole('artie-enemy-fan')).toBe(false);
    expect(isArtieEnemyRole(undefined)).toBe(false);
  });

  it('finds it among a member’s roles', () => {
    expect(hasArtieEnemyRole(['Dev', 'artie-enemy'])).toBe(true);
    expect(hasArtieEnemyRole(['Dev', 'regular'])).toBe(false);
    expect(hasArtieEnemyRole([])).toBe(false);
  });
});
