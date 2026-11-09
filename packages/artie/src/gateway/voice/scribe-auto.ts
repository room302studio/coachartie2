/**
 * Auto-scribe: Artie joins a meeting on his own and leaves on his own (EJ, 2026-10-29: "he
 * should join, listen, and send a summary at the end, that's it").
 *
 * During a configured window, once SCRIBE_AUTO_MIN_HUMANS people are in one of the configured
 * voice channels, he starts a summary-only scribe session there and posts the usual notes notice.
 * Leaving is the existing scribe rule: two minutes after the last human leaves, the session
 * stops and the summary is posted (scribe-session.ts tick / NO_HUMAN_TIMEOUT_MS).
 *
 * Env (all required to arm it, none of it secret):
 *   SCRIBE_AUTO_CHANNEL_ID       voice channel(s) to watch, comma-separated
 *   SCRIBE_AUTO_TEXT_CHANNEL_ID  where the summary goes, e.g. EJ's DM channel (default: the chat
 *                                of whichever voice channel the meeting is in). The "taking notes"
 *                                notice always goes to the voice channel's chat.
 *   SCRIBE_AUTO_WINDOWS          `always` (EJ, 2026-11-09: "he should autojoin meetings with 2
 *                                members"), or comma-separated ISO "start/end" pairs with
 *                                offsets, e.g. 2026-10-29T12:30:00-04:00/2026-10-29T15:30:00-04:00
 *   SCRIBE_AUTO_MIN_HUMANS       people needed to count as a meeting (default 2)
 *
 * One auto-start per window: if the meeting ends and someone drifts back in, he stays out.
 * In `always` mode it is one auto-start per meeting per channel: he re-arms for a channel only
 * once it drops below the threshold, so a manual /scribe stop mid-meeting doesn't pull him back.
 *
 * Sessions propose GitHub issues like /scribe does (EJ, 2026-11-09: he should be "making gh
 * issues"); every proposal is still gated behind EJ's approval (propose.ts).
 */
import { Events, type Client, type VoiceBasedChannel } from 'discord.js';
import { logger } from '../../shared/logger.js';
import { getErrorMessage } from '../../shared/errors.js';
import { isScribeAllowedGuild } from '../../shared/config/guilds.js';
import { OWNER_USER_ID } from '../../shared/config/owner.js';
import { ANNOUNCE_TEXT } from '../commands/scribe.js';
import { countNonBotMembers } from './scribe-timers.js';
import { ensureVoiceStateListener, getActiveVoiceSession, startVoiceScribeSession } from './scribe-session.js';

const CHECK_MS = 60_000;
const ALWAYS_KEY = 'always';
const ALWAYS_WINDOW: AutoWindow = { start: -Infinity, end: Infinity, key: ALWAYS_KEY };

export interface AutoWindow {
  start: number;
  end: number;
  key: string;
}

export interface AutoScribeConfig {
  voiceChannelIds: string[];
  /** Fixed destination for notice + summary; undefined = the meeting's own voice-channel chat. */
  textChannelId?: string;
  windows: AutoWindow[];
  minHumans: number;
}

/** Parse the env; null when auto-scribe isn't armed. Bad window entries are skipped, loudly. */
export function autoScribeConfig(env: NodeJS.ProcessEnv = process.env): AutoScribeConfig | null {
  const voiceChannelIds = (env.SCRIBE_AUTO_CHANNEL_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (voiceChannelIds.length === 0) return null;
  const windows: AutoWindow[] = [];
  if ((env.SCRIBE_AUTO_WINDOWS || '').trim().toLowerCase() === ALWAYS_KEY) {
    windows.push(ALWAYS_WINDOW);
  }
  for (const raw of (env.SCRIBE_AUTO_WINDOWS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [a, b] = raw.split('/');
    const start = Date.parse(a ?? '');
    const end = Date.parse(b ?? '');
    if (raw.toLowerCase() === ALWAYS_KEY) continue;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      logger.warn(`🎙️ Auto-scribe: ignoring bad window "${raw}" (want ISO start/end with offsets)`);
      continue;
    }
    windows.push({ start, end, key: raw });
  }
  if (windows.length === 0) return null;
  return {
    voiceChannelIds,
    textChannelId: (env.SCRIBE_AUTO_TEXT_CHANNEL_ID || '').trim() || undefined,
    windows,
    minHumans: minHumansFrom(env.SCRIBE_AUTO_MIN_HUMANS),
  };
}

/** SCRIBE_AUTO_MIN_HUMANS as a positive count, defaulting to 2. */
function minHumansFrom(raw: string | undefined): number {
  const min = parseInt(raw || '', 10);
  if (Number.isFinite(min) && min > 0) return min;
  return 2;
}

/** The window `now` falls in, if any. */
export function activeWindow(windows: AutoWindow[], now: number): AutoWindow | null {
  return windows.find((w) => now >= w.start && now < w.end) ?? null;
}

/** Latch key: per window, or per channel in `always` mode (one start per meeting). */
export function startKey(window: AutoWindow, channelId: string): string {
  if (window.key === ALWAYS_KEY) return `${ALWAYS_KEY}:${channelId}`;
  return window.key;
}

/** Pure decision: start now? */
export function shouldAutoStart(input: {
  window: AutoWindow | null;
  humans: number;
  minHumans: number;
  sessionActive: boolean;
  alreadyStarted: boolean;
}): boolean {
  return (
    input.window !== null && !input.sessionActive && !input.alreadyStarted && input.humans >= input.minHumans
  );
}

const startedWindows = new Set<string>();
let starting = false;

async function check(client: Client, cfg: AutoScribeConfig): Promise<void> {
  if (starting) return;
  const window = activeWindow(cfg.windows, Date.now());
  if (!window) return;

  // The meeting is in whichever watched channel has people (EJ uses both Studio and
  // studio-private); first one over the threshold wins.
  let channel: VoiceBasedChannel | undefined;
  let humans = 0;
  let key = window.key;
  for (const id of cfg.voiceChannelIds) {
    const candidate = client.channels.cache.get(id) as VoiceBasedChannel | undefined;
    if (!candidate || !('members' in candidate) || !isScribeAllowedGuild(candidate.guild.id)) continue;
    const count = countNonBotMembers(candidate.members.values());
    const candidateKey = startKey(window, candidate.id);
    // `always` mode: the meeting in this channel is over once it drops below the threshold.
    if (window.key === ALWAYS_KEY && count < cfg.minHumans) startedWindows.delete(candidateKey);
    const go = shouldAutoStart({
      window,
      humans: count,
      minHumans: cfg.minHumans,
      sessionActive: getActiveVoiceSession(candidate.guild.id) !== null,
      alreadyStarted: startedWindows.has(candidateKey),
    });
    if (go) {
      channel = candidate;
      humans = count;
      key = candidateKey;
      break;
    }
  }
  if (!channel) return;
  const textChannelId = cfg.textChannelId ?? channel.id;

  starting = true;
  try {
    ensureVoiceStateListener(client);
    const result = await startVoiceScribeSession({
      client,
      channel,
      textChannelId,
      startedBy: OWNER_USER_ID, // standing ask from EJ; spend is ledgered against him like /scribe
      summaryOnly: false,
    });
    if (!result.ok) {
      // Not marked started: the next check retries (e.g. brownout eased, join hiccup).
      logger.warn(`🎙️ Auto-scribe could not start in #${channel.name}: ${result.reason}`);
      return;
    }
    startedWindows.add(key);
    logger.info(`🎙️ Auto-scribe joined #${channel.name} (${humans} people), session ${result.sessionId}`);
    // The notice always goes where the people being recorded are (the voice channel's chat);
    // only the summary follows SCRIBE_AUTO_TEXT_CHANNEL_ID (EJ, 2026-10-29: summaries to his DM,
    // never public).
    const text = client.channels.cache.get(channel.id);
    if (text && 'send' in text) {
      await text.send(ANNOUNCE_TEXT).catch((error: unknown) =>
        logger.warn('🎙️ Auto-scribe notice failed:', getErrorMessage(error))
      );
    }
  } catch (error) {
    logger.error('🎙️ Auto-scribe start failed:', getErrorMessage(error));
  } finally {
    starting = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function initAutoScribe(client: Client): void {
  const cfg = autoScribeConfig();
  if (!cfg) {
    logger.info('🎙️ Auto-scribe off (SCRIBE_AUTO_CHANNEL_ID / SCRIBE_AUTO_WINDOWS unset)');
    return;
  }
  logger.info(
    `🎙️ Auto-scribe armed for voice ${cfg.voiceChannelIds.join(', ')}: ${cfg.windows.map((w) => w.key).join(', ')} (min ${cfg.minHumans} people)`
  );
  const watched = new Set(cfg.voiceChannelIds);
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    if ((oldState.channelId && watched.has(oldState.channelId)) || (newState.channelId && watched.has(newState.channelId))) {
      void check(client, cfg);
    }
  });
  // Also poll: people already sitting in the channel when the window opens fire no event.
  timer = setInterval(() => void check(client, cfg), CHECK_MS);
  void check(client, cfg);
}

export function stopAutoScribe(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
