import { describe, it, expect, vi, beforeEach } from 'vitest';

const ROOM302 = '932719842522443928';
const PUBLIC_TEXT = '200000000000000001';
const MODS_TEXT = '200000000000000002';

const state = { lastTextChannel: PUBLIC_TEXT, summary: 'Decided: ship the OSM ticket first.' };

vi.mock('../../src/shared/db/scribe-store.js', () => ({
  getLastFinishedScribeSession: () => ({
    sessionId: 's',
    guildId: ROOM302,
    voiceChannelId: '300000000000000001',
    textChannelId: state.lastTextChannel,
    startedBy: 'ej',
    status: 'stopped',
    startedAt: '2026-11-19T18:02:40Z',
    endedAt: '2026-11-19T18:13:30Z',
    audioSecondsUsed: 551,
    sttCostUsd: 0.006,
    capped: false,
    summary: state.summary,
    pendingActionIds: [],
    stopReason: 'no-humans',
  }),
}));
vi.mock('../../src/gateway/routes/message-search.js', () => ({
  // The conversation's audience can read #general only.
  audienceReadable: async () => ({ allowed: new Set([PUBLIC_TEXT]), ok: false }),
  hasTargetedDeny: () => true,
}));
vi.mock('../../src/gateway/voice/scribe-auto.js', () => ({ autoScribeConfig: () => null }));
vi.mock('../../src/gateway/voice/scribe-session.js', () => ({
  startVoiceScribeSession: vi.fn(),
  stopVoiceScribeSession: vi.fn(),
  getActiveVoiceSession: () => null,
  ensureVoiceStateListener: vi.fn(),
}));
vi.mock('../../src/gateway/commands/scribe.js', () => ({ ANNOUNCE_TEXT: 'notes' }));

const { scribeLastSummary, scribeStart } = await import('../../src/gateway/routes/scribe-control.js');

const client: any = {
  channels: { cache: new Map([[PUBLIC_TEXT, { name: 'general' }], [MODS_TEXT, { name: 'mods' }]]) },
  guilds: { cache: new Map([[ROOM302, { channels: { cache: new Map() }, roles: { everyone: {} } }]]) },
};

describe('scribe last_summary', () => {
  beforeEach(() => {
    state.lastTextChannel = PUBLIC_TEXT;
  });

  it('shares the summary when everyone here can see where it was posted', async () => {
    const r = await scribeLastSummary(client, ROOM302, 'u', PUBLIC_TEXT);
    expect(r.body.summary).toContain('OSM ticket');
    expect(r.body.postedIn).toBe('#general');
  });

  it('withholds it (and the channel name) when it was posted somewhere private', async () => {
    state.lastTextChannel = MODS_TEXT;
    const r = await scribeLastSummary(client, ROOM302, 'u', PUBLIC_TEXT);
    expect(r.body.shared).toBe(false);
    expect(r.body.summary).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain('mods');
  });

  it('is Room 302 only, and start is EJ only', async () => {
    expect((await scribeLastSummary(client, '100000000000000009', 'u', PUBLIC_TEXT)).body.available).toBe(false);
    expect((await scribeStart(client, ROOM302, 'not-ej', PUBLIC_TEXT, undefined)).status).toBe(403);
  });
});
