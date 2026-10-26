import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'last-time-')), 'test.db');

let lt: typeof import('../../src/engine/3-context/sources/last-time.js');

beforeAll(async () => {
  const { getSyncDb } = await import('../../src/shared/db/client.js');
  const db = getSyncDb();
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL, user_id TEXT NOT NULL,
    message_type TEXT, channel_id TEXT, guild_id TEXT, role TEXT, created_at TEXT NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]', context TEXT DEFAULT '', timestamp TEXT NOT NULL,
    importance INTEGER DEFAULT 5)`);
  // getSyncDb() bootstraps its own legacy "memories" (no guild_id) the first time it's
  // called anywhere in this process, ahead of the CREATE above — add the column if the
  // bootstrap won the race, same as client.ts's own addColumnIfMissing pattern.
  try {
    db.run(`ALTER TABLE memories ADD COLUMN guild_id TEXT`);
  } catch {
    // already has it
  }
  db.run(`CREATE TABLE IF NOT EXISTS objectives (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, owner TEXT, status TEXT, updated_at TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS todo_lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, name TEXT NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS todo_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, list_id INTEGER NOT NULL, content TEXT NOT NULL,
    status TEXT, position INTEGER NOT NULL)`);

  const msg = (user: string, value: string, guildId: string | null, channelId: string, createdAt: string, role: string | null = null) =>
    db.run(
      `INSERT INTO messages (value, user_id, channel_id, guild_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [value, user, channelId, guildId, role, createdAt]
    );

  // guild-scoped history for "piper": an older real exchange, then the live turn.
  msg('piper', 'hey can you help me debug the subway save-file loader', 'g1', 'c1', '2026-10-20T10:00:00Z');
  msg('artie', 'sure, paste the error', 'g1', 'c1', '2026-10-20T10:00:05Z', 'assistant');
  msg('piper', 'what is up with the metro doctor today', 'g1', 'c1', '2026-10-26T09:00:00Z'); // the "live" turn

  // a speaker whose last message is too short to be a topic, but has a high-importance memory.
  msg('nova', 'thx', 'g1', 'c2', '2026-10-18T12:00:00Z');
  msg('nova', 'lol', 'g1', 'c2', '2026-10-25T12:00:00Z'); // live turn
  db.run(
    `INSERT INTO memories (user_id, content, tags, timestamp, importance, guild_id) VALUES (?, ?, ?, ?, ?, ?)`,
    ['nova', 'Nova is building a Jacquard-loom-inspired animation pipeline', '[]', '2026-10-19T00:00:00Z', 8, 'g1']
  );

  // a speaker with no prior history at all (only the live turn exists).
  msg('ghost', 'hello artie', 'g1', 'c3', '2026-10-26T09:00:00Z');

  // open loop: an objective owned by piper.
  db.run(
    `INSERT INTO objectives (id, title, owner, status, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ['obj1', 'file the signal-loop bug report', 'piper', 'active', '2026-10-21T00:00:00Z']
  );

  lt = await import('../../src/engine/3-context/sources/last-time.js');
});

describe('relativeAge', () => {
  it('buckets from just-now through years', () => {
    const now = new Date('2026-10-26T12:00:00Z');
    expect(lt.relativeAge('2026-10-26T11:59:30Z', now)).toBe('just now');
    expect(lt.relativeAge('2026-10-26T10:00:00Z', now)).toBe('2h ago');
    expect(lt.relativeAge('2026-10-23T12:00:00Z', now)).toBe('3d ago');
    expect(lt.relativeAge('2026-09-01T12:00:00Z', now)).toContain('mo ago');
  });
});

describe('lastTimeLine', () => {
  it('renders topic and open loop when both are present', () => {
    const line = lt.lastTimeLine(
      { lastAt: '2026-10-20T10:00:00Z', topic: 'subway save-file loader', openLoop: 'file the bug report' },
      new Date('2026-10-26T12:00:00Z')
    );
    expect(line).toBe('⏱️ last talked 6d ago, about subway save-file loader — open: file the bug report.');
  });

  it('omits the "about" and "open" clauses when absent', () => {
    const line = lt.lastTimeLine({ lastAt: '2026-10-26T11:00:00Z', topic: null, openLoop: null }, new Date('2026-10-26T12:00:00Z'));
    expect(line).toBe('⏱️ last talked 1h ago.');
  });
});

describe('getLastTimeFacts', () => {
  it('skips the live turn and uses the previous exchange as the topic', () => {
    const facts = lt.getLastTimeFacts('piper', { guildId: 'g1' });
    expect(facts).not.toBeNull();
    expect(facts!.lastAt).toBe('2026-10-20T10:00:00Z');
    expect(facts!.topic).toContain('debug the subway save-file loader');
    expect(facts!.openLoop).toBe('file the signal-loop bug report');
  });

  it('falls back to a high-importance memory when the last message is too thin', () => {
    const facts = lt.getLastTimeFacts('nova', { guildId: 'g1' });
    expect(facts).not.toBeNull();
    expect(facts!.topic).toContain('Jacquard-loom');
    expect(facts!.openLoop).toBeNull();
  });

  it('returns null when there is no prior exchange (only the live turn exists)', () => {
    expect(lt.getLastTimeFacts('ghost', { guildId: 'g1' })).toBeNull();
  });

  it('returns null with no guild or channel scope to anchor to', () => {
    expect(lt.getLastTimeFacts('piper', {})).toBeNull();
  });
});
