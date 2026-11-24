import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'last-time-')), 'test.db');

let lt: typeof import('../../../../src/engine/3-context/sources/last-time.js');

beforeAll(async () => {
  const { getSyncDb } = await import('../../../../src/shared/db/client.js');
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

  // a speaker whose last ANSWERED message is too short to be a topic (but it was a real
  // exchange — Artie replied), has a high-importance memory to fall back to, and then
  // posts once more with no reply yet (the "live" turn — must not count as the exchange).
  msg('nova', 'thx', 'g1', 'c2', '2026-10-18T12:00:00Z');
  msg('artie', 'np', 'g1', 'c2', '2026-10-18T12:00:05Z', 'assistant');
  msg('nova', 'lol', 'g1', 'c2', '2026-10-25T12:00:00Z'); // live turn, unanswered
  db.run(
    `INSERT INTO memories (user_id, content, tags, timestamp, importance, guild_id) VALUES (?, ?, ?, ?, ?, ?)`,
    ['nova', 'Nova is building a Jacquard-loom-inspired animation pipeline', '[]', '2026-10-19T00:00:00Z', 8, 'g1']
  );

  // a speaker with no prior history at all (only the live turn exists).
  msg('ghost', 'hello artie', 'g1', 'c3', '2026-10-26T09:00:00Z');

  // a speaker who chats all day in a passive/ambient channel (stored for history, never
  // generated on) without a single reply — per queue-worker.ts, messages like these are
  // still rows in `messages`. There's no real exchange here; must not count as one.
  msg('chatty', 'anyone awake', 'g1', 'c4', '2026-10-26T08:00:00Z');
  msg('chatty', 'guess not', 'g1', 'c4', '2026-10-26T08:05:00Z');

  // piper's DM history (no guild), so the DM path has a prior exchange.
  msg('piper', 'can you remind me what I was filing about the signal loop', null, 'dm-piper', '2026-10-22T10:00:00Z');
  msg('artie', 'the bug report, yes', null, 'dm-piper', '2026-10-22T10:00:05Z', 'assistant');

  // open loop: an objective owned by piper.
  db.run(
    `INSERT INTO objectives (id, title, owner, status, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ['obj1', 'file the signal-loop bug report', 'piper', 'active', '2026-10-21T00:00:00Z']
  );

  // created_at written the way SQLite's own datetime('now') writes it in production
  // (no timezone suffix) — exercises the strftime normalization in lastExchangeRow.
  msg('zed', 'any update on the render queue', 'g1', 'c5', '2026-10-24 10:00:00');
  msg('artie', 'still queued', 'g1', 'c5', '2026-10-24 10:00:05', 'assistant');

  lt = await import('../../../../src/engine/3-context/sources/last-time.js');
});

describe('relativeAge', () => {
  it('buckets from just-now through years', () => {
    const now = new Date('2026-10-26T12:00:00Z');
    expect(lt.relativeAge('2026-10-26T11:59:30Z', now)).toBe('just now');
    expect(lt.relativeAge('2026-10-26T10:00:00Z', now)).toBe('2h ago');
    expect(lt.relativeAge('2026-10-23T12:00:00Z', now)).toBe('3d ago');
    expect(lt.relativeAge('2026-06-01T12:00:00Z', now)).toContain('mo ago');
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
    // objectives carry no guild_id, so a DM-set goal must not surface in a guild
    expect(facts!.openLoop).toBeNull();
  });

  it('shows the open loop in a DM, where nothing unscoped can leak to a public channel', () => {
    const facts = lt.getLastTimeFacts('piper', { channelId: 'dm-piper' });
    expect(facts).not.toBeNull();
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

  it('ignores an all-day chatter with no reply — passive history is not an exchange', () => {
    expect(lt.getLastTimeFacts('chatty', { guildId: 'g1' })).toBeNull();
  });

  it('normalizes a non-UTC-suffixed created_at (SQLite datetime() format) to a real ISO Z string', () => {
    const facts = lt.getLastTimeFacts('zed', { guildId: 'g1' });
    expect(facts).not.toBeNull();
    expect(facts!.lastAt).toBe('2026-10-24T10:00:00Z');
  });
});
