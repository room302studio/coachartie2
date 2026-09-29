import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// A throwaway DB with just the watches table; must be set before @coachartie/shared opens one.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'gh-watches-')), 'test.db');

let w: typeof import('../src/services/github-watches.js');
beforeAll(async () => {
  const { getSyncDb } = await import('@coachartie/shared');
  const db = getSyncDb();
  db.run(`CREATE TABLE IF NOT EXISTS github_repo_watches (
    id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL, events TEXT DEFAULT '["all"]', settings TEXT DEFAULT '{}',
    is_active INTEGER DEFAULT 1, created_by TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  db.run(
    `INSERT INTO github_repo_watches (repo, guild_id, channel_id, created_by)
     VALUES ('room302studio/coachartie2', 'g1', 'robot', 'org-watcher')`
  );
  w = await import('../src/services/github-watches.js');
});

describe('parseWatchEvents', () => {
  it('accepts every event the poller understands', () => {
    expect(w.parseWatchEvents('pr, issues,push, ci ,review').invalid).toEqual([]);
  });
  it('collapses to all and reports unknown names', () => {
    expect(w.parseWatchEvents('pr,all').events).toEqual(['all']);
    expect(w.parseWatchEvents(null).events).toEqual(['all']);
    expect(w.parseWatchEvents('pr,deploys').invalid).toEqual(['deploys']);
  });
});

describe('watch lifecycle', () => {
  it('pauses instead of deleting, so the org watcher cannot re-add it', () => {
    expect(w.pauseWatch('room302studio/coachartie2', 'g1')).toEqual({ paused: 1, found: 1 });
    const rows = w.listGuildWatches('g1');
    expect(rows).toHaveLength(1); // row kept → org watcher sees it as watched
    expect(rows[0].isActive).toBe(false);
    expect(w.pauseWatch('room302studio/coachartie2', 'g1')).toEqual({ paused: 0, found: 1 });
  });

  it('resumes, moves channel and changes events in place', () => {
    const r = w.upsertWatch('room302studio/coachartie2', 'g1', 'dev', ['pr', 'ci'], 'ej');
    expect(r).toEqual({ outcome: 'resumed', previousChannelId: 'robot' });
    const [row] = w.listGuildWatches('g1');
    expect(row.isActive).toBe(true);
    expect(row.channelId).toBe('dev');
    expect(w.describeEvents(row.events)).toBe('pr, ci');
    expect(w.upsertWatch('room302studio/coachartie2', 'g1', 'dev', ['all'], 'ej').outcome).toBe('updated');
  });

  it('creates new watches and reports unknown repos honestly', () => {
    expect(w.upsertWatch('Subway-Builder/metro-maker4', 'g1', 'robot', ['all'], 'ej').outcome).toBe(
      'created'
    );
    expect(w.pauseWatch('nobody/nothing', 'g1')).toEqual({ paused: 0, found: 0 });
    expect(w.suggestRepos('g1', 'metro')).toEqual(['Subway-Builder/metro-maker4']);
  });
});
