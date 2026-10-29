import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'memory-dream-')), 'test.db');
process.env.DREAM_TAGS_URL = 'http://127.0.0.1:9/tags.json'; // unreachable: exercises the fallback

const generate = vi.fn();
vi.mock('../../src/engine/4-generate/openrouter.js', () => ({
  openRouterService: { generateFromMessageChain: generate },
}));

let dreamMod: typeof import('../../src/engine/memory/dream.js');
let memoryMod: typeof import('../../src/engine/tools/core/memory.js');
let db: ReturnType<typeof import('../../src/shared/db/client.js').getSyncDb>;

beforeAll(async () => {
  const { getSyncDb } = await import('../../src/shared/db/client.js');
  db = getSyncDb();
  db.run(`CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]', context TEXT DEFAULT '', timestamp TEXT NOT NULL,
    importance INTEGER DEFAULT 5, metadata TEXT DEFAULT '{}')`);
  for (const col of ['metadata TEXT DEFAULT \'{}\'', 'guild_id TEXT']) {
    try {
      db.run(`ALTER TABLE memories ADD COLUMN ${col}`);
    } catch {
      // bootstrap already has it
    }
  }
  dreamMod = await import('../../src/engine/memory/dream.js');
  memoryMod = await import('../../src/engine/tools/core/memory.js');
});

function insert(content: string, importance = 5, tags: string[] = []): number {
  const r = db.run(
    `INSERT INTO memories (user_id, content, tags, timestamp, importance, metadata) VALUES (?, ?, ?, ?, ?, '{}')`,
    ['u1', content, JSON.stringify(tags), new Date().toISOString(), importance]
  );
  return Number(r.lastInsertRowid);
}
const row = (id: number) => db.get<any>('SELECT * FROM memories WHERE id = ?', [id]);

describe('dream', () => {
  beforeEach(() => {
    db.run('DELETE FROM memories');
    generate.mockReset();
  });

  it('tags keepers, soft-prunes junk, and never prunes protected memories', async () => {
    const fact = insert('Member A prefers the night-owl timetable and hates express skips');
    const junk = insert('The calculator tool computed 123 * 456 = 56088', 4, ['capability-reflection']);
    const pinned = insert('Never rank real people by appearance', 6, ['pinned']);
    const vital = insert('Daily summary: 1 messages exchanged', 9);

    generate.mockImplementation(async () =>
      JSON.stringify({
        memories: [
          { id: fact, kind: 'preference', tags: ['Transit', 'timetable'], verdict: 'keep', reason: 'pref' },
          { id: junk, kind: 'tool', tags: ['math'], verdict: 'junk', category: 'test', reason: 'smoke test' },
          { id: pinned, kind: 'rule', tags: ['ethics'], verdict: 'junk', reason: 'x' },
          { id: vital, kind: 'event', tags: ['stub'], verdict: 'junk', reason: 'x' },
          { id: 99999, kind: 'lore', tags: ['ghost'], verdict: 'junk', reason: 'not given' },
        ],
      })
    );

    const result = await dreamMod.dream(10);
    // fact, pinned and vital keep (the last two are protected) and gain tags; junk is pruned
    expect(result).toEqual({ reviewed: 4, tagged: 3, pruned: 1, prunedBy: { test: 1 } });

    expect(JSON.parse(row(fact).tags)).toEqual(['preference', 'transit', 'timetable']);
    expect(row(fact).importance).toBe(5);

    const j = row(junk);
    expect(j.importance).toBe(1);
    expect(JSON.parse(j.tags)).toContain('pruned');
    const meta = JSON.parse(j.metadata);
    expect(meta.pruned_by).toBe('dream');
    expect(meta.pruned_category).toBe('test');
    expect(meta.importance_before_dream).toBe(4);

    expect(row(pinned).importance).toBe(6);
    expect(row(vital).importance).toBe(9);
  });

  it('does not re-dream a memory, and leaves a failed chunk for tomorrow', async () => {
    const a = insert('first');
    generate.mockResolvedValueOnce(
      JSON.stringify({ memories: [{ id: a, kind: 'lore', tags: ['x'], verdict: 'keep', reason: '' }] })
    );
    await dreamMod.dream(10);
    const b = insert('second');
    generate.mockRejectedValueOnce(new Error('model down'));
    const r = await dreamMod.dream(10);
    expect(r.reviewed).toBe(0);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(JSON.parse(row(b).metadata ?? '{}').dreamt_at).toBeUndefined();
    // only the undreamt memory was offered the second night
    const offered = (generate.mock.calls[1][0] as any[])[1].content as string;
    expect(offered).toContain(`#${b}`);
    expect(offered).not.toContain(`#${a}`);
  });

  it('parses wrapped, bare and fenced verdict replies, dropping id-less ones', () => {
    const v = { id: 1, kind: 'lore', tags: ['a'], verdict: 'keep', reason: '' };
    expect(dreamMod.parseVerdicts(JSON.stringify({ memories: [v] }))).toEqual([v]);
    expect(dreamMod.parseVerdicts(JSON.stringify([v]))).toEqual([v]);
    expect(dreamMod.parseVerdicts('```json\n' + JSON.stringify([v, { kind: 'x' }]) + '\n```')).toEqual([v]);
    const { id: _id, ...rest } = v;
    expect(dreamMod.parseVerdicts(JSON.stringify({ '1': rest }))).toEqual([v]);
    expect(dreamMod.parseVerdicts('no json here')).toBeNull();
  });

  it('replaces filler tags but keeps vocabulary and structural ones', () => {
    const id = insert('Member B builds express-only lines', 5, ['this', 'primarily', 'transit', 'quest']);
    const m = db.get<any>('SELECT id, content, tags, importance, metadata FROM memories WHERE id = ?', [id]);
    const out = dreamMod.applyVerdict(
      m,
      { id, kind: 'preference', tags: ['express'], verdict: 'keep', reason: '' },
      new Date().toISOString(),
      new Set(['transit'])
    );
    expect(out).toBe('tagged');
    expect(JSON.parse(row(id).tags)).toEqual(['transit', 'quest', 'preference', 'express']);
  });

  it('files an unknown junk category under filler', () => {
    const id = insert('meh');
    const m = db.get<any>('SELECT id, content, tags, importance, metadata FROM memories WHERE id = ?', [id]);
    dreamMod.applyVerdict(m, { id, kind: 'lore', tags: [], verdict: 'junk', category: 'vibes' }, new Date().toISOString());
    expect(JSON.parse(row(id).metadata).pruned_category).toBe('filler');
  });

  it('normalizes tags and drops EJ action tags', () => {
    expect(dreamMod.normalizeTag('!tobuy')).toBe('tobuy');
    expect(dreamMod.normalizeTag(' Subway Builder ')).toBe('subway-builder');
  });
});

describe('dream journal + recall', () => {
  beforeEach(() => {
    db.run('DELETE FROM memories');
    generate.mockReset();
  });

  it('writes one journal entry per night with counts, examples and top tags', async () => {
    const junk = insert('Daily summary (2026-10-24): 1 messages exchanged', 8);
    const keep = insert('Alex wants deliveries in both games');
    generate.mockResolvedValueOnce(
      JSON.stringify({
        memories: [
          { id: junk, kind: 'event', tags: [], verdict: 'junk', category: 'stub', reason: 'empty stub' },
          { id: keep, kind: 'project', tags: ['subway-builder', 'deliveries'], verdict: 'keep', category: 'none', reason: '' },
        ],
      })
    );
    await dreamMod.dream(10);
    const j = db.get<any>(`SELECT * FROM memories WHERE tags LIKE '%dream-journal%'`);
    expect(j.user_id).toBe('artie-system');
    expect(j.content).toContain('reviewed 2 of 2');
    expect(j.content).toContain('1 stub (e.g. "Daily summary (2026-10-24): 1 messages exchanged")');
    expect(j.content).toContain('subway-builder');
    // the journal is never offered to tomorrow's dream
    generate.mockReset();
    await dreamMod.dream(10);
    expect(generate).not.toHaveBeenCalled();
  });

  it('recalls the latest journal for 36 hours, then goes quiet', () => {
    dreamMod.writeDreamJournal('Dream journal (Oct 30): reviewed 5 of 5 memories, re-tagged 3; let go of nothing.', {
      reviewed: 5, tagged: 3, pruned: 0,
    });
    const now = Date.now();
    expect(dreamMod.dreamRecallLine(now)).toContain("💭 Last night's memory dream:");
    expect(dreamMod.dreamRecallLine(now)).toContain('reviewed 5 of 5');
    expect(dreamMod.dreamRecallLine(now + 37 * 3_600_000)).toBe('');
  });
});

describe('daily summary stubs', () => {
  it('skips a day with no topics or key points, stores one with content', async () => {
    db.run('DELETE FROM memories');
    const { storeSummary } = await import('../../src/engine/memory/summarizer.js');
    const base = { userId: 'u9', date: '2026-10-28', sentiment: 'neutral' as const, messageCount: 1 };
    storeSummary({ ...base, summary: '1 messages exchanged', topics: [], keyPoints: [] });
    expect(db.get<any>('SELECT COUNT(*) AS n FROM memories').n).toBe(0);
    storeSummary({ ...base, summary: '4 messages exchanged. Topics discussed: express trains', topics: ['express trains'], keyPoints: [] });
    expect(db.get<any>('SELECT COUNT(*) AS n FROM memories').n).toBe(1);
  });
});

describe('memory tags from tool params', () => {
  it('parses comma strings and JSON-array strings (they used to be dropped)', () => {
    expect(memoryMod.ensureStringArray('monetization, Stripe')).toEqual(['monetization', 'stripe']);
    expect(memoryMod.ensureStringArray('["a","b","a"]')).toEqual(['a', 'b']);
    expect(memoryMod.ensureStringArray(['X'])).toEqual(['x']);
    expect(memoryMod.ensureStringArray(undefined)).toEqual([]);
  });
});
