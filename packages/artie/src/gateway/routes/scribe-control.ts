/**
 * The scribe, as a tool Artie can hold (his audio asks #1 and #3, 2026-11-23): say whether
 * he's taking notes, where the summary will land, what auto-scribe watches; start and stop a
 * session when EJ asks. Same rules as /scribe (commands/scribe.ts): Room 302 only, start/stop
 * owner-only (the engine gates that as who:'owner'; checked again here), the same
 * announcement so nobody is recorded without a notice in chat.
 */
import type { Client, GuildBasedChannel, VoiceBasedChannel } from 'discord.js';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { isOwner } from '../../shared/config/owner.js';
import { isScribeAllowedGuild } from '../../shared/config/guilds.js';
import { getLastFinishedScribeSession } from '../../shared/db/scribe-store.js';
import { autoScribeConfig } from '../voice/scribe-auto.js';
import {
  startVoiceScribeSession,
  stopVoiceScribeSession,
  getActiveVoiceSession,
  ensureVoiceStateListener,
} from '../voice/scribe-session.js';
import { ANNOUNCE_TEXT } from '../commands/scribe.js';
import { audienceReadable, hasTargetedDeny } from './message-search.js';
import { logger } from '../../shared/logger.js';
import { getErrorMessage } from '../../shared/errors.js';

type Result = { status: number; body: Record<string, unknown> };

const ONLY_ROOM_302 = "The scribe only runs in Room 302 Studio.";

/** Who may hear a channel's name: undefined = anyone (start/stop replies go to EJ's own ask). */
type Visible = ((channelId: string) => boolean) | undefined;

/** "#name" for a channel the audience can see, "EJ's DMs" for a DM, else "a private channel". */
function placeName(client: Client, channelId: string | undefined, visible?: Visible): string {
  if (!channelId) {
    return "the voice channel's own chat";
  }
  const ch = client.channels.cache.get(channelId);
  if (ch?.type === ChannelType.DM) {
    return "EJ's DMs";
  }
  if (visible && !visible(channelId)) {
    return 'a private channel';
  }
  if (ch && 'name' in ch && typeof ch.name === 'string' && ch.name) {
    return `#${ch.name}`;
  }
  return 'an unknown channel';
}

/**
 * Status names only channels everyone in the conversation can see (Codex Medium): text channels
 * via the same audience check as search; voice channels when @everyone may view them.
 */
async function audienceVisibility(
  client: Client,
  guildId: string,
  askerId: string | null,
  fromChannelId: string | undefined
): Promise<(channelId: string) => boolean> {
  const { allowed } = await audienceReadable(client, guildId, askerId, fromChannelId);
  const guild = client.guilds.cache.get(guildId);
  let conv: GuildBasedChannel | undefined;
  if (fromChannelId) {
    conv = guild?.channels.cache.get(fromChannelId);
  }
  return (channelId: string) => {
    if (allowed.has(channelId)) {
      return true;
    }
    const ch = guild?.channels.cache.get(channelId);
    if (!guild || !ch?.isVoiceBased()) {
      return false;
    }
    // Same rule search uses: @everyone may view it AND no role/member overwrite shuts out
    // part of this conversation's audience (Codex: @everyone alone missed targeted denies).
    if (hasTargetedDeny(guild, ch, conv)) {
      return false;
    }
    return Boolean(ch.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel));
  };
}

export async function scribeStatus(
  client: Client,
  guildId: string | null,
  askerId: string | null,
  fromChannelId: string | undefined
): Promise<Result> {
  if (!guildId || !isScribeAllowedGuild(guildId)) {
    return { status: 200, body: { success: true, available: false, note: ONLY_ROOM_302 } };
  }
  const visible = await audienceVisibility(client, guildId, askerId, fromChannelId);
  const live = getActiveVoiceSession(guildId);
  const auto = autoScribeConfig();
  const last = getLastFinishedScribeSession(guildId);
  const body: Record<string, unknown> = { success: true, available: true };
  if (live) {
    body.live = {
      voiceChannel: placeName(client, live.voiceChannelId, visible),
      summaryGoesTo: placeName(client, live.textChannelId, visible),
      minutes: Math.round((Date.now() - live.startedAt) / 60_000),
      utterances: live.utteranceCount,
    };
  } else {
    body.live = null;
  }
  if (auto) {
    let windows = 'always';
    if (auto.windows.length > 0) {
      windows = auto.windows.map((w) => w.key).join(', ');
    }
    body.autoScribe = {
      watches: auto.voiceChannelIds.map((id) => placeName(client, id, visible)),
      when: windows,
      startsAtPeople: auto.minHumans,
      summaryGoesTo: placeName(client, auto.textChannelId, visible),
    };
  } else {
    body.autoScribe = null;
  }
  if (last) {
    body.lastSession = {
      endedAt: last.endedAt,
      voiceChannel: placeName(client, last.voiceChannelId, visible),
      summaryWentTo: placeName(client, last.textChannelId, visible),
      minutesTranscribed: Math.round(last.audioSecondsUsed / 60),
      stopReason: last.stopReason,
    };
  } else {
    body.lastSession = null;
  }
  body.note = 'Started by hand (/scribe or EJ asking you), the summary posts where it was started.';
  return { status: 200, body };
}

const SUMMARY_MAX = 3500;

/**
 * The last meeting's summary text (Artie's ask, 2026-11-23: "turn 'a summary exists' into
 * 'here's what you decided'"). Only when everyone in this conversation can already see the
 * channel it was posted to; otherwise only that it exists. A summary sent to EJ's DMs stays his.
 */
export async function scribeLastSummary(
  client: Client,
  guildId: string | null,
  askerId: string | null,
  fromChannelId: string | undefined
): Promise<Result> {
  if (!guildId || !isScribeAllowedGuild(guildId)) {
    return { status: 200, body: { success: true, available: false, note: ONLY_ROOM_302 } };
  }
  const last = getLastFinishedScribeSession(guildId);
  if (!last) {
    return { status: 200, body: { success: true, found: false, note: 'No meeting has been scribed here yet.' } };
  }
  if (!last.summary) {
    return { status: 200, body: { success: true, found: true, endedAt: last.endedAt, note: 'That session ended without a summary.' } };
  }
  const visible = await audienceVisibility(client, guildId, askerId, fromChannelId);
  if (!visible(last.textChannelId)) {
    return {
      status: 200,
      body: {
        success: true,
        found: true,
        endedAt: last.endedAt,
        shared: false,
        note: 'A summary exists, but it was posted somewhere not everyone here can see. Ask EJ, or ask me where you can both see it.',
      },
    };
  }
  let summary = last.summary;
  if (summary.length > SUMMARY_MAX) {
    summary = `${summary.slice(0, SUMMARY_MAX)}\n…[cut; the full summary is in ${placeName(client, last.textChannelId, visible)}]`;
  }
  return {
    status: 200,
    body: {
      success: true,
      found: true,
      endedAt: last.endedAt,
      postedIn: placeName(client, last.textChannelId, visible),
      shared: true,
      summary,
    },
  };
}

export async function scribeStart(
  client: Client,
  guildId: string | null,
  userId: string | null,
  fromChannelId: string | undefined,
  voiceChannelId: string | undefined
): Promise<Result> {
  if (!guildId || !isScribeAllowedGuild(guildId)) {
    return { status: 403, body: { success: false, error: ONLY_ROOM_302 } };
  }
  if (!userId || !isOwner(userId)) {
    return { status: 403, body: { success: false, error: 'Only EJ can start the scribe.' } };
  }
  if (!fromChannelId) {
    return { status: 400, body: { success: false, error: 'Start it from a channel, so the summary has a home.' } };
  }
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    return { status: 503, body: { success: false, error: 'Not connected to that server right now.' } };
  }
  let voice: VoiceBasedChannel | null = null;
  if (voiceChannelId) {
    const ch = guild.channels.cache.get(voiceChannelId);
    if (ch?.isVoiceBased()) {
      voice = ch;
    }
  } else {
    voice = guild.voiceStates.cache.get(userId)?.channel ?? null;
  }
  if (!voice) {
    return { status: 400, body: { success: false, error: 'EJ is not in a voice channel; join one or name it.' } };
  }
  // Consent first (Codex High): the notice goes to the voice channel's own chat, which everyone
  // in the call sees, BEFORE anything is captured. No notice, no recording.
  try {
    await voice.send({ content: ANNOUNCE_TEXT, allowedMentions: { parse: [] } });
  } catch (error) {
    logger.warn('🎙️ Scribe notice failed; not starting:', getErrorMessage(error));
    const visible = await audienceVisibility(client, guildId, userId, fromChannelId);
    return {
      status: 403,
      body: {
        success: false,
        error: `I couldn't post the notes notice in ${placeName(client, voice.id, visible)}'s chat, so I didn't start.`,
      },
    };
  }
  ensureVoiceStateListener(client);
  const result = await startVoiceScribeSession({
    client,
    channel: voice,
    textChannelId: fromChannelId,
    startedBy: userId,
  });
  if (!result.ok) {
    return { status: 409, body: { success: false, error: result.reason ?? 'could not start' } };
  }
  const visible = await audienceVisibility(client, guildId, userId, fromChannelId);
  const voiceName = placeName(client, voice.id, visible);
  return {
    status: 200,
    body: {
      success: true,
      voiceChannel: voiceName,
      summaryGoesTo: placeName(client, fromChannelId, visible),
      announcedIn: `${voiceName}'s chat`,
    },
  };
}

export async function scribeStop(
  client: Client,
  guildId: string | null,
  userId: string | null,
  fromChannelId: string | undefined
): Promise<Result> {
  if (!guildId || !isScribeAllowedGuild(guildId)) {
    return { status: 403, body: { success: false, error: ONLY_ROOM_302 } };
  }
  if (!userId || !isOwner(userId)) {
    return { status: 403, body: { success: false, error: 'Only EJ can stop the scribe.' } };
  }
  const live = getActiveVoiceSession(guildId);
  const result = await stopVoiceScribeSession(guildId, 'manual-stop');
  if (!result.ok) {
    return { status: 409, body: { success: false, error: result.reason ?? 'could not stop' } };
  }
  return {
    status: 200,
    body: {
      success: true,
      summaryPostingTo: placeName(client, live?.textChannelId, await audienceVisibility(client, guildId, userId, fromChannelId)),
      pendingGithubActions: result.pendingCount ?? 0,
    },
  };
}
