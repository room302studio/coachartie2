import { describe, it, expect } from 'vitest';
import {
  formatAddressingSuffix,
  renderDiscordTranscript,
  type DiscordHistoryEntry,
} from '../../../../src/engine/3-context/sources/transcript.js';

function entry(overrides: Partial<DiscordHistoryEntry>): DiscordHistoryEntry {
  return {
    author: 'Alice',
    content: '',
    timestamp: new Date().toISOString(),
    isBot: false,
    ...overrides,
  };
}

describe('formatAddressingSuffix', () => {
  it('is empty for a plain line', () => {
    expect(formatAddressingSuffix({})).toBe('');
  });

  it('shows a reply-to-Artie excerpt', () => {
    expect(
      formatAddressingSuffix({ replyToAuthor: 'Coach Artie', replyToIsSelf: true, replyToExcerpt: 'the plan' })
    ).toBe(' [↳you ("the plan")]');
  });

  it('shows a reply to someone else', () => {
    expect(formatAddressingSuffix({ replyToAuthor: 'Bob', replyToIsSelf: false })).toBe(' [↳@Bob]');
  });

  it('shows mentions', () => {
    expect(formatAddressingSuffix({ mentions: ['Bob', 'Carol'] })).toBe(' [→@Bob,@Carol]');
  });

  it('flags addressed-elsewhere', () => {
    expect(
      formatAddressingSuffix({ replyToAuthor: 'Bob', addressedElsewhere: true })
    ).toBe(' [↳@Bob (not to you)]');
  });
});

describe('renderDiscordTranscript — addressing metadata', () => {
  it('keeps a content-empty line that carries reply/mention metadata', () => {
    const history: DiscordHistoryEntry[] = [
      entry({ author: 'Alice', content: '', replyToAuthor: 'Bob', addressedElsewhere: true }),
    ];
    const out = renderDiscordTranscript(history, 10);
    expect(out).toContain('Alice [↳@Bob (not to you)]: [no text]');
  });

  it('still drops a line with neither content nor metadata', () => {
    const history: DiscordHistoryEntry[] = [entry({ author: 'Alice', content: '' })];
    expect(renderDiscordTranscript(history, 10)).toBe('');
  });

  it('renders a reply-to-Artie line with the excerpt even when content is present', () => {
    const history: DiscordHistoryEntry[] = [
      entry({
        author: 'Alice',
        content: 'sounds good',
        replyToAuthor: 'Coach Artie',
        replyToIsSelf: true,
        replyToExcerpt: 'want me to ship it?',
      }),
    ];
    const out = renderDiscordTranscript(history, 10);
    expect(out).toBe('Alice [↳you ("want me to ship it?")]: sounds good');
  });

  it('Artie-authored lines never carry the addressed-elsewhere flag', () => {
    const history: DiscordHistoryEntry[] = [
      entry({ author: 'Coach Artie', content: 'hey', isSelf: true, isBot: true }),
    ];
    expect(renderDiscordTranscript(history, 10)).toBe('Coach Artie (you): hey');
  });
});
