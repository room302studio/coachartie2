import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'memory-keyword-')), 'test.db');

const GUILD = 'guild-main';
const PRIVATE = 'guild-private';
const OTHER = 'guild-other';

let store: typeof import('../../src/engine/memory/store.js');
let db: ReturnType<typeof import('../../src/shared/db/client.js').getSyncDb>;

beforeAll(async () => {
  const { getSyncDb } = await import('../../src/shared/db/client.js');
  db = getSyncDb();
  db.run(`CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]', context TEXT DEFAULT '', timestamp TEXT NOT NULL,
    importance INTEGER DEFAULT 5, metadata TEXT DEFAULT '{}')`);
  for (const col of [
    "metadata TEXT DEFAULT '{}'", 'guild_id TEXT', 'channel_id TEXT', 'related_message_id TEXT',
    'created_at TEXT', 'updated_at TEXT', 'embedding TEXT',
  ]) {
    try {
      db.run(`ALTER TABLE memories ADD COLUMN ${col}`);
    } catch {
      // bootstrap already has it
    }
  }
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tags, context, content='memories', content_rowid='id')`);
  store = await import('../../src/engine/memory/store.js');
});

function insert(userId: string, content: string, guildId: string | null, importance = 6, timestamp = '2026-02-04T00:00:00Z') {
  const r = db.run(
    `INSERT INTO memories (user_id, content, tags, timestamp, importance, metadata, guild_id) VALUES (?, ?, '[]', ?, ?, '{}', ?)`,
    [userId, content, timestamp, importance, guildId]
  );
  const id = Number(r.lastInsertRowid);
  db.run(`INSERT INTO memories_fts (rowid, content, tags, context) VALUES (?, ?, '[]', '')`, [id, content]);
  return id;
}

describe('ftsKeywordQuery', () => {
  it('keeps the distinctive words, adds singulars, drops memory-question filler', () => {
    expect(store.ftsKeywordQuery('do you remember the bee movie incident and the trolls?')).toBe(
      '"bee" OR "movie" OR "incident" OR "trolls" OR "troll"'
    );
    expect(store.ftsKeywordQuery('do you remember?')).toBe('');
    expect(store.ftsKeywordQuery('<@123456789> what about https://x.com/y 2026')).toBe('');
  });
});

describe('readableGuilds', () => {
  it('reads one way from the env spec', () => {
    const spec = `${PRIVATE}:${GUILD}|x, y:z`;
    expect(store.readableGuilds(PRIVATE, spec)).toEqual([GUILD, 'x']);
    expect(store.readableGuilds(GUILD, spec)).toEqual([]);
    expect(store.readableGuilds('y', spec)).toEqual(['z']);
  });
});

describe('keywordSearch', () => {
  beforeEach(() => {
    db.run('DELETE FROM memories');
    db.run(`INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')`);
  });

  it('finds an old memory by keyword, ranked over weak matches', () => {
    const weak = insert('u2', 'We watched a movie once', GUILD, 3, '2026-10-01T00:00:00Z');
    const bee = insert('artie-social', 'The meow incident: "the bee movie but every word is meow", plus jailbreak trolls', GUILD, 7);
    const hits = store.hybridDataLayer.keywordSearch('do you remember the bee movie incident', { userId: 'ej', guildIds: [GUILD] });
    expect(hits.map((m) => m.id)).toEqual([bee, weak]);
  });

  it('stays inside the guild scope', () => {
    insert('artie-social', 'bee movie incident in another server', OTHER);
    const mine = insert('ej', 'my own unscoped bee movie note', null);
    const theirs = insert('u3', 'someone else unscoped bee movie note', null);
    const ids = store.hybridDataLayer
      .keywordSearch('bee movie', { userId: 'ej', guildIds: [GUILD] })
      .map((m) => m.id);
    expect(ids).toEqual([mine]);
    expect(ids).not.toContain(theirs);
  });

  it('reads a source guild when allowed, and outside a guild only the asker and Artie', () => {
    const main = insert('artie-social', 'bee movie incident', GUILD);
    insert('u3', 'bee movie from u3 in no guild', null);
    expect(
      store.hybridDataLayer.keywordSearch('bee movie', { userId: 'ej', guildIds: [PRIVATE] }).map((m) => m.id)
    ).toEqual([]);
    expect(
      store.hybridDataLayer.keywordSearch('bee movie', { userId: 'ej', guildIds: [PRIVATE, GUILD] }).map((m) => m.id)
    ).toEqual([main]);
    expect(store.hybridDataLayer.keywordSearch('bee movie', { userId: 'ej' }).map((m) => m.id)).toEqual([main]);
  });

  it('skips noise (low importance, observations)', () => {
    insert('artie-social', 'bee movie low importance', GUILD, 2);
    insert('observational-system', 'bee movie observed', GUILD, 6);
    expect(store.hybridDataLayer.keywordSearch('bee movie', { userId: 'ej', guildIds: [GUILD] })).toEqual([]);
  });
});
