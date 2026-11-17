/**
 * Dense GitHub cards + meeting issue callouts (EJ 2026-11-17: "like tufte, any text shown
 * should contain data, no duplication").
 */
import { describe, it, expect } from 'vitest';
import { GitHubDiscordPoster } from '../../src/gateway/watchers/github/poster.js';
import { capped, digestTitle, shortTitle } from '../../src/gateway/watchers/github/studio-digest.js';
import { extractIssueRefs, calloutEmbed } from '../../src/gateway/voice/scribe-issue-callouts.js';

const poster = new GitHubDiscordPoster({} as any);
const card = (event: any, gist: string | null = null) => (poster as any).createEmbed(event, gist).data;

const merged = {
  type: 'pr_merged',
  repo: 'Subway-Builder/metro-maker4',
  channelId: 'c',
  guildId: 'g',
  timestamp: '2026-11-17T14:11:00Z',
  data: {
    prNumber: 1499,
    prTitle: '1.7.33 feedback fixes: #1491–#1498, city downloads on QUIC-broken networks',
    prUrl: 'https://github.com/Subway-Builder/metro-maker4/pull/1499',
    prAuthor: 'ejfox',
    mergedBy: 'ejfox',
    prBaseBranch: 'beta',
    additions: 412,
    deletions: 88,
    changedFiles: 14,
    prBody: 'Fixes eight feedback issues and falls back from QUIC to TCP for city downloads.',
  },
};

describe('dense PR/issue cards', () => {
  it('merged PR: #N gist title, one facts line, repo footer, no emoji or "By" restated', () => {
    const d = card(merged, 'City downloads fall back to TCP; 8 feedback fixes (#1491–98)');
    expect(d.title).toBe('#1499 City downloads fall back to TCP; 8 feedback fixes (#1491–98)');
    expect(d.description).toBe('merged → beta, live · +412 −88 · 14 files · ejfox');
    expect(d.footer.text).toBe('Subway-Builder/metro-maker4');
    expect(d.title).not.toMatch(/🚀|Shipped/);
    expect(d.description).not.toContain('By ');
  });

  it('falls back to the PR title when there is no gist', () => {
    expect(card(merged).title).toBe(`#1499 ${merged.data.prTitle}`);
  });

  it('names a different merger once, in the facts line', () => {
    const d = card({ ...merged, data: { ...merged.data, mergedBy: 'colin' } });
    expect(d.description).toContain('ejfox, merged by colin');
  });

  it('issue opened: facts line carries author and labels, no body dump', () => {
    const d = card({
      type: 'issue_opened',
      repo: 'Subway-Builder/metro-maker4',
      timestamp: '2026-11-17T14:27:00Z',
      data: {
        issueNumber: 1502,
        issueTitle: 'Tunnels follow terrain',
        issueUrl: 'not-a-url',
        issueAuthor: 'ejfox',
        issueLabels: ['bug', 'tracks'],
        issueBody: 'long body '.repeat(50),
      },
    });
    expect(d.title).toBe('#1502 Tunnels follow terrain');
    expect(d.description).toBe('new issue · ejfox · bug, tracks');
  });

  it('only asks the model when there is a body worth distilling', () => {
    expect(poster.gistRequestFor({ ...merged, data: { ...merged.data, prBody: '' } } as any)).toBeNull();
    const key = poster.gistRequestFor(merged as any)?.key || '';
    expect(key.startsWith('Subway-Builder/metro-maker4#1499:pr:')).toBe(true);
    // An edited body gets a fresh gist instead of the cached stale one.
    const edited = poster.gistRequestFor({ ...merged, data: { ...merged.data, prBody: `${merged.data.prBody} Also fixes tunnels.` } } as any);
    expect(edited?.key).not.toBe(key);
    const shortComment = { type: 'issue_comment', repo: 'r', data: { issueNumber: 1, commentBody: 'lgtm' } };
    expect(poster.gistRequestFor(shortComment as any)).toBeNull();
  });
});

describe('dense standup digest', () => {
  it('puts the counts in the title', () => {
    expect(
      digestTitle({
        repo: 'Subway-Builder/metro-maker4',
        recentMerges: [1, 2, 3],
        prsNeedingReview: [1],
        stalePrs: [],
        openIssues: { total: 42 },
      })
    ).toBe('metro-maker4 · 3 merged · 1 awaiting review · 42 open issues');
  });

  it('caps a list with one "+N more" link instead of cutting mid-list', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`);
    const out = capped(lines, 5, 'https://x');
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

  it('caps label lists so the card stays valid', () => {
    const d = calloutEmbed('r/x', {
      number: 12,
      title: 't',
      state: 'open',
      url: 'https://github.com/r/x/issues/12',
      labels: Array.from({ length: 80 }, (_, i) => `label-${i}-${'z'.repeat(40)}`),
      assignees: [],
      comments: 0,
    }).data;
    expect(d.description!.length).toBeLessThanOrEqual(1000);
    expect(d.description).toContain('+76');
  });

  it('dedupes within an utterance and caps at three', () => {
    expect(extractIssueRefs('issue 12, issue 12, #13, #14, #15')).toEqual([12, 13, 14]);
  });

  it('renders the same dense card shape', () => {
    const d = calloutEmbed('Subway-Builder/metro-maker4', {
      number: 1502,
      title: 'Tunnels follow terrain',
      state: 'open',
      url: 'https://github.com/Subway-Builder/metro-maker4/issues/1502',
      labels: ['bug'],
      assignees: [],
      comments: 2,
    }).data;
    expect(d.title).toBe('#1502 Tunnels follow terrain');
    expect(d.description).toBe('issue open · unassigned · 2 comments · bug');
  });
});
