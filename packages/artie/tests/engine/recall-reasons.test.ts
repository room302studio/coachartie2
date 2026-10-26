import { describe, it, expect } from 'vitest';
import { MemoryRecaller } from '../../src/engine/memory/recall.js';

/**
 * "Why did this match" (Artie's own request, 2026-10-26): every memory the hybrid
 * recall path surfaces should carry a tiny reason tag. These tests inject fixed
 * candidates (bypassing the DB-backed fetchCandidates) so the assertions are about
 * the reason text and ranking, not about live data.
 */

interface Candidate {
  content: string;
  importance: number;
  date: string;
  tags: string[];
}

function recallerWithCandidates(candidates: Candidate[]): MemoryRecaller {
  const recaller = new MemoryRecaller();
  (recaller as unknown as { fetchCandidates: () => Promise<Candidate[]> }).fetchCandidates =
    async () => candidates;
  return recaller;
}

describe('semantic recall reasons', () => {
  it('tags a participant-mention match as "mentions <name>", not a keyword or score', async () => {
    const recaller = recallerWithCandidates([
      { content: 'Jan is debugging the Piccadilly line signal bug', importance: 5, date: '2020-01-01', tags: [] },
    ]);

    const result = await recaller.getMemoryContext('what has jan been working on', 'someone', {
      participants: ['jan'],
    });

    expect(result.content).toContain('[mentions jan]');
  });

  it('tags a plain keyword/relevance match with a shared term and flags high importance', async () => {
    const recaller = recallerWithCandidates([
      {
        content: 'Sam filed a bug about the Piccadilly signal failure last week',
        importance: 8,
        date: '2020-01-01',
        tags: [],
      },
    ]);

    const result = await recaller.getMemoryContext('piccadilly signal bug status', 'someone', {});

    // Either a shared keyword or, failing that, the raw similarity score — never empty.
    expect(result.content).toMatch(/\[(kw:\w+|sim \d\.\d\d), imp\]/);
  });

  it('does not change which memories are selected or their order (reason text only)', async () => {
    const candidates: Candidate[] = [
      { content: 'Jan is debugging the Piccadilly line signal bug', importance: 5, date: '2020-01-01', tags: [] },
      { content: 'Totally unrelated note about snacks', importance: 5, date: '2020-01-01', tags: [] },
    ];

    const recaller = recallerWithCandidates(candidates);
    const result = await recaller.getMemoryContext('what has jan been working on', 'someone', {
      participants: ['jan'],
    });

    // Only the participant-relevant memory clears threshold; the unrelated one is dropped,
    // exactly as it would be without any reason annotation.
    expect(result.memoryCount).toBe(1);
    expect(result.content).toContain('Jan is debugging');
    expect(result.content).not.toContain('snacks');
  });
});

describe('temporal recall reasons', () => {
  it('tags a same-day memory as "recent" with its age in days', async () => {
    const recaller = recallerWithCandidates([
      { content: 'Had a long chat about the subway save-file format', importance: 5, date: new Date().toISOString(), tags: [] },
    ]);

    const result = await recaller.getMemoryContext('anything new', 'someone', {});

    expect(result.content).toMatch(/\[recent, 0d\]/);
  });
});
