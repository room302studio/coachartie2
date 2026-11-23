/**
 * GitHub cards (src/gateway/watchers/github/cards.ts), the dense standup digest, and meeting
 * issue callouts. EJ 2026-11-17: "like tufte, any text shown should contain data, no
 * duplication". The every-type fixture at the bottom is the regression net for the
 * 4× "issue_opened" card.
 */
import { describe, it, expect } from 'vitest';
import {
  batchLine,
  batchTitle,
  cardToEmbed,
  headlineRequestFor,
  isLinkable,
  renderBatchCard,
  renderCard,
} from '../../src/gateway/watchers/github/cards.js';
import type { GitHubEventType, GitHubSyncEvent } from '../../src/gateway/watchers/github/poller.js';
import type { ProcessedEvent } from '../../src/gateway/watchers/github/event-batcher.js';
import { capped, digestTitle, shortTitle } from '../../src/gateway/watchers/github/studio-digest.js';
import { extractIssueRefs, calloutEmbed } from '../../src/gateway/voice/scribe-issue-callouts.js';

const REPO = 'Subway-Builder/metro-maker4';
const GH = `https://github.com/${REPO}`;

function event(type: GitHubEventType, data: GitHubSyncEvent['data']): GitHubSyncEvent {
  return { type, repo: REPO, channelId: 'c', guildId: 'g', timestamp: '2026-11-17T14:11:00Z', data };
}

function processed(e: GitHubSyncEvent, priority = 1): ProcessedEvent {
  return { event: e, shouldPost: true, mentions: [], priority };
}

const merged = event('pr_merged', {
  prNumber: 1499,
  prTitle: '1.7.33 feedback fixes: #1491–#1498, city downloads on QUIC-broken networks',
  prUrl: `${GH}/pull/1499`,
  prAuthor: 'ejfox',
  mergedBy: 'ejfox',
  prBaseBranch: 'beta',
  additions: 412,
  deletions: 88,
  changedFiles: 14,
  prBody: 'Fixes eight feedback issues and falls back from QUIC to TCP for city downloads.',
});

describe('single-event cards', () => {
  it('merged PR: #N headline title, one facts line, repo footer, no emoji or "By" restated', () => {
    const card = renderCard(merged, 'City downloads fall back to TCP; 8 feedback fixes (#1491–98)');
    expect(card.title).toBe('#1499 City downloads fall back to TCP; 8 feedback fixes (#1491–98)');
    expect(card.description).toBe('merged → beta, live · +412 −88 · 14 files · ejfox');
    expect(card.footer).toBe(REPO);
    expect(card.title).not.toMatch(/🚀|Shipped/);
  });

  it('falls back to the PR title when there is no headline', () => {
    expect(renderCard(merged).title).toBe(`#1499 ${merged.data.prTitle}`);
  });

  it('names a different merger once, in the facts line', () => {
    const card = renderCard({ ...merged, data: { ...merged.data, mergedBy: 'colin' } });
    expect(card.description).toContain('ejfox, merged by colin');
  });

  it('issue opened: author and labels in the facts line, no body dump', () => {
    const card = renderCard(
      event('issue_opened', {
        issueNumber: 1502,
        issueTitle: 'Tunnels follow terrain',
        issueUrl: 'not-a-url',
        issueAuthor: 'ejfox',
        issueLabels: ['bug', 'tracks'],
        issueBody: 'long body '.repeat(50),
      })
    );
    expect(card.title).toBe('#1502 Tunnels follow terrain');
    expect(card.description).toBe('new issue · ejfox · bug, tracks');
  });

  it('push: commit lines with sha links, capped', () => {
    const commits = Array.from({ length: 7 }, (_, i) => ({ sha: `abc${i}`, message: `fix ${i}`, author: 'ejfox', url: `${GH}/commit/abc${i}` }));
    const card = renderCard(event('push', { commitCount: 7, branch: 'beta', commits }));
    expect(card.title).toBe('7 commits → beta');
    expect(card.description).toContain('[`abc0`]');
    expect(card.description).toContain('+2 more');
  });

  it('cardToEmbed drops a bad URL instead of throwing (which would drop the post)', () => {
    expect(() => cardToEmbed({ title: 't', url: 'https://', footer: 'r', color: 0 })).not.toThrow();
    expect(isLinkable('https://')).toBe(false);
    expect(isLinkable(`${GH}/issues/1`)).toBe(true);
  });
});

describe('headline requests', () => {
  it('only asks the model when there is a body worth distilling', () => {
    expect(headlineRequestFor({ ...merged, data: { ...merged.data, prBody: '' } })).toBeNull();
    const key = headlineRequestFor(merged)?.key || '';
    expect(key.startsWith(`${REPO}#1499:pr:`)).toBe(true);
    const shortComment = event('issue_comment', { issueNumber: 1, commentBody: 'lgtm' });
    expect(headlineRequestFor(shortComment)).toBeNull();
  });

  it('an edited body gets a fresh key instead of a cached stale headline', () => {
    const edited = { ...merged, data: { ...merged.data, prBody: `${merged.data.prBody} Also fixes tunnels.` } };
    expect(headlineRequestFor(edited)?.key).not.toBe(headlineRequestFor(merged)?.key);
  });
});

describe('batch cards', () => {
  const issues = [1502, 1503].map((n) =>
    processed(event('issue_opened', { issueNumber: n, issueTitle: `Issue ${n}`, issueUrl: `${GH}/issues/${n}`, issueAuthor: 'ejfox' }))
  );

  it('lists each issue by number and title (never the raw event type)', () => {
    const card = renderBatchCard(issues);
    expect(card.title).toBe('2 new issues · ejfox');
    expect(card.description).toContain(`[#1502](${GH}/issues/1502) Issue 1502`);
    expect(card.description).not.toContain('issue_opened');
  });

  it('uses headlines for the lines when given, and "+N more" past the cap', () => {
    const many = Array.from({ length: 7 }, (_, i) => issues[i % 2]);
    const card = renderBatchCard(many, ['Tunnel snap ignored on slopes']);
    expect(card.description).toContain('Tunnel snap ignored on slopes');
    expect(card.description).toContain('+2 more');
  });

  it('CI batches count passes and failures', () => {
    const ci = [
      processed(event('ci_success', { checkRunName: 'build' })),
      processed(event('ci_failure', { checkRunName: 'test' })),
    ];
    expect(batchTitle(ci)).toBe('CI: 1 passed, 1 failed');
  });

  it('review batches name the PR once, in the title (Codex: the subject was lost)', () => {
    const reviews = [
      processed(event('pr_approved', { prNumber: 1499, prTitle: 'City downloads on QUIC', reviewAuthor: 'alex' })),
      processed(event('pr_changes_requested', { prNumber: 1499, prTitle: 'City downloads on QUIC', reviewAuthor: 'colin' })),
    ];
    expect(batchTitle(reviews)).toBe('#1499 City downloads on QUIC: 1 approved, 1 requested changes');
  });
});

describe('every event type renders data, never a raw type', () => {
  const ALL: GitHubEventType[] = [
    'pr_opened', 'pr_ready_for_review', 'pr_merged', 'pr_closed', 'pr_approved', 'pr_changes_requested',
    'pr_comment', 'pr_review', 'ci_success', 'ci_failure', 'issue_opened', 'issue_closed', 'issue_comment',
    'issue_labeled', 'issue_assigned', 'pr_review_requested', 'pr_draft', 'push',
  ];
  const data: GitHubSyncEvent['data'] = {
    prNumber: 7, prTitle: 'PR seven', prUrl: `${GH}/pull/7`, prAuthor: 'ejfox', prBaseBranch: 'main',
    issueNumber: 8, issueTitle: 'Issue eight', issueUrl: `${GH}/issues/8`, issueAuthor: 'colin',
    commentAuthor: 'hudson', commentBody: 'looks good', reviewAuthor: 'alex', reviewState: 'COMMENTED',
    checkRunName: 'build', label: 'bug', assignee: 'ejfox', assignedBy: 'colin', reviewers: ['alex'],
    commitCount: 1, branch: 'main', commits: [{ sha: 'abc', message: 'm', author: 'ejfox', url: `${GH}/commit/abc` }],
  };

  for (const type of ALL) {
    it(type, () => {
      const card = renderCard(event(type, data));
      const text = `${card.title}\n${card.description || ''}`;
      expect(card.title.length).toBeGreaterThan(0);
      expect(text).not.toContain(type);
      // 🏷️ and ⬆️ carry a variation selector, so they are alternatives, not class members
      // (inside [...] the bare selector matched on its own).
      expect(text).not.toMatch(/[🆕👀🎉❌✅🔄💬📝📋👤🚀]|🏷️|⬆️|🏷|⬆/u);
      expect(batchLine(event(type, data))).not.toContain(type);
    });
  }
});

describe('dense standup digest', () => {
  it('puts the counts in the title', () => {
    expect(
      digestTitle({ repo: REPO, recentMerges: [1, 2, 3], prsNeedingReview: [1], stalePrs: [], openIssues: { total: 42 } })
    ).toBe('metro-maker4 · 3 merged · 1 awaiting review · 42 open issues');
  });

  it('caps a list with one "+N more" link instead of cutting mid-list', () => {
    const out = capped(Array.from({ length: 12 }, (_, i) => `line ${i}`), 5, 'https://x');
    expect(out).toHaveLength(6);
    expect(out[5]).toBe('[+7 more](https://x)');
    expect(capped(['a'], 5, 'x')).toEqual(['a']);
  });

  it('shortens long titles with an ellipsis', () => {
    expect(shortTitle('x'.repeat(100))).toHaveLength(72);
  });
});

describe('meeting issue callouts', () => {
  it('finds spoken and written issue numbers', () => {
    expect(extractIssueRefs('can we look at issue 1502 and PR 1499?')).toEqual([1502, 1499]);
    expect(extractIssueRefs('Issue number 88 is the tunnel thing')).toEqual([88]);
    expect(extractIssueRefs('that was #1503, right')).toEqual([1503]);
    expect(extractIssueRefs('pull request 1501 merged')).toEqual([1501]);
    expect(extractIssueRefs('see #1502,#1503/#1504')).toEqual([1502, 1503, 1504]);
  });

  it('ignores ordinary numbers and single digits', () => {
    expect(extractIssueRefs('we have 1500 issues and 30 minutes')).toEqual([]);
    expect(extractIssueRefs('issue 1 is fine')).toEqual([]);
    expect(extractIssueRefs('please request 30 minutes')).toEqual([]);
  });

  it('dedupes within an utterance and caps at three', () => {
    expect(extractIssueRefs('issue 12, issue 12, #13, #14, #15')).toEqual([12, 13, 14]);
  });

  it('renders the same dense card shape, with labels capped', () => {
    const d = calloutEmbed(REPO, {
      number: 1502,
      title: 'Tunnels follow terrain',
      state: 'open',
      url: `${GH}/issues/1502`,
      labels: Array.from({ length: 80 }, (_, i) => `label-${i}`),
      assignees: [],
      comments: 2,
    }).data;
    expect(d.title).toBe('#1502 Tunnels follow terrain');
    expect(d.description).toBe('issue open · unassigned · 2 comments · label-0, label-1, label-2, label-3 +76');
  });
});
