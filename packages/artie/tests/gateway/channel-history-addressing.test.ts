import { describe, it, expect } from 'vitest';
import { Collection } from 'discord.js';
import { resolveAddressing } from '../../src/gateway/1-receive/channel-history.js';

const BOT_ID = 'bot-1';

/** Minimal discord.js Message stand-in: only the fields resolveAddressing reads. */
function fakeMessage(opts: {
  authorId: string;
  authorName: string;
  content?: string;
  cleanContent?: string;
  referenceId?: string;
  repliedUserId?: string;
  repliedUserName?: string;
  mentionedUserIds?: Array<{ id: string; name: string }>;
}): any {
  const mentionedUsers = new Collection<string, any>();
  for (const m of opts.mentionedUserIds ?? []) {
    mentionedUsers.set(m.id, { id: m.id, displayName: m.name, username: m.name });
  }
  let reference: { messageId: string } | null;
  if (opts.referenceId) {
    reference = { messageId: opts.referenceId };
  } else {
    reference = null;
  }

  let repliedUser: { id: string; displayName: string; username: string } | null;
  if (opts.repliedUserId) {
    repliedUser = { id: opts.repliedUserId, displayName: opts.repliedUserName, username: opts.repliedUserName };
  } else {
    repliedUser = null;
  }

  return {
    id: `msg-${opts.authorId}-${Math.random()}`,
    author: { id: opts.authorId, displayName: opts.authorName, username: opts.authorName },
    content: opts.content ?? '',
    cleanContent: opts.cleanContent,
    reference,
    mentions: {
      repliedUser,
      users: mentionedUsers,
      has: (id: string) =>
        mentionedUsers.has(id) || (opts.repliedUserId === id && id === BOT_ID),
    },
  };
}

describe('resolveAddressing', () => {
  it('reply to Artie carries an excerpt when the target is in the window', () => {
    const botMsg = fakeMessage({
      authorId: BOT_ID,
      authorName: 'Coach Artie',
      content: 'here is the plan for tonight',
    });
    const window = new Collection<string, any>([[botMsg.id, botMsg]]);
    const reply = fakeMessage({
      authorId: 'u1',
      authorName: 'Alice',
      referenceId: botMsg.id,
      repliedUserId: BOT_ID,
    });

    const out = resolveAddressing(reply, window, BOT_ID);
    expect(out.replyToAuthor).toBe('Coach Artie');
    expect(out.replyToIsSelf).toBe(true);
    expect(out.replyToExcerpt).toContain('plan for tonight');
    expect(out.addressedElsewhere).toBeUndefined();
  });

  it('reply to someone other than Artie, with no content available, is still attributable', () => {
    const otherMsg = fakeMessage({ authorId: 'u2', authorName: 'Bob' });
    const window = new Collection<string, any>([[otherMsg.id, otherMsg]]);
    const reply = fakeMessage({
      authorId: 'u1',
      authorName: 'Alice',
      referenceId: otherMsg.id,
      repliedUserId: 'u2',
      repliedUserName: 'Bob',
    });

    const out = resolveAddressing(reply, window, BOT_ID);
    expect(out.replyToAuthor).toBe('Bob');
    expect(out.replyToIsSelf).toBe(false);
    expect(out.replyToExcerpt).toBeUndefined();
    expect(out.addressedElsewhere).toBe(true);
  });

  it('reply target outside the fetched window still resolves from mentions.repliedUser', () => {
    const window = new Collection<string, any>(); // empty — target not prefetched
    const reply = fakeMessage({
      authorId: 'u1',
      authorName: 'Alice',
      referenceId: 'some-old-message-id',
      repliedUserId: 'u2',
      repliedUserName: 'Bob',
    });

    const out = resolveAddressing(reply, window, BOT_ID);
    expect(out.replyToAuthor).toBe('Bob');
    expect(out.addressedElsewhere).toBe(true);
  });

  it('@-mentioning someone other than Artie flags addressedElsewhere', () => {
    const window = new Collection<string, any>();
    const msg = fakeMessage({
      authorId: 'u1',
      authorName: 'Alice',
      mentionedUserIds: [{ id: 'u2', name: 'Bob' }],
    });

    const out = resolveAddressing(msg, window, BOT_ID);
    expect(out.mentions).toEqual(['Bob']);
    expect(out.addressedElsewhere).toBe(true);
  });

  it('a line that also mentions Artie is not flagged addressedElsewhere', () => {
    const window = new Collection<string, any>();
    const msg = fakeMessage({
      authorId: 'u1',
      authorName: 'Alice',
      mentionedUserIds: [
        { id: 'u2', name: 'Bob' },
        { id: BOT_ID, name: 'Coach Artie' },
      ],
    });

    const out = resolveAddressing(msg, window, BOT_ID);
    // Artie himself is excluded from the rendered mentions list
    expect(out.mentions).toEqual(['Bob']);
    expect(out.addressedElsewhere).toBeUndefined();
  });

  it('a reply-with-ping does not duplicate the target into the mentions list', () => {
    const otherMsg = fakeMessage({ authorId: 'u2', authorName: 'Bob' });
    const window = new Collection<string, any>([[otherMsg.id, otherMsg]]);
    const reply = fakeMessage({
      authorId: 'u1',
      authorName: 'Alice',
      referenceId: otherMsg.id,
      repliedUserId: 'u2',
      repliedUserName: 'Bob',
      mentionedUserIds: [{ id: 'u2', name: 'Bob' }], // reply-with-ping fills both fields
    });

    const out = resolveAddressing(reply, window, BOT_ID);
    expect(out.replyToAuthor).toBe('Bob');
    expect(out.mentions).toBeUndefined();
  });

  it('plain message with no reply and no mentions resolves to an empty object', () => {
    const window = new Collection<string, any>();
    const msg = fakeMessage({ authorId: 'u1', authorName: 'Alice', content: 'hey all' });
    expect(resolveAddressing(msg, window, BOT_ID)).toEqual({});
  });
});
