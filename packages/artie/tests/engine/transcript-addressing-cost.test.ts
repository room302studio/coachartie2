import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../../src/shared/async.js';
import { renderDiscordTranscript, type DiscordHistoryEntry } from '../../src/engine/3-context/sources/transcript.js';
import { combineBurstContent, renderBurstForContext } from '../../src/gateway/3-ask-engine/burst.js';
import { formatLandedNote } from '../../src/gateway/1-receive/channel-activity.js';
import { formatRecentReactionsNote } from '../../src/gateway/1-receive/reaction-log.js';

/**
 * Not an assertion suite — a measurement. Prints the real added-token cost of each
 * multiplayer feature on representative inputs, so MULTIPLAYER-NOTES.md's numbers are
 * something that was actually run, not estimated by eyeballing string lengths. Run with
 * `pnpm -s test transcript-addressing-cost` and read the console output.
 */
describe('multiplayer feature token cost (measured)', () => {
  it('feature 1: a 25-line window of other people with no privileged intents (blank content)', () => {
    // Worst case for feature 1 under non-privileged intents: every OTHER line is a message
    // with no readable content that previously would have been dropped entirely. Half the
    // window replies to someone else, half @-mentions someone else.
    const baseline: DiscordHistoryEntry[] = [];
    const withAddressing: DiscordHistoryEntry[] = [];
    for (let i = 0; i < 25; i++) {
      const author = `User${i}`;
      baseline.push({ author, content: '', timestamp: new Date().toISOString(), isBot: false });
      withAddressing.push(
        i % 2 === 0
          ? {
              author,
              content: '',
              timestamp: new Date().toISOString(),
              isBot: false,
              replyToAuthor: `User${(i + 1) % 25}`,
              addressedElsewhere: true,
            }
          : {
              author,
              content: '',
              timestamp: new Date().toISOString(),
              isBot: false,
              mentions: [`User${(i + 2) % 25}`],
              addressedElsewhere: true,
            }
      );
    }
    const baselineTokens = estimateTokens(renderDiscordTranscript(baseline, 25));
    const withAddressingTokens = estimateTokens(renderDiscordTranscript(withAddressing, 25));
    // Baseline: every line drops (no content, no metadata) -> empty transcript.
    expect(baselineTokens).toBe(0);
    console.log(
      `[cost] feature 1, 25-line all-metadata-no-content window: ${withAddressingTokens} tokens ` +
        `(baseline with these lines dropped entirely: ${baselineTokens})`
    );
    // Sanity bound so a future regression that bloats the format gets caught.
    expect(withAddressingTokens).toBeLessThan(400);
  });

  it('feature 1: suffix overhead on a normal transcript where every line has readable content', () => {
    const withoutMeta: DiscordHistoryEntry[] = [];
    const withMeta: DiscordHistoryEntry[] = [];
    for (let i = 0; i < 25; i++) {
      const author = `User${i}`;
      const content = `this is a normal chat message number ${i} about the game`;
      withoutMeta.push({ author, content, timestamp: new Date().toISOString(), isBot: false });
      withMeta.push({
        author,
        content,
        timestamp: new Date().toISOString(),
        isBot: false,
        replyToAuthor: `User${(i + 1) % 25}`,
        mentions: [`User${(i + 2) % 25}`],
      });
    }
    const without = estimateTokens(renderDiscordTranscript(withoutMeta, 25));
    const withIt = estimateTokens(renderDiscordTranscript(withMeta, 25));
    console.log(`[cost] feature 1, suffix overhead on 25 content-bearing lines: +${withIt - without} tokens`);
    expect(withIt - without).toBeLessThan(300);
  });

  it('feature 2a: burst headline + combined content for a 3-message burst', () => {
    const entries = [
      { messageId: '1', authorLabel: 'Alice', content: 'hey can we push the deploy' },
      { messageId: '2', authorLabel: 'Bob', content: 'yeah lets wait til tomorrow' },
      { messageId: '3', authorLabel: 'Carol', content: 'works for me' },
    ];
    const combined = combineBurstContent(entries);
    const combinedTokens = estimateTokens(combined);
    console.log(`[cost] feature 2a: combined 3-message burst content = ${combinedTokens} tokens`);
    expect(renderBurstForContext(entries)).toHaveLength(3);
    expect(combinedTokens).toBeLessThan(80);
  });

  it('feature 2b: landed-while-thinking note for 3 landed messages', () => {
    const note = formatLandedNote([
      { messageId: 'm1', authorLabel: 'Dave', content: 'nevermind figured it out', ts: 0 },
      { messageId: 'm2', authorLabel: 'Erin', content: 'lol', ts: 1 },
      { messageId: 'm3', authorLabel: 'Frank', content: '', ts: 2 },
    ])!;
    const tokens = estimateTokens(note);
    console.log(`[cost] feature 2b: landed note (3 messages) = ${tokens} tokens`);
    expect(tokens).toBeLessThan(80);
  });

  it('feature 3: recent-reactions note for 5 reactions', () => {
    const reactions = Array.from({ length: 5 }, (_, i) => ({
      messageId: `m${i}`,
      channelId: 'c1',
      emoji: i % 2 === 0 ? '👍' : '👎',
      userLabel: `User${i}`,
      messageExcerpt: 'here is my take on the plan for next week',
      at: i * 60000,
    }));
    const note = formatRecentReactionsNote(reactions, 10 * 60000)!;
    const tokens = estimateTokens(note);
    console.log(`[cost] feature 3: recent-reactions note (5 reactions, capped) = ${tokens} tokens`);
    expect(tokens).toBeLessThan(120);
  });
});
