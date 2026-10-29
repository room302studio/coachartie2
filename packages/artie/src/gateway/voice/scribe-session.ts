/**
 * Scribe mode's voice half: joins a voice channel, listens (never speaks — selfMute: true),
 * and hands each utterance to the engine through engine/api.ts ONLY (the seam
 * tests/architecture.test.ts enforces). STT, storage, summarization and the gated GitHub flow
 * are all engine-side (engine/jobs/scribe/orchestrator.ts) — this file's job is Discord voice
 * and nothing else: never writes audio to disk, discards each utterance's PCM the moment it's
 * handed off.
 *
 * One active session per guild (the command layer already restricts scribe to the one
 * allowed guild — shared/config/guilds.ts's isScribeAllowedGuild — so in practice this map
 * never holds more than one entry, but it's keyed by guildId rather than hardcoded for when
 * that allowlist grows).
 */
import {
  type Client,
  type VoiceBasedChannel,
  Events,
} from 'discord.js';
import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  EndBehaviorType,
  entersState,
  type VoiceConnection,
} from '@discordjs/voice';
import { opus } from 'prism-media';
import { logger } from '../../shared/logger.js';
import { getErrorMessage } from '../../shared/errors.js';
import { isBlockedUser } from '../../shared/blocklist.js';
import * as engine from '../../engine/api.js';
import { pcmToWav, pcmDurationSeconds, stereoToMonoPcm16 } from './wav.js';
import {
  SILENCE_MS,
  isUtteranceLongEnough,
  hasHardCapElapsed,
  HARD_CAP_MS,
  countNonBotMembers,
  noHumanStep,
} from './scribe-timers.js';

/** Discord's voice receiver hands back Opus decoded to interleaved 16-bit PCM at this rate. */
const OPUS_SAMPLE_RATE = 48000;
const OPUS_CHANNELS = 2;
/** How often the hard-cap and no-human checks run while a session is active. */
const TICK_MS = 15_000;

interface ActiveVoiceSession {
  sessionId: string;
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  startedBy: string;
  startedAt: number;
  client: Client;
  connection: VoiceConnection;
  speakingHandler: (userId: string) => void;
  subscribedUsers: Set<string>;
  utteranceCount: number;
  noHumanSince: number | null;
  reconnectAttempted: boolean;
  stopping: boolean;
  tickTimer: ReturnType<typeof setInterval>;
}

const activeSessions = new Map<string, ActiveVoiceSession>();

export interface VoiceSessionSnapshot {
  sessionId: string;
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  startedBy: string;
  startedAt: number;
  utteranceCount: number;
}

export function getActiveVoiceSession(guildId: string): VoiceSessionSnapshot | null {
  const session = activeSessions.get(guildId);
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    guildId: session.guildId,
    voiceChannelId: session.voiceChannelId,
    textChannelId: session.textChannelId,
    startedBy: session.startedBy,
    startedAt: session.startedAt,
    utteranceCount: session.utteranceCount,
  };
}

function nonBotMembersOf(channel: VoiceBasedChannel): number {
  return countNonBotMembers(channel.members.values());
}

async function resolveDisplayName(channel: VoiceBasedChannel, userId: string): Promise<string> {
  const cached = channel.members.get(userId);
  if (cached) return cached.displayName;
  try {
    const fetched = await channel.guild.members.fetch(userId);
    return fetched.displayName;
  } catch {
    return `Unknown speaker (${userId})`;
  }
}

function currentVoiceChannel(session: ActiveVoiceSession): VoiceBasedChannel | null {
  const channel = session.client.channels.cache.get(session.voiceChannelId);
  if (channel && 'members' in channel) {
    return channel as VoiceBasedChannel;
  }
  return null;
}

/** Runs on an interval: hard cap, and the "no humans left for 2 minutes" auto-stop. */
function tick(guildId: string): void {
  const session = activeSessions.get(guildId);
  if (!session || session.stopping) return;

  if (hasHardCapElapsed(session.startedAt, Date.now(), HARD_CAP_MS)) {
    stopVoiceScribeSession(guildId, 'hard-cap').catch((error) =>
      logger.error(`🎙️ Scribe hard-cap stop failed for ${guildId}:`, getErrorMessage(error))
    );
    return;
  }

  const channel = currentVoiceChannel(session);
  if (!channel) return;
  const step = noHumanStep({
    noHumanSince: session.noHumanSince,
    humanCount: nonBotMembersOf(channel),
    nowMs: Date.now(),
  });
  session.noHumanSince = step.noHumanSince;
  if (step.shouldStop) {
    stopVoiceScribeSession(guildId, 'no-humans').catch((error) =>
      logger.error(`🎙️ Scribe no-humans stop failed for ${guildId}:`, getErrorMessage(error))
    );
  }
}

/** One speaker's utterance: subscribe, decode, buffer, and on silence hand it to the engine. */
function handleSpeakingStart(session: ActiveVoiceSession, userId: string): void {
  if (session.stopping) return;
  if (isBlockedUser(userId)) return; // opted-out/blocked: never even subscribed
  if (session.subscribedUsers.has(userId)) return; // already capturing this speaker

  session.subscribedUsers.add(userId);
  const startedAt = new Date();

  const opusStream = session.connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
  });
  const decoder = new opus.Decoder({ frameSize: 960, channels: OPUS_CHANNELS, rate: OPUS_SAMPLE_RATE });
  const chunks: Buffer[] = [];
  decoder.on('data', (chunk: Buffer) => chunks.push(chunk));

  const finish = async (): Promise<void> => {
    session.subscribedUsers.delete(userId);
    const stereoPcm = Buffer.concat(chunks);
    if (stereoPcm.length === 0) return;
    const monoPcm = stereoToMonoPcm16(stereoPcm);
    const durationSeconds = pcmDurationSeconds(monoPcm, { sampleRate: OPUS_SAMPLE_RATE, channels: 1 });
    if (!isUtteranceLongEnough(durationSeconds)) return;

    const channel = currentVoiceChannel(session);
    let displayName = `Unknown speaker (${userId})`;
    if (channel) {
      displayName = await resolveDisplayName(channel, userId);
    }
    const wavBase64 = pcmToWav(monoPcm, { sampleRate: OPUS_SAMPLE_RATE, channels: 1 }).toString('base64');

    try {
      await engine.scribeSubmitUtterance({
        sessionId: session.sessionId,
        userId,
        displayName,
        wavBase64,
        startedAt: startedAt.toISOString(),
        durationSeconds,
      });
      session.utteranceCount++;
    } catch (error) {
      logger.warn(
        `🎙️ Scribe utterance submit failed (session ${session.sessionId}, user ${userId}):`,
        getErrorMessage(error)
      );
    }
  };

  decoder.once('end', () => {
    finish().catch((error) =>
      logger.warn(`🎙️ Scribe utterance finalize failed:`, getErrorMessage(error))
    );
  });
  decoder.once('error', (error: unknown) => {
    logger.warn(`🎙️ Scribe opus decode error (user ${userId}):`, getErrorMessage(error));
    finish().catch(() => {});
  });
  // .pipe() does NOT forward 'error' from its source — an unhandled error on the
  // AudioReceiveStream itself (the receiver, not the decoder) would otherwise throw
  // uncaught and take the whole process down.
  opusStream.once('error', (error: unknown) => {
    logger.warn(`🎙️ Scribe receive-stream error (user ${userId}):`, getErrorMessage(error));
    finish().catch(() => {});
  });

  opusStream.pipe(decoder);
}

async function handleDisconnect(guildId: string): Promise<void> {
  const session = activeSessions.get(guildId);
  if (!session || session.stopping) return;

  if (session.reconnectAttempted) {
    await stopVoiceScribeSession(guildId, 'disconnected');
    return;
  }
  session.reconnectAttempted = true;
  try {
    session.connection.rejoin();
    await entersState(session.connection, VoiceConnectionStatus.Ready, 5_000);
    logger.info(`🎙️ Scribe session ${session.sessionId} reconnected after a disconnect`);
  } catch {
    await stopVoiceScribeSession(guildId, 'disconnected');
  }
}

export interface StartVoiceResult {
  ok: boolean;
  sessionId?: string;
  reason?: string;
}

export async function startVoiceScribeSession(input: {
  client: Client;
  channel: VoiceBasedChannel;
  textChannelId: string;
  startedBy: string;
  /** End with the summary alone, no GitHub proposals (auto-joined meetings). */
  summaryOnly?: boolean;
}): Promise<StartVoiceResult> {
  const { client, channel, textChannelId, startedBy, summaryOnly } = input;
  const guildId = channel.guild.id;

  if (activeSessions.has(guildId)) {
    return { ok: false, reason: 'A scribe session is already running in this server.' };
  }

  // A scheduled auto-scribe meeting (summaryOnly) is EJ's standing ask and costs cents
  // (per-utterance STT + one summary), so the critical-runway gate only applies to ad-hoc /scribe.
  const brownout = summaryOnly ? { allowed: true as const, reason: undefined } : await engine.scribeCanStart();
  if (!brownout.allowed) {
    return { ok: false, reason: brownout.reason ?? 'Scribe mode is paused right now.' };
  }

  // Join BEFORE creating the DB session row: if the join fails there's nothing to clean up.
  // Creating the row first (the original order) could leave a zombie 'active' row sitting
  // until the 7-day retention sweep whenever the join itself failed.
  let connection: VoiceConnection;
  try {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (error) {
    return { ok: false, reason: `Could not join the voice channel: ${getErrorMessage(error)}` };
  }

  let sessionId: string;
  try {
    const created = await engine.scribeStart({
      guildId,
      voiceChannelId: channel.id,
      textChannelId,
      startedBy,
      summaryOnly,
    });
    sessionId = created.sessionId;
  } catch (error) {
    connection.destroy();
    return { ok: false, reason: `Could not create the scribe session: ${getErrorMessage(error)}` };
  }

  const speakingHandler = (userId: string) => {
    const session = activeSessions.get(guildId);
    if (session) handleSpeakingStart(session, userId);
  };
  connection.receiver.speaking.on('start', speakingHandler);
  connection.on(VoiceConnectionStatus.Disconnected, () => {
    handleDisconnect(guildId).catch((error) =>
      logger.error(`🎙️ Scribe disconnect handling failed for ${guildId}:`, getErrorMessage(error))
    );
  });

  const session: ActiveVoiceSession = {
    sessionId,
    guildId,
    voiceChannelId: channel.id,
    textChannelId,
    startedBy,
    startedAt: Date.now(),
    client,
    connection,
    speakingHandler,
    subscribedUsers: new Set(),
    utteranceCount: 0,
    noHumanSince: null,
    reconnectAttempted: false,
    stopping: false,
    tickTimer: setInterval(() => tick(guildId), TICK_MS),
  };
  activeSessions.set(guildId, session);
  logger.info(`🎙️ Scribe session ${sessionId} joined voice channel ${channel.id} in guild ${guildId}`);

  return { ok: true, sessionId };
}

export interface StopVoiceResult {
  ok: boolean;
  reason?: string;
  pendingCount?: number;
}

export async function stopVoiceScribeSession(guildId: string, stopReason: string): Promise<StopVoiceResult> {
  const session = activeSessions.get(guildId);
  if (!session) {
    return { ok: false, reason: 'No scribe session is running in this server.' };
  }
  if (session.stopping) {
    return { ok: false, reason: 'Already stopping.' };
  }
  session.stopping = true;
  activeSessions.delete(guildId);

  clearInterval(session.tickTimer);
  try {
    session.connection.receiver.speaking.off('start', session.speakingHandler);
  } catch {
    // best effort — destroying the connection below tears the receiver down regardless
  }
  try {
    session.connection.destroy();
  } catch (error) {
    logger.warn(`🎙️ Scribe connection teardown warning for ${guildId}:`, getErrorMessage(error));
  }

  try {
    const result = await engine.scribeStop(session.sessionId, stopReason);
    logger.info(
      `🎙️ Scribe session ${session.sessionId} stopped (${stopReason}): ${result.pendingCount} pending GitHub action(s), posted=${result.posted}`
    );
    return { ok: true, pendingCount: result.pendingCount };
  } catch (error) {
    logger.error(`🎙️ Scribe stop/summarize failed for ${session.sessionId}:`, getErrorMessage(error));
    return { ok: false, reason: `Stopped, but summarizing failed: ${getErrorMessage(error)}` };
  }
}

/** Graceful shutdown (src/main.ts's SIGINT/SIGTERM handler): summarize what exists for every
 *  still-running session rather than just dropping the connection. */
export async function stopAllVoiceScribeSessions(reason: string): Promise<void> {
  const guildIds = Array.from(activeSessions.keys());
  for (const guildId of guildIds) {
    await stopVoiceScribeSession(guildId, reason);
  }
}

/** Registered once by scribe.ts the first time a session starts in a process — keeps the
 *  no-human timer responsive to people leaving/joining without needing a listener per channel. */
let voiceStateListenerRegistered = false;
export function ensureVoiceStateListener(client: Client): void {
  if (voiceStateListenerRegistered) return;
  voiceStateListenerRegistered = true;
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    const guildId = newState.guild.id;
    const session = activeSessions.get(guildId);
    if (!session) return;
    if (oldState.channelId === session.voiceChannelId || newState.channelId === session.voiceChannelId) {
      tick(guildId);
    }
  });
}
