import { describe, it, expect } from 'vitest';
import { cleanHealthNarrative } from '../../src/engine/proactive/morning-briefing.js';

// Wave 7 / ledger #6: the bold-marker strip actually strips.
describe('cleanHealthNarrative', () => {
  it('strips ** markers', () => {
    expect(cleanHealthNarrative('Slept **7h**, HRV **up**.')).toBe('Slept 7h, HRV up.');
  });

  it('drops empty and (placeholder) narratives', () => {
    expect(cleanHealthNarrative('')).toBe('');
    expect(cleanHealthNarrative('(no data yet)')).toBe('');
  });

  it('leaves single * alone', () => {
    expect(cleanHealthNarrative('a *soft* day')).toBe('a *soft* day');
  });
});
