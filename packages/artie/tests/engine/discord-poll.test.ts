import { describe, it, expect, vi, beforeEach } from 'vitest';

const createPoll = vi.fn();
vi.mock('../../src/gateway/api.js', () => ({
  createPoll: (...args: unknown[]) => createPoll(...args),
  readPoll: vi.fn(),
  isOk: (resp: { status: number }) => resp.status >= 200 && resp.status < 300,
}));

import { discordPollCapability, isYes, optionLosses, pollHandler } from '../../src/engine/tools/discord/poll.js';
import { canonicalParams } from '../../src/engine/5-tool-loop/tool-policy.js';

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
      await pollHandler({ action: 'create_poll', channelId: '1', question: 'When?', options: 'A | B', multi: 'true' })
    );
    expect(createPoll.mock.calls[0][1].allowMultiselect).toBe(true);
    expect(out.multi).toBe(true);
    expect(out.message).toContain('multiple choice');
  });

  it('defaults to single choice and says so', async () => {
    const out = JSON.parse(await pollHandler({ action: 'create_poll', channelId: '1', question: 'Q', options: 'A | B' }));
    expect(createPoll.mock.calls[0][1].allowMultiselect).toBe(false);
    expect(out.message).toContain('single choice');
  });

  it('names options Discord will drop or shorten', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `opt ${i}`);
    expect(optionLosses(eleven).dropped).toEqual(['opt 10']);
    expect(optionLosses(['x'.repeat(56), 'ok']).shortened).toHaveLength(1);
  });
});
