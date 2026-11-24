import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/shared/blocklist.js', () => ({
  scrubBlockedUserMentions: (text: string) => text.replace(/<@!?700000000000000002>/g, 'the banned one'),
  isBlockedUser: (id: string) => id === '700000000000000002',
}));
import {
  createThread,
  createForumPost,
  editOwnMessage,
  deleteOwnMessage,
  setPinned,
  endOwnPoll,
  readPollInGuild,
  POST_GUILD_IDS,
} from '../../../src/gateway/routes/discord-write.js';

const ROOM302 = [...POST_GUILD_IDS][0];
const OTHER = '100000000000000009';
const ARTIE = '400000000000000001';
const HERE = '200000000000000001';
const ELSEWHERE = '200000000000000002';
const FORUM = '200000000000000003';
const FOREIGN = '200000000000000004';

const MEMBER_HERE = { askerId: '300000000000000009', fromChannelId: HERE, askerIsOwner: false };
const OWNER_ASKS = { askerId: '300000000000000001', fromChannelId: HERE, askerIsOwner: true };

/** Message ...001 is Artie's own; every other message is someone else's. */
function authorOf(messageId: string): string {
  if (messageId === '600000000000000001') {
    return ARTIE;
  }
  return '300000000000000001';
}

/** messages.fetch takes an id or { message: id, force } (a forced poll read). */
function idOf(arg: string | { message: string }): string {
  if (typeof arg === 'string') {
    return arg;
  }
  return arg.message;
}

function fakeClient(guildId: string) {
  const sent: any[] = [];
  const edits: any[] = [];
  const thread = { id: '500000000000000001', name: 't', send: vi.fn(async (m: any) => sent.push(m)) };
  const text = (id: string) => ({
    id,
    guildId,
    type: 0,
    isThread: () => false,
    isDMBased: () => false,
    isTextBased: () => true,
    threads: { create: vi.fn(async () => thread) },
    messages: {
      fetch: vi.fn(async (arg: string | { message: string }) => messageOf(idOf(arg))),
    },
  });
  const messageOf = (mid: string) => ({
    id: mid,
    author: { id: authorOf(mid) },
    pinned: false,
    poll: pollOf(mid),
    edit: vi.fn(async (m: any) => edits.push(m)),
    delete: vi.fn(async () => acts.push(`delete ${mid}`)),
    pin: vi.fn(async () => acts.push(`pin ${mid}`)),
    unpin: vi.fn(async () => acts.push(`unpin ${mid}`)),
    startThread: vi.fn(async () => thread),
  });
  /** Messages ...001 (Artie's) and ...002 (someone's) carry a poll with two voters on "Yes". */
  const pollOf = (mid: string) => {
    if (mid !== '600000000000000001' && mid !== '600000000000000002') {
      return null;
    }
    const voters = new Map([
      ['700000000000000001', { id: '700000000000000001', username: 'fan', globalName: 'Fan' }],
      ['700000000000000002', { id: '700000000000000002', username: 'banned', globalName: null }],
    ]);
    return {
      question: { text: 'Ship it?' },
      allowMultiselect: true,
      resultsFinalized: false,
      expiresAt: null,
      end: vi.fn(async () => acts.push(`end ${mid}`)),
      answers: new Map([
        [1, { partial: false, text: 'Yes', voteCount: 2, voters: { fetch: vi.fn(async () => voters) } }],
        [2, { partial: false, text: 'No', voteCount: 0, voters: { fetch: vi.fn(async () => new Map()) } }],
      ]),
    };
  };
  const acts: string[] = [];
  const channels: Record<string, any> = {
    [HERE]: text(HERE),
    [ELSEWHERE]: text(ELSEWHERE),
    [FORUM]: {
      id: FORUM,
      guildId,
      type: 15,
      isDMBased: () => false,
      isTextBased: () => false,
      flags: { has: () => false },
      availableTags: [],
      threads: { create: vi.fn(async (o: any) => (sent.push(o.message), thread)) },
    },
    [FOREIGN]: { ...text(FOREIGN), guildId: '100000000000000777' },
  };
  const client = {
    user: { id: ARTIE },
    channels: {
      fetch: vi.fn(async (id: string) => {
        if (!channels[id]) {
          throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
        }
        return channels[id];
      }),
    },
  } as any;
  return { client, sent, edits, acts };
}

describe('discord writes', () => {
  it('starts a thread in the conversation channel anywhere, never pinging', async () => {
    const { client, sent } = fakeClient(OTHER);
    const r = await createThread(client, OTHER, HERE, { name: 'notes', message: '@everyone hi' });
    expect(r.status).toBe(200);
    expect(sent[0].allowedMentions).toEqual({ parse: [] });
  });

  it('elsewhere only in Room 302', async () => {
    const other = fakeClient(OTHER);
    expect((await createThread(other.client, OTHER, HERE, { name: 'x', channelId: ELSEWHERE })).status).toBe(403);
    const room = fakeClient(ROOM302);
    expect((await createThread(room.client, ROOM302, HERE, { name: 'x', channelId: ELSEWHERE })).status).toBe(200);
  });

  it('never reaches a channel in another server', async () => {
    const room = fakeClient(ROOM302);
    expect((await createThread(room.client, ROOM302, HERE, { name: 'x', channelId: FOREIGN })).status).toBe(404);
    expect((await editOwnMessage(room.client, ROOM302, OWNER_ASKS, { channelId: FOREIGN, messageId: '600000000000000001', message: 'y' })).status).toBe(404);
  });

  it('forum posts only in Room 302, without pings', async () => {
    const other = fakeClient(OTHER);
    expect((await createForumPost(other.client, OTHER, { forumId: FORUM, title: 't', message: 'm' })).status).toBe(403);
    const room = fakeClient(ROOM302);
    expect((await createForumPost(room.client, ROOM302, { forumId: FORUM, title: 't', message: 'm' })).status).toBe(200);
    expect(room.sent[0].allowedMentions).toEqual({ parse: [] });
  });

  it('edits only his own messages, without pings', async () => {
    const { client, edits } = fakeClient(OTHER);
    expect((await editOwnMessage(client, OTHER, MEMBER_HERE, { channelId: HERE, messageId: '600000000000000002', message: 'y' })).status).toBe(403);
    expect((await editOwnMessage(client, OTHER, MEMBER_HERE, { channelId: HERE, messageId: '600000000000000001', message: 'y' })).status).toBe(200);
    expect(edits[0]).toEqual({ content: 'y', allowedMentions: { parse: [] } });
    expect((await editOwnMessage(client, OTHER, MEMBER_HERE, { channelId: HERE, messageId: '', message: 'y' })).status).toBe(400);
  });

  it('refuses text over 2000 characters instead of cutting it; 2000 exactly is fine', async () => {
    const { client, edits } = fakeClient(OTHER);
    const at = (message: string) => ({ channelId: HERE, messageId: '600000000000000001', message });
    expect((await editOwnMessage(client, OTHER, MEMBER_HERE, at('x'.repeat(2001)))).status).toBe(400);
    expect((await editOwnMessage(client, OTHER, MEMBER_HERE, at('x'.repeat(2000)))).status).toBe(200);
    expect(edits[0].content).toHaveLength(2000);
    expect((await createThread(client, OTHER, HERE, { name: 'n', message: 'x'.repeat(2001) })).status).toBe(400);
  });

  it('scrubs banned people from what he writes, like his normal replies', async () => {
    const { client, edits } = fakeClient(OTHER);
    const r = await editOwnMessage(client, OTHER, MEMBER_HERE, {
      channelId: HERE,
      messageId: '600000000000000001',
      message: 'ask <@700000000000000002> about it',
    });
    expect(r.status).toBe(200);
    expect(edits[0].content).toBe('ask the banned one about it');
  });

  it('a member can only have him edit in the channel they are talking in; EJ anywhere', async () => {
    const { client } = fakeClient(OTHER);
    const there = { channelId: ELSEWHERE, messageId: '600000000000000001', message: 'y' };
    expect((await editOwnMessage(client, OTHER, MEMBER_HERE, there)).status).toBe(403);
    expect((await editOwnMessage(client, OTHER, OWNER_ASKS, there)).status).toBe(200);
  });

  it('deletes only his own messages, here unless EJ, never in another server', async () => {
    const { client, acts } = fakeClient(OTHER);
    const mine = { channelId: HERE, messageId: '600000000000000001' };
    expect((await deleteOwnMessage(client, OTHER, MEMBER_HERE, { channelId: HERE, messageId: '600000000000000002' })).status).toBe(403);
    expect((await deleteOwnMessage(client, OTHER, MEMBER_HERE, { ...mine, channelId: ELSEWHERE })).status).toBe(403);
    expect((await deleteOwnMessage(client, OTHER, OWNER_ASKS, { ...mine, channelId: FOREIGN })).status).toBe(404);
    expect((await deleteOwnMessage(client, OTHER, MEMBER_HERE, mine)).status).toBe(200);
    expect(acts).toEqual(['delete 600000000000000001']);
  });

  it("pins anyone's message in this channel, and unpins", async () => {
    const { client, acts } = fakeClient(OTHER);
    const theirs = { channelId: HERE, messageId: '600000000000000002' };
    expect((await setPinned(client, OTHER, MEMBER_HERE, theirs, true)).status).toBe(200);
    expect((await setPinned(client, OTHER, MEMBER_HERE, { ...theirs, channelId: ELSEWHERE }, true)).status).toBe(403);
    const unchanged = await setPinned(client, OTHER, MEMBER_HERE, theirs, false);
    expect(unchanged.body.unchanged).toBe(true);
    expect(acts).toEqual(['pin 600000000000000002']);
  });

  it('ends only his own open polls', async () => {
    const { client, acts } = fakeClient(OTHER);
    expect((await endOwnPoll(client, OTHER, MEMBER_HERE, { channelId: HERE, messageId: '600000000000000002' })).status).toBe(403);
    expect((await endOwnPoll(client, OTHER, MEMBER_HERE, { channelId: HERE, messageId: '600000000000000003' })).status).toBe(400);
    expect((await endOwnPoll(client, OTHER, MEMBER_HERE, { channelId: HERE, messageId: '600000000000000001' })).status).toBe(200);
    expect(acts).toEqual(['end 600000000000000001']);
  });

  it('reads a poll with voters, counting but never naming someone opted out', async () => {
    const { client } = fakeClient(OTHER);
    const r = await readPollInGuild(client, OTHER, { messageId: '600000000000000001' }, HERE);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ question: 'Ship it?', multi: true, mine: true, totalVotes: 2 });
    expect((r.body.results as Array<{ voters?: string[] }>)[0].voters).toEqual(['Fan']);
    expect((await readPollInGuild(client, OTHER, { channelId: FOREIGN, messageId: '600000000000000001' }, HERE)).status).toBe(404);
  });
});
