import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { GitHubSyncEvent } from '../../../../src/gateway/watchers/github/poller.js';

// Mention resolution reads github_identity_mappings: give it an empty temp DB.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'gh-dedupe-')), 'test.db');

let GitHubEventProcessor: typeof import('../../../../src/gateway/watchers/github/event-batcher.js').GitHubEventProcessor;
beforeAll(async () => {
  const { initializeDb } = await import('../../../../src/shared/db/client.js');
  initializeDb();
  ({ GitHubEventProcessor } = await import('../../../../src/gateway/watchers/github/event-batcher.js'));
});

function ev(type: GitHubSyncEvent['type'], data: GitHubSyncEvent['data']): GitHubSyncEvent {
  return { type, repo: 'room302studio/coachartie2', channelId: 'c', guildId: 'g', data, timestamp: '2026-10-31T12:00:00Z' };
}

describe('GitHub batcher dedupe (G4)', () => {
  it('keeps a second comment on the same PR, drops a true duplicate', async () => {
    const p = new GitHubEventProcessor();
    const a = await p.processEvent(ev('pr_comment', { prNumber: 7, commentId: 1, commentAuthor: 'ej' }));
    const b = await p.processEvent(ev('pr_comment', { prNumber: 7, commentId: 2, commentAuthor: 'ej' }));
    const again = await p.processEvent(ev('pr_comment', { prNumber: 7, commentId: 2, commentAuthor: 'ej' }));
    expect(a.shouldPost).toBe(true);
    expect(b.shouldPost).toBe(true);
    expect(again.shouldPost).toBe(false);
  });

  it('keeps a second review on the same PR', async () => {
    const p = new GitHubEventProcessor();
    const a = await p.processEvent(ev('pr_approved', { prNumber: 7, reviewId: 10, reviewAuthor: 'a' }));
    const b = await p.processEvent(ev('pr_approved', { prNumber: 7, reviewId: 11, reviewAuthor: 'b' }));
    expect(a.shouldPost).toBe(true);
    expect(b.shouldPost).toBe(true);
  });

  it('keeps a review request for a second reviewer, drops the replayed one', async () => {
    const p = new GitHubEventProcessor();
    const a = await p.processEvent(ev('pr_review_requested', { prNumber: 7, reviewers: ['alice'] }));
    const b = await p.processEvent(ev('pr_review_requested', { prNumber: 7, reviewers: ['bob'] }));
    const again = await p.processEvent(ev('pr_review_requested', { prNumber: 7, reviewers: ['bob'] }));
    expect(a.shouldPost).toBe(true);
    expect(b.shouldPost).toBe(true);
    expect(again.shouldPost).toBe(false);
  });

  it('still drops a repeated PR-level event', async () => {
    const p = new GitHubEventProcessor();
    const a = await p.processEvent(ev('pr_opened', { prNumber: 8, prAuthor: 'ej' }));
    const b = await p.processEvent(ev('pr_opened', { prNumber: 8, prAuthor: 'ej' }));
    expect(a.shouldPost).toBe(true);
    expect(b.shouldPost).toBe(false);
  });
});
