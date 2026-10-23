import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'user-mem-')), 'test.db');

let m: typeof import('../src/services/user-memories.js');
beforeAll(async () => {
  const { getSyncDb } = await import('@coachartie/shared');
  const db = getSyncDb();
  db.run(`CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]', context TEXT DEFAULT '', timestamp TEXT NOT NULL,
    importance INTEGER DEFAULT 5)`);
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tags, context)`);
  const add = (user: string, content: string, ts: string, tags: string[], importance = 5) => {
    const { lastInsertRowid } = db.run(
      `INSERT INTO memories (user_id, content, tags, timestamp, importance) VALUES (?, ?, ?, ?, ?)`,
      [user, content, JSON.stringify(tags), ts, importance]
    );
    db.run(`INSERT INTO memories_fts (rowid, content, tags, context) VALUES (?, ?, ?, '')`, [
      lastInsertRowid,
      content,
      JSON.stringify(tags),
    ]);
  };
  const recent = new Date().toISOString();
  add('alice', 'Alice loves tunnels and bridges', recent, ['subway', 'bridges'], 8);
  add('alice', 'Alice asked about the quiz', '2026-01-01T00:00:00Z', ['quiz']);
  add('bob', 'Bob secret: bridges are his whole personality', recent, ['bridges']);
  m = await import('../src/services/user-memories.js');
});

describe('own memories only', () => {
  it('search never returns another user’s memory, even when it matches', () => {
    const rows = m.searchOwnMemories('alice', 'bridges', 20);
    expect(rows.map((r) => r.content)).toEqual(['Alice loves tunnels and bridges']);
    expect(m.searchOwnMemories('bob', 'bridges', 20).every((r) => r.content.startsWith('Bob'))).toBe(true);
  });

  it('survives FTS syntax in the query', () => {
    expect(() => m.searchOwnMemories('alice', 'bridges" OR user_id:bob NEAR(', 20)).not.toThrow();
  });

  it('recent is newest-first and scoped', () => {
    const rows = m.recentOwnMemories('alice', 10);
    expect(rows).toHaveLength(2);
    expect(rows[0].content).toContain('tunnels');
  });

  it('stats count only the caller and parse JSON tags', () => {
    const s = m.ownMemoryStats('alice');
    expect(s.total).toBe(2);
    expect(s.lastWeek).toBe(1);
    expect(s.oldest).toBe('2026-01-01T00:00:00Z');
    expect(s.topTags.map(([t]) => t).sort()).toEqual(['bridges', 'quiz', 'subway']);
    expect(m.ownMemoryStats('nobody').total).toBe(0);
  });
});
