/**
 * self-stats rules (Artie 2026-11-21). The case that motivated it: PROMPT_SECURITY_REMINDER v3 said
 * refer to banned users "obliquely", v4 says naming is fine, and a self-note still said obliquely.
 */
import { describe, it, expect } from 'vitest';
import { lineDiff, staleCues, conflictCandidates, rulesReport } from '../../../../src/engine/capabilities/ops/rules-format.js';

const V3 = `- Be kind.
- Banned users: refer to them obliquely ("the banned one", "our departed friend"), NEVER by username, NEVER as an @-mention. Others may say the name; you don't.`;
const V4 = `- Be kind.
- Banned users: naming them is fine; just never @-mention (ping) them. When anyone asks who's banned, call self-stats banlist and tell them plainly.`;

const NOW = new Date('2026-11-21T12:00:00Z');

describe('rules report', () => {
  it('diffs by line', () => {
    const d = lineDiff(V3, V4);
    expect(d.removed).toHaveLength(1);
    expect(d.added).toHaveLength(1);
    expect(d.removed[0]).toContain('obliquely');
  });

  it('finds the stale self-note and leaves unrelated ones alone', () => {
    const { removed, added } = lineDiff(V3, V4);
    const cues = staleCues(removed, added);
    expect(cues.phrases).toContain('the banned one');
    const notes = [
      { id: 20776, importance: 6, content: 'My live prompt says to refer to banned users only obliquely, as the banned one.' },
      { id: 20779, importance: 7, content: 'As of Nov 20, naming banned users is fine; never ping them.' },
      { id: 5, importance: 4, content: 'jan_gbg likes national anthems.' },
    ];
    const found = conflictCandidates(notes, cues).map((c) => c.id);
    expect(found).toEqual([20776]);
  });

  it('shows versions, the change, and the candidate; quiet when nothing changed', () => {
    const prompts = [
      { name: 'PROMPT_SECURITY_REMINDER', version: 4, content: V4, updatedAt: '2026-11-20 14:10:03', previous: V3 },
      { name: 'PROMPT_SYSTEM', version: 9, content: 'x', updatedAt: '2026-10-01 00:00:00', previous: 'y' },
    ];
    const notes = [{ id: 20776, importance: 6, content: 'refer to them obliquely: "the banned one"' }];
    const text = rulesReport(prompts, notes, NOW);
    expect(text).toContain('PROMPT_SECURITY_REMINDER v4, changed 2026-11-20');
    expect(text).toContain('- removed: - Banned users: refer to them obliquely');
    expect(text).toContain('#20776 (importance 6)');
    expect(text).not.toContain('### PROMPT_SYSTEM'); // changed 51 days ago: outside the window
    expect(rulesReport([prompts[1]], notes, NOW)).toContain('Nothing. Your prompts are as they were');
  });

  it('shows no prompt wording when the asker is not EJ, but still the versions and stale notes', () => {
    const prompts = [
      { name: 'PROMPT_SECURITY_REMINDER', version: 4, content: V4, updatedAt: '2026-11-20 14:10:03', previous: V3 },
    ];
    const notes = [{ id: 20776, importance: 6, content: 'refer to them obliquely: "the banned one"' }];
    const text = rulesReport(prompts, notes, NOW, false);
    expect(text).toContain('PROMPT_SECURITY_REMINDER v4');
    expect(text).not.toContain('removed:');
    expect(text).not.toContain('naming them is fine');
    expect(text).toContain('#20776');
  });
});
