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

describe('same-second issue watermark', () => {
  const T = '2026-11-13T12:00:00Z';
  const T2 = '2026-11-13T12:00:05Z';

  function issue(number: number, at: string, extra: Record<string, unknown> = {}) {
    return { number, title: `#${number}`, html_url: 'u', user: { login: 'ej' }, labels: [],
      state: 'open', created_at: at, updated_at: at, ...extra };
  }

  async function sweep(repo: string, listed: any[]) {
    const poller: any = new pollerMod.GitHubPollerService('t');
    const emitted: any[] = [];
    poller.emitEvent = (e: any) => emitted.push(e);
    poller.pollIssueTimeline = vi.fn();
    poller.pollIssueComments = vi.fn().mockResolvedValue(0);
    poller.octokit = {
      issues: {
        listForRepo: vi.fn().mockResolvedValue({ data: listed }),
        listCommentsForRepo: vi.fn().mockResolvedValue({ data: [] }),
        get: vi.fn().mockResolvedValue({ data: { closed_by: { login: 'ej' } } }),
      },
    };
    const state = await poller.getSyncState(repo);
    await poller.pollIssues('o', repo.split('/')[1], { repo, channelId: 'c', guildId: 'g' }, state);
    const after: any = await poller.getSyncState(repo);
    return { opened: emitted.filter((e) => e.type === 'issue_opened').map((e) => e.data.issueNumber),
      closed: emitted.filter((e) => e.type === 'issue_closed').map((e) => e.data.issueNumber),
      commentsPolled: poller.pollIssueComments.mock.calls.map((c: any[]) => c[2]),
      meta: JSON.parse(after.metadata) };
  }

  it('isAfterMark: past is after, same second only if unseen', () => {
    const mark = new Date(T).getTime();
    expect(pollerMod.isAfterMark(new Date(T2), mark, 1, new Set([1]))).toBe(true);
    expect(pollerMod.isAfterMark(new Date(T), mark, 1, new Set([1]))).toBe(false);
    expect(pollerMod.isAfterMark(new Date(T), mark, 2, new Set([1]))).toBe(true);
    expect(pollerMod.isAfterMark(new Date('2026-11-13T11:59:59Z'), mark, 2, new Set())).toBe(false);
  });

  it('nextIssueWatermark: moves to newest second, carries the list only if it did not move', () => {
    const mark = new Date(T).getTime();
    expect(pollerMod.nextIssueWatermark(mark, new Set([1]), [{ number: 2, updatedAt: T }])).toEqual({
      updatedAt: new Date(T).toISOString(), numbers: [1, 2] });
    expect(pollerMod.nextIssueWatermark(mark, new Set([1]), [
      { number: 3, updatedAt: T2 }, { number: 4, updatedAt: T2 }, { number: 2, updatedAt: T },
    ])).toEqual({ updatedAt: T2, numbers: [3, 4] });
  });

  it('announces a same-second issue that showed up a poll late, exactly once', async () => {
    const repo = 'o/samesec';
    db.getSyncDb().run(
      `INSERT INTO github_sync_state (repo, metadata) VALUES (?, ?)`,
      [repo, JSON.stringify({ lastIssueUpdatedAt: T, issuesAtWatermark: [1] })]
    );
    // #1 was handled last poll; #2 and #3 share its second but lagged in the list.
    const first = await sweep(repo, [issue(3, T), issue(2, T), issue(1, T)]);
    expect(first.opened).toEqual([3, 2]);
    // created ON the watermark second: announced, and its comments are still checked
    expect(first.commentsPolled).toEqual([3, 2]);
    expect(first.meta.issuesAtWatermark).toEqual([1, 2, 3]);
    const second = await sweep(repo, [issue(3, T), issue(2, T), issue(1, T)]);
    expect(second.opened).toEqual([]);
  });

  it('a burst of three in one second all announce, then the mark moves on cleanly', async () => {
    const repo = 'o/burst';
    db.getSyncDb().run(
      `INSERT INTO github_sync_state (repo, metadata) VALUES (?, ?)`,
      [repo, JSON.stringify({ lastIssueUpdatedAt: T, issuesAtWatermark: [] })]
    );
    const r = await sweep(repo, [issue(12, T2), issue(11, T2), issue(10, T2)]);
    expect(r.opened.sort()).toEqual([10, 11, 12]);
    expect(r.commentsPolled).toEqual([]); // created after the mark: nothing older to check
    expect(r.meta).toMatchObject({ lastIssueUpdatedAt: T2, issuesAtWatermark: [10, 11, 12] });
    // a later close of #10 on a new second is still announced, and #10 isn't re-opened
    const closedAt = '2026-11-13T12:01:00Z';
    const r2 = await sweep(repo, [issue(10, T2, { state: 'closed', closed_at: closedAt, updated_at: closedAt }),
      issue(12, T2), issue(11, T2)]);
    expect(r2.opened).toEqual([]);
    expect(r2.closed).toEqual([10]);
  });

  it('first sync seeds the issue watermark, so a repo with history stays quiet on the next poll', async () => {
    const repo = 'o/history';
    const listed = [issue(31, T2), issue(30, T2), issue(29, T, { state: 'closed', closed_at: T })];
    const poller: any = new pollerMod.GitHubPollerService('t');
    const emitted: any[] = [];
    poller.emitEvent = (e: any) => emitted.push(e);
    poller.pollIssueTimeline = vi.fn();
    poller.pollIssueComments = vi.fn().mockResolvedValue(0);
    poller.octokit = {
      pulls: { list: vi.fn().mockResolvedValue({ data: [] }) },
      issues: {
        listForRepo: vi.fn().mockResolvedValue({ data: listed }),
        listCommentsForRepo: vi.fn().mockResolvedValue({ data: [{ id: 777 }] }),
        get: vi.fn().mockResolvedValue({ data: {} }),
      },
    };
    const watch = { repo, channelId: 'c', guildId: 'g', events: JSON.stringify(['issues']) };
    await poller.pollRepo(watch);
    const seeded: any = await poller.getSyncState(repo);
    expect(JSON.parse(seeded.metadata)).toMatchObject({
      lastIssueUpdatedAt: T2, issuesAtWatermark: [30, 31], lastIssueCommentId: 777 });
    await poller.pollRepo(watch);
    expect(emitted).toEqual([]);
    // and a genuinely new issue after that still announces
    poller.octokit.issues.listForRepo.mockResolvedValue({ data: [issue(32, '2026-11-13T12:02:00Z'), ...listed] });
    await poller.pollRepo(watch);
    expect(emitted.map((e) => e.data.issueNumber)).toEqual([32]);
  });

  it('seeding pages through a same-second cohort bigger than one page, PRs mixed in', async () => {
    const repo = 'o/cohort';
    const cohort = Array.from({ length: 150 }, (_, i) => issue(1000 - i, T2));
    const prs = Array.from({ length: 20 }, (_, i) => ({ ...issue(2000 + i, T2), pull_request: {} }));
    const all = [...prs, ...cohort, issue(5, T), issue(4, T)];
    const listForRepo = vi.fn(async ({ page }: { page: number }) => ({ data: all.slice((page - 1) * 100, page * 100) }));
    const poller: any = new pollerMod.GitHubPollerService('t');
    const emitted: any[] = [];
    poller.emitEvent = (e: any) => emitted.push(e);
    poller.pollIssueTimeline = vi.fn();
    poller.pollIssueComments = vi.fn().mockResolvedValue(0);
    poller.octokit = {
      pulls: { list: vi.fn().mockResolvedValue({ data: [] }) },
      issues: { listForRepo, listCommentsForRepo: vi.fn().mockResolvedValue({ data: [] }), get: vi.fn() },
    };
    const watch = { repo, channelId: 'c', guildId: 'g', events: JSON.stringify(['issues']) };
    await poller.pollRepo(watch);
    const meta = JSON.parse((await poller.getSyncState(repo)).metadata);
    expect(meta.issuesAtWatermark).toHaveLength(150);
    expect(listForRepo).toHaveBeenCalledTimes(2);
    await poller.pollRepo(watch);
    expect(emitted).toEqual([]);
  });

  it('a row with no watermark and no seed flag is seeded silently, not replayed from 1970', async () => {
    const repo = 'o/unseeded';
    db.getSyncDb().run(`INSERT INTO github_sync_state (repo, metadata) VALUES (?, ?)`, [repo, JSON.stringify({ lastCommitSha: 'x' })]);
    const first = await sweep(repo, [issue(41, T2), issue(40, T)]);
    expect(first.opened).toEqual([]);
    expect(first.meta).toMatchObject({ issueSeeded: true, lastIssueUpdatedAt: T2, issuesAtWatermark: [41] });
  });

  it('legacy watermark (no list yet) does not re-announce the issue that set it', async () => {
    const repo = 'o/legacy';
    db.getSyncDb().run(
      `INSERT INTO github_sync_state (repo, metadata) VALUES (?, ?)`,
      [repo, JSON.stringify({ lastIssueUpdatedAt: T })]
    );
    const r = await sweep(repo, [issue(21, T2), issue(20, T)]);
    expect(r.opened).toEqual([21]);
    expect(r.meta.issuesAtWatermark).toEqual([21]);
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

  it('counts from the open-issue list across pages, skipping PRs, with a day-granular stale cutoff', async () => {
    const fresh = '2026-11-01T00:00:00Z';
    const item = (o: Record<string, unknown>) => ({ assignees: [{ login: 'a' }], labels: [{ name: 'x' }], updated_at: fresh, ...o });
    const page1 = [
      item({ assignees: [] }),
      item({ labels: [] }),
      item({ assignees: [], labels: [] }),
      item({ updated_at: '2026-09-13T23:59:59Z' }), // stale: before the 2026-09-14 cutoff
      item({ updated_at: '2026-09-14T00:00:01Z' }), // not stale
      item({ assignees: [], labels: [], pull_request: {} }), // PR: ignored
      ...Array.from({ length: 94 }, () => item({})),
    ];
    const page2 = [item({ assignees: [] })];
    const listForRepo = vi.fn().mockResolvedValueOnce({ data: page1 }).mockResolvedValueOnce({ data: page2 });
    const octokit: any = { issues: { listForRepo } };
    const counts = await digest.fetchNeedsHumanCounts(octokit, 'o', 'r', new Date('2026-11-13T00:00:00Z'));
    expect(counts).toEqual({ unassigned: 3, unlabeled: 2, stale: 1 });
    expect(listForRepo).toHaveBeenCalledTimes(2);
    expect(listForRepo.mock.calls[0][0]).toMatchObject({ owner: 'o', repo: 'r', state: 'open', per_page: 100, page: 1 });
  });

  it('omits counts when the list errors or the repo is too big to count', async () => {
    const failing: any = { issues: { listForRepo: vi.fn().mockRejectedValue(new Error('rate limited')) } };
    expect(await digest.fetchNeedsHumanCounts(failing, 'o', 'r', new Date())).toBeUndefined();
    const full = Array.from({ length: 100 }, () => ({ assignees: [], labels: [], updated_at: '2026-11-01T00:00:00Z' }));
    const huge: any = { issues: { listForRepo: vi.fn().mockResolvedValue({ data: full }) } };
    expect(await digest.fetchNeedsHumanCounts(huge, 'o', 'r', new Date())).toBeUndefined();
    expect(huge.issues.listForRepo).toHaveBeenCalledTimes(digest.NEEDS_HUMAN_MAX_PAGES);
  });
});
