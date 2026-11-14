import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { GitHubSyncEvent } from '../../../../src/gateway/watchers/github/poller.js';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'gh-self-')), 'test.db');

type Db = typeof import('../../../../src/shared/db/client.js');
let db: Db;
let GitHubEventProcessor: typeof import('../../../../src/gateway/watchers/github/event-batcher.js').GitHubEventProcessor;
let identity: typeof import('../../../../src/gateway/watchers/github/self-identity.js');
let pollerMod: typeof import('../../../../src/gateway/watchers/github/poller.js');
let digest: typeof import('../../../../src/gateway/watchers/github/studio-digest.js');

beforeAll(async () => {
  db = await import('../../../../src/shared/db/client.js');
  db.initializeDb();
  ({ GitHubEventProcessor } = await import('../../../../src/gateway/watchers/github/event-batcher.js'));
  identity = await import('../../../../src/gateway/watchers/github/self-identity.js');
  pollerMod = await import('../../../../src/gateway/watchers/github/poller.js');
  digest = await import('../../../../src/gateway/watchers/github/studio-digest.js');
});

function ev(type: GitHubSyncEvent['type'], data: GitHubSyncEvent['data']): GitHubSyncEvent {
  return { type, repo: 'o/r', channelId: 'c', guildId: 'g', data, timestamp: '2026-11-01T12:00:00Z' };
}

describe('self-echo filter', () => {
  beforeEach(() => identity.setSelfLoginForTests(null));

  it('drops Artie-authored events and keeps humans', async () => {
    const p = new GitHubEventProcessor();
    const cases: Array<[GitHubSyncEvent, boolean]> = [
      [ev('issue_opened', { issueNumber: 1, issueAuthor: 'coachartie' }), false],
      [ev('issue_opened', { issueNumber: 2, issueAuthor: 'ej' }), true],
      [ev('issue_comment', { issueNumber: 3, commentId: 1, commentAuthor: 'CoachArtie' }), false],
      [ev('issue_comment', { issueNumber: 3, commentId: 2, commentAuthor: 'ej' }), true],
      [ev('pr_comment', { prNumber: 4, commentId: 3, commentAuthor: 'coachartie' }), false],
      [ev('issue_labeled', { issueNumber: 5, label: 'x', commentAuthor: 'coachartie' }), false],
      [ev('issue_labeled', { issueNumber: 6, label: 'x', commentAuthor: 'ej' }), true],
      [ev('issue_assigned', { issueNumber: 7, assignee: 'ej', assignedBy: 'coachartie' }), false],
      [ev('pr_opened', { prNumber: 8, prAuthor: 'coachartie' }), false],
      // human reviewing Artie's PR is not an echo
      [ev('pr_approved', { prNumber: 9, prAuthor: 'coachartie', reviewId: 5, reviewAuthor: 'ej' }), true],
    ];
    for (const [event, shouldPost] of cases) {
      const out = await p.processEvent(event);
      expect(out.shouldPost, `${event.type} ${JSON.stringify(event.data)}`).toBe(shouldPost);
    }
  });

  it('uses the resolved login and caches it', async () => {
    const getAuthenticated = vi.fn().mockResolvedValue({ data: { login: 'artie-real' } });
    const octokit: any = { users: { getAuthenticated } };
    await identity.resolveSelfLogin(octokit);
    await identity.resolveSelfLogin(octokit);
    expect(getAuthenticated).toHaveBeenCalledTimes(1);
    const p = new GitHubEventProcessor();
    expect((await p.processEvent(ev('issue_opened', { issueNumber: 1, issueAuthor: 'artie-real' }))).shouldPost).toBe(false);
    expect((await p.processEvent(ev('issue_opened', { issueNumber: 2, issueAuthor: 'coachartie' }))).shouldPost).toBe(true);
  });

  it('falls back to coachartie when resolution fails', async () => {
    const octokit: any = { users: { getAuthenticated: vi.fn().mockRejectedValue(new Error('401')) } };
    expect(await identity.resolveSelfLogin(octokit)).toBe('coachartie');
    expect(identity.getSelfLogin()).toBe('coachartie');
  });
});

describe('separate comment cursors', () => {
  it('issue comments do not read or advance the PR comment cursor', async () => {
    db.getSyncDb().run(
      `INSERT INTO github_sync_state (repo, last_comment_id, metadata) VALUES ('o/cur', 900, NULL)`
    );
    const poller: any = new pollerMod.GitHubPollerService('t');
    const emitted: any[] = [];
    poller.emitEvent = (e: any) => emitted.push(e);
    poller.octokit = {
      issues: {
        listComments: vi.fn().mockResolvedValue({
          data: [
            { id: 950, body: 'new', user: { login: 'ej' }, html_url: 'u', created_at: 't' },
            { id: 850, body: 'old', user: { login: 'ej' }, html_url: 'u', created_at: 't' },
          ],
        }),
      },
    };
    const state = await poller.getSyncState('o/cur');
    const watch: any = { repo: 'o/cur', channelId: 'c', guildId: 'g' };
    // Legacy fallback: with no lastIssueCommentId yet, the sweep starts from the shared cursor.
    const cursor = pollerMod.readIssueCommentCursor(state);
    expect(cursor).toBe(900);
    const newest = await poller.pollIssueComments('o', 'cur', 1, watch, cursor);
    // 850 <= 900 suppressed, 950 emitted; the caller (not this function) commits the cursor.
    expect(emitted.map((e) => e.data.commentId)).toEqual([950]);
    expect(newest).toBe(950);
    const row: any = db.getSyncDb().get(`SELECT * FROM github_sync_state WHERE repo = 'o/cur'`);
    expect(row.last_comment_id).toBe(900);
  });

  it('one issue\'s newer comment does not hide another issue\'s older unseen one in the same sweep', async () => {
    const poller: any = new pollerMod.GitHubPollerService('t');
    const emitted: any[] = [];
    poller.emitEvent = (e: any) => emitted.push(e);
    const listComments = vi.fn();
    poller.octokit = { issues: { listComments } };
    const watch: any = { repo: 'o/sweep', channelId: 'c', guildId: 'g' };
    const sweepStart = 100;

    listComments.mockResolvedValueOnce({
      data: [{ id: 200, body: 'a', user: { login: 'ej' }, html_url: 'u', created_at: 't' }],
    });
    const a = await poller.pollIssueComments('o', 'sweep', 1, watch, sweepStart);
    listComments.mockResolvedValueOnce({
      data: [{ id: 150, body: 'b', user: { login: 'ej' }, html_url: 'u', created_at: 't' }],
    });
    const b = await poller.pollIssueComments('o', 'sweep', 2, watch, sweepStart);

    expect(emitted.map((e) => e.data.commentId)).toEqual([200, 150]);
    expect(Math.max(a, b)).toBe(200);
  });
});

describe('issue pagination', () => {
  it('stops at the watermark and caps at 3 pages', async () => {
    const poller: any = new pollerMod.GitHubPollerService('t');
    const page = (iso: string) =>
      Array.from({ length: 100 }, (_, i) => ({ number: i, updated_at: iso }));
    const list = vi.fn().mockResolvedValue({ data: page('2026-11-10T00:00:00Z') });
    poller.octokit = { issues: { listForRepo: list } };
    await poller.fetchUpdatedIssues('o', 'r', new Date('2026-01-01'));
    expect(list).toHaveBeenCalledTimes(3);

    list.mockClear();
    await poller.fetchUpdatedIssues('o', 'r', new Date('2026-12-01'));
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe('needs-a-human digest line', () => {
  it('formats counts, omitting zeros', () => {
    expect(digest.formatNeedsHumanLine({ unassigned: 12, unlabeled: 5, stale: 3 })).toBe(
      'Needs a human: 12 unassigned / 5 unlabeled / 3 stale 60d+'
    );
    expect(digest.formatNeedsHumanLine({ unassigned: 0, unlabeled: 2, stale: 0 })).toBe(
      'Needs a human: 2 unlabeled'
    );
    expect(digest.formatNeedsHumanLine({ unassigned: 0, unlabeled: 0, stale: 0 })).toBeNull();
    expect(digest.formatNeedsHumanLine(undefined)).toBeNull();
  });

  it('queries the search API sequentially with the right qualifiers', async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce({ data: { total_count: 4 } })
      .mockResolvedValueOnce({ data: { total_count: 2 } })
      .mockResolvedValueOnce({ data: { total_count: 1 } });
    const octokit: any = { search: { issuesAndPullRequests: search } };
    const counts = await digest.fetchNeedsHumanCounts(octokit, 'o', 'r', new Date('2026-11-13T00:00:00Z'), 0);
    expect(counts).toEqual({ unassigned: 4, unlabeled: 2, stale: 1 });
    const qs = search.mock.calls.map((c) => c[0].q);
    expect(qs[0]).toBe('is:issue is:open repo:o/r no:assignee');
    expect(qs[1]).toBe('is:issue is:open repo:o/r no:label');
    expect(qs[2]).toBe('is:issue is:open repo:o/r updated:<2026-09-14');
  });

  it('omits counts when a search errors', async () => {
    const octokit: any = {
      search: { issuesAndPullRequests: vi.fn().mockRejectedValue(new Error('rate limited')) },
    };
    expect(await digest.fetchNeedsHumanCounts(octokit, 'o', 'r', new Date(), 0)).toBeUndefined();
  });
});
