import { describe, it, expect, vi, beforeEach } from 'vitest';

const createPoll = vi.fn();
const endOwnPoll = vi.fn(async () => ({ status: 200, body: { success: true } }));
vi.mock('../../src/gateway/api.js', () => ({
  createPoll: (...args: unknown[]) => createPoll(...args),
  readPollInGuild: vi.fn(),
  endOwnPoll: (...args: unknown[]) => endOwnPoll(...(args as [])),
  guildChannelEntries: (guildId: string) => {
    if (guildId === 'G') {
      return [{ id: '1', name: 'general', public: true }, { id: '2', name: 'news', public: true }];
    }
    return [];
  },
  mayPostElsewhere: async (guildId: string) => guildId === 'ROOM302',
  audienceReadable: async () => ({ allowed: new Set(['1']), ok: false }),
  isOk: (resp: { status: number }) => resp.status >= 200 && resp.status < 300,
}));

import { discordPollCapability, isYes, optionLosses, pollHandler, pollTarget } from '../../src/engine/tools/discord/poll.js';
import { canonicalParams } from '../../src/engine/5-tool-loop/tool-policy.js';

const HERE = { guildId: 'G', channelId: '1', userId: '300000000000000009' } as never;

describe('discord-poll multi-select (EJ, 2026-11-24)', () => {
  beforeEach(() => {
    createPoll.mockReset();
    createPoll.mockResolvedValue({ status: 200, body: { success: true, messageId: '42', durationHours: 72 } });
  });

  it('declares multi as a boolean the model can see, with the spellings models use', () => {
    const multi = discordPollCapability.actions?.create_poll.params?.multi;
    expect(multi?.type).toBe('boolean');
    const params = canonicalParams(discordPollCapability.actions, 'create_poll', { allow_multiselect: 'true' });
    expect(params).toEqual({ multi: 'true' });
  });

  it('reads a yes in any spelling, and nothing else', () => {
    for (const yes of [true, 'true', 'TRUE', 'yes', '1', 1]) expect(isYes(yes)).toBe(true);
    for (const no of [false, 'false', 'no', '', undefined, 0]) expect(isYes(no)).toBe(false);
  });

  it('sends allowMultiselect and says so in the result', async () => {
    const out = JSON.parse(
      await pollHandler({ action: 'create_poll', question: 'When?', options: 'A | B', multi: 'true' }, HERE)
    );
    expect(createPoll.mock.calls[0][1].allowMultiselect).toBe(true);
    expect(out.multi).toBe(true);
    expect(out.message).toContain('multiple choice');
  });

  it('defaults to single choice and says so', async () => {
    const out = JSON.parse(await pollHandler({ action: 'create_poll', question: 'Q', options: 'A | B' }, HERE));
    expect(createPoll.mock.calls[0][1].allowMultiselect).toBe(false);
    expect(out.message).toContain('single choice');
  });

  it('posts in this channel by default; another channel only in this server, and only Room 302 or EJ', async () => {
    const member = { guildId: 'G', channelId: '1', userId: '300000000000000009' } as never;
    expect(await pollTarget({}, member)).toEqual({ ok: true, channelId: '1' });
    expect((await pollTarget({ channelId: '2' }, member)).ok).toBe(false);
    expect((await pollTarget({ channelId: '999' }, member)).ok).toBe(false);
    // Even in Room 302, another channel is EJ's call.
    const roomMember = { guildId: 'ROOM302', channelId: '1', userId: '300000000000000009' } as never;
    expect((await pollTarget({ channelId: '2' }, roomMember)).ok).toBe(false);
  });

  it("won't read a poll in a channel the asker can't read", async () => {
    const out = JSON.parse(await pollHandler({ action: 'read_poll', channelId: '2', message_id: '9' }, HERE));
    expect(out.success).toBe(false);
  });

  it('end_poll defaults to the last poll he made in this channel', async () => {
    const ctx = { guildId: 'G', channelId: '1', userId: '300000000000000009' } as never;
    await pollHandler({ action: 'create_poll', question: 'Q', options: 'A | B' }, ctx);
    await pollHandler({ action: 'end_poll' }, ctx);
    expect((endOwnPoll.mock.calls[0] as unknown[])[2]).toEqual({ channelId: '1', messageId: '42' });
  });

  it('names options Discord will drop or shorten', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `opt ${i}`);
    expect(optionLosses(eleven).dropped).toEqual(['opt 10']);
    expect(optionLosses(['x'.repeat(56), 'ok']).shortened).toHaveLength(1);
  });
});
