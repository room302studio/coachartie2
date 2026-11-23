import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/shared/blocklist.js', () => ({
  scrubBlockedUserMentions: (text: string) => text.replace(/<@!?700000000000000002>/g, 'the banned one'),
}));
import { createThread, createForumPost, editOwnMessage, POST_GUILD_IDS } from '../../src/gateway/routes/discord-write.js';

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
      fetch: vi.fn(async (mid: string) => ({
        id: mid,
        author: { id: authorOf(mid) },
        edit: vi.fn(async (m: any) => edits.push(m)),
        startThread: vi.fn(async () => thread),
      })),
    },
  });
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
  return { client, sent, edits };
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
});
