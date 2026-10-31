import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Client } from 'discord.js';

// Throwaway DB: initializeDb() creates github_sync_state and github_identity_mappings.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'gh-cursors-')), 'test.db');

type Db = typeof import('../../../../src/shared/db/client.js');
let db: Db;
let poller: any;
let watchLoop: typeof import('../../../../src/gateway/watchers/github/watch-loop.js');
let batcher: typeof import('../../../../src/gateway/watchers/github/event-batcher.js');

beforeAll(async () => {
  db = await import('../../../../src/shared/db/client.js');
  db.initializeDb();
  const { GitHubPollerService } = await import('../../../../src/gateway/watchers/github/poller.js');
  poller = new GitHubPollerService('test-token');
  watchLoop = await import('../../../../src/gateway/watchers/github/watch-loop.js');
  batcher = await import('../../../../src/gateway/watchers/github/event-batcher.js');
});

function row(repo: string): any {
  return db.getSyncDb().get('SELECT * FROM github_sync_state WHERE repo = ?', [repo]);
}

describe('GitHub sync cursors (G2)', () => {
  it('id cursors never move backwards', async () => {
    db.getSyncDb().run(
      `INSERT INTO github_sync_state (repo, last_review_id, last_comment_id, last_check_run_id) VALUES ('o/r', 500, 500, 500)`
    );
    // A later PR in the same poll loop writes its own, older ids.
    await poller.updateSyncState('o/r', { lastReviewId: 300, lastCommentId: 300, lastCheckRunId: 300 });
    let r = row('o/r');
    expect([r.last_review_id, r.last_comment_id, r.last_check_run_id]).toEqual([500, 500, 500]);

    await poller.updateSyncState('o/r', { lastReviewId: 600, lastCommentId: 700, lastCheckRunId: 800 });
    r = row('o/r');
    expect([r.last_review_id, r.last_comment_id, r.last_check_run_id]).toEqual([600, 700, 800]);
  });

  it('a null cursor advances', async () => {
    db.getSyncDb().run(`INSERT INTO github_sync_state (repo, last_review_id) VALUES ('o/null', NULL)`);
    await poller.updateSyncState('o/null', { lastReviewId: 42 });
    expect(row('o/null').last_review_id).toBe(42);
  });

  it('saving the commit SHA keeps the issue watermark', async () => {
    db.getSyncDb().run(
      `INSERT INTO github_sync_state (repo, metadata) VALUES ('o/meta', '{"lastIssueUpdatedAt":"2026-10-31T10:00:00Z","lastCommitSha":"old"}')`
    );
    // pollIssues advanced the watermark; pollCommits still holds the start-of-poll snapshot.
    await poller.mergeSyncMetadata('o/meta', { lastIssueUpdatedAt: '2026-10-31T12:00:00Z' });
    await poller.mergeSyncMetadata('o/meta', { lastCommitSha: 'new' });
    expect(JSON.parse(row('o/meta').metadata)).toEqual({
      lastIssueUpdatedAt: '2026-10-31T12:00:00Z',
      lastCommitSha: 'new',
    });
  });
});

function pendingService(postBatch: (b: unknown) => Promise<void>): any {
  const svc: any = new watchLoop.GitHubSyncService({} as Client);
  svc.processor = new batcher.GitHubEventProcessor({ batchWindowMs: 60 * 60 * 1000 });
  svc.poster = { postBatch };
  return svc;
}

async function queueOne(svc: any): Promise<void> {
  const processed = await svc.processor.processEvent({
    type: 'pr_opened',
    repo: 'o/r',
    channelId: 'c',
    guildId: 'g',
    data: { prNumber: 1, prAuthor: 'ej' },
    timestamp: '2026-10-31T12:00:00Z',
  });
  await svc.processor.addToBatch(processed, () => undefined);
}

describe('GitHub shutdown flush (G5)', () => {
  it('posts pending batches and waits for the send', async () => {
    let sent = false;
    const svc = pendingService(async () => {
      await new Promise((r) => setTimeout(r, 20));
      sent = true;
    });
    await queueOne(svc);
    await svc.stop();
    expect(sent).toBe(true);
  });

  it('gives up at the cap when a send hangs', async () => {
    vi.useFakeTimers();
    try {
      const svc = pendingService(() => new Promise<void>(() => undefined));
      await queueOne(svc);
      let done = false;
      const stopping = svc.stop(1000).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await stopping;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
