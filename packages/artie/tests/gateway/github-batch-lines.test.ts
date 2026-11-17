/**
 * 2026-11-17: a "4 new issues opened by ejfox" card listed "📋 issue_opened" four times,
 * because batch lines only knew comments, reviews and CI. Every line must carry its data.
 */
import { describe, it, expect } from 'vitest';
import { GitHubDiscordPoster } from '../../src/gateway/watchers/github/poster.js';

function issue(n: number, title: string) {
  return {
    event: {
      type: 'issue_opened',
      repo: 'Subway-Builder/metro-maker4',
      channelId: 'c',
      guildId: 'g',
      timestamp: '2026-11-17T14:27:00Z',
      data: {
        issueNumber: n,
        issueTitle: title,
        issueUrl: `https://github.com/Subway-Builder/metro-maker4/issues/${n}`,
        issueAuthor: 'ejfox',
      },
    },
    shouldPost: true,
    mentions: [],
    priority: 1,
  };
}

describe('GitHub batch embed lines', () => {
  it('lists each issue by number and title, never the raw event type', () => {
    const poster = new GitHubDiscordPoster({} as any);
    const embed = (poster as any).createBatchEmbed({
      batchKey: 'k',
      events: [issue(1502, 'Tunnel ignores ground snap'), issue(1503, 'QUIC fallback for city downloads')],
      summary: '2 new issues opened by ejfox',
      channelId: 'c',
      guildId: 'g',
    });
    const text: string = embed.data.description;
    expect(text).not.toContain('issue_opened');
    expect(text).toContain('[#1502](https://github.com/Subway-Builder/metro-maker4/issues/1502) Tunnel ignores ground snap');
    expect(text).toContain('#1503');
  });

  it('falls back to a humanized line for event types without a case', () => {
    const poster = new GitHubDiscordPoster({} as any);
    const line: string = (poster as any).getShortEventSummary({
      type: 'issue_reopened',
      data: { issueNumber: 7, issueTitle: 'Back' },
    });
    expect(line).toBe('#7 Back (issue reopened)');
  });
});
