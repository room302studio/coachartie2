import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OWNER_USER_ID } from '../../../src/shared/config/owner.js';
import { SCRIBE_ALLOWED_GUILD_IDS } from '../../../src/shared/config/guilds.js';

const {
  startVoiceScribeSessionMock,
  stopVoiceScribeSessionMock,
  getActiveVoiceSessionMock,
  ensureVoiceStateListenerMock,
} = vi.hoisted(() => ({
  startVoiceScribeSessionMock: vi.fn(),
  stopVoiceScribeSessionMock: vi.fn(),
  getActiveVoiceSessionMock: vi.fn(),
  ensureVoiceStateListenerMock: vi.fn(),
}));

vi.mock('../../../src/gateway/voice/scribe-session.js', () => ({
  startVoiceScribeSession: startVoiceScribeSessionMock,
  stopVoiceScribeSession: stopVoiceScribeSessionMock,
  getActiveVoiceSession: getActiveVoiceSessionMock,
  ensureVoiceStateListener: ensureVoiceStateListenerMock,
}));

import { scribeCommand } from '../../../src/gateway/commands/scribe.js';

const ALLOWED_GUILD = SCRIBE_ALLOWED_GUILD_IDS[0];
const OTHER_GUILD = 'some-other-guild-id';

function fakeInteraction(overrides: Record<string, unknown> = {}) {
  const replies: unknown[] = [];
  const edits: unknown[] = [];
  const base: Record<string, unknown> = {
    guildId: ALLOWED_GUILD,
    guild: {
      id: ALLOWED_GUILD,
      channels: { cache: new Map() },
      voiceStates: { cache: new Map() },
    },
    client: {},
    channelId: 'text-channel-1',
    channel: { send: vi.fn() },
    user: { id: OWNER_USER_ID, username: 'ej' },
    options: {
      getSubcommand: () => 'start',
      getChannel: () => null,
    },
    replied: false,
    deferred: false,
    reply: vi.fn(async (content: unknown) => {
      replies.push(content);
      (base as any).replied = true;
    }),
    deferReply: vi.fn(async () => {
      (base as any).deferred = true;
    }),
    editReply: vi.fn(async (content: unknown) => {
      edits.push(content);
    }),
    _replies: replies,
    _edits: edits,
  };
  Object.assign(base, overrides);
  return base as any;
}

beforeEach(() => {
  startVoiceScribeSessionMock.mockReset().mockResolvedValue({ ok: true, sessionId: 'session-1' });
  stopVoiceScribeSessionMock.mockReset().mockResolvedValue({ ok: true, pendingCount: 0 });
  getActiveVoiceSessionMock.mockReset().mockReturnValue(null);
  ensureVoiceStateListenerMock.mockReset();
});

describe('/scribe start: guild gate', () => {
  it('refuses in a guild that is not Room 302 Studio, without starting a session', async () => {
    const interaction = fakeInteraction({
      guildId: OTHER_GUILD,
      guild: { id: OTHER_GUILD, channels: { cache: new Map() }, voiceStates: { cache: new Map() } },
      options: { getSubcommand: () => 'start', getChannel: () => null },
    });
    await scribeCommand.execute(interaction);
    expect(startVoiceScribeSessionMock).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const content = (interaction._replies[0] as any).content;
    expect(content).toMatch(/not approved|Room 302/i);
  });

  it('allows the owner in the allowed guild to proceed to the voice-channel check', async () => {
    const interaction = fakeInteraction({
      guildId: ALLOWED_GUILD,
      guild: { id: ALLOWED_GUILD, channels: { cache: new Map() }, voiceStates: { cache: new Map() } },
      options: { getSubcommand: () => 'start', getChannel: () => null },
    });
    await scribeCommand.execute(interaction);
    // No voice channel resolvable (empty voiceStates, no channel option) -> the join never
    // happens, but it got PAST the guild/owner gates to the "join a voice channel" message.
    expect(startVoiceScribeSessionMock).not.toHaveBeenCalled();
    const content = (interaction._replies[0] as any).content;
    expect(content).toMatch(/join a voice channel/i);
  });
});

describe('/scribe start: owner gate', () => {
  it('refuses a non-owner even in the allowed guild', async () => {
    const interaction = fakeInteraction({
      user: { id: 'not-the-owner', username: 'someone-else' },
      options: { getSubcommand: () => 'start', getChannel: () => null },
    });
    await scribeCommand.execute(interaction);
    expect(startVoiceScribeSessionMock).not.toHaveBeenCalled();
    const content = (interaction._replies[0] as any).content;
    expect(content).toMatch(/only ej/i);
  });
});

describe('/scribe stop: owner gate', () => {
  it('refuses a non-owner', async () => {
    const interaction = fakeInteraction({
      user: { id: 'not-the-owner', username: 'someone-else' },
      options: { getSubcommand: () => 'stop' },
    });
    await scribeCommand.execute(interaction);
    expect(stopVoiceScribeSessionMock).not.toHaveBeenCalled();
    const content = (interaction._replies[0] as any).content;
    expect(content).toMatch(/only ej/i);
  });

  it('lets the owner stop', async () => {
    const interaction = fakeInteraction({ options: { getSubcommand: () => 'stop' } });
    await scribeCommand.execute(interaction);
    expect(stopVoiceScribeSessionMock).toHaveBeenCalledWith(ALLOWED_GUILD, 'manual-stop');
    expect(interaction.deferReply).toHaveBeenCalled();
  });
});

describe('/scribe status: anyone may run it', () => {
  it('reports no active session', async () => {
    const interaction = fakeInteraction({
      user: { id: 'not-the-owner', username: 'someone-else' },
      options: { getSubcommand: () => 'status' },
    });
    await scribeCommand.execute(interaction);
    const content = (interaction._replies[0] as any).content;
    expect(content).toMatch(/no scribe session/i);
  });

  it('reports an active session', async () => {
    getActiveVoiceSessionMock.mockReturnValue({
      sessionId: 's1',
      guildId: ALLOWED_GUILD,
      voiceChannelId: 'voice-1',
      textChannelId: 'text-1',
      startedBy: OWNER_USER_ID,
      startedAt: Date.now() - 5 * 60_000,
      utteranceCount: 3,
    });
    const interaction = fakeInteraction({
      user: { id: 'not-the-owner', username: 'someone-else' },
      options: { getSubcommand: () => 'status' },
    });
    await scribeCommand.execute(interaction);
    const content = (interaction._replies[0] as any).content;
    expect(content).toContain('3 utterance');
  });
});
