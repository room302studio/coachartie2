/**
 * The engine side of scribe mode: everything that isn't Discord-facing. The gateway (which
 * owns the voice connection) reaches this only through engine/api.ts — this file is where
 * those seam functions actually live.
 *
 * Flow: gateway joins a voice channel and, per utterance, hands PCM wrapped as a WAV
 * (base64, over the seam) to submitScribeUtterance. STT happens AS THE MEETING RUNS, one call
 * per utterance — not batched at the end — so /scribe stop only has to do one LLM summary
 * call, not catch up on an hour of audio first. The audio buffer is never written to disk and
 * is discarded (garbage collected) as soon as the STT call returns; only the transcript text
 * persists (shared/db/scribe-store.ts).
 */
import { randomUUID } from 'crypto';
import { logger } from '../../../shared/logger.js';
import { getErrorMessage } from '../../../shared/errors.js';
import { isBlockedUser } from '../../../shared/blocklist.js';
import { GUILD_CONFIGS } from '../../../shared/config/guilds.js';
import { OWNER_USER_ID } from '../../../shared/config/owner.js';
import { sendChunkedChannelMessage } from '../../../gateway/api.js';
import {
  createScribeSession,
  getScribeSession,
  getActiveScribeSessionForGuild,
  addScribeUsage,
  markScribeSessionCapped,
  finishScribeSession,
  appendScribeUtterance,
  listScribeUtterances,
  sweepExpiredScribeData,
  scribeRetentionDays,
  type ScribeSession,
} from '../../../shared/db/scribe-store.js';
import { getBrownoutMode } from '../../budget/brownout.js';
import { UsageTracker } from '../../budget/usage-ledger.js';
import { transcribeWav } from './stt.js';
import { computeSttCostUsd, scribeSttModel } from './cost.js';
import { generateScribeSummary } from './summary.js';
import { submitScribeProposals } from './propose.js';
import type { ScribeUtteranceInput } from './types.js';

/** 180 minutes of STT per session by default (SCRIBE_MAX_AUDIO_MIN). A few cents either way,
 *  but a runaway/forgotten session (the "no scheduler, pending_actions has no expiry" risk
 *  the research spec flagged) shouldn't be able to run the bill up unbounded. */
export function scribeMaxAudioSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const minutes = parseFloat(env.SCRIBE_MAX_AUDIO_MIN || '');
  if (Number.isFinite(minutes) && minutes > 0) return minutes * 60;
  return 180 * 60;
}

/** Room 302's configured GitHub-sync repo — the "most plausible configured repo" the build
 *  spec asks for when a proposal doesn't name one explicitly. */
export function defaultScribeRepo(guildId: string): string | null {
  const config = Object.values(GUILD_CONFIGS).find((c) => c.id === guildId);
  return config?.githubSync?.repos?.[0]?.repo ?? null;
}

export async function scribeCanStart(): Promise<{ allowed: boolean; reason?: string }> {
  const status = await getBrownoutMode();
  if (status.mode === 'critical') {
    return {
      allowed: false,
      reason: "Credit runway's critical right now — scribe mode would add real spend on top of an already-tight budget. Try again once it recovers (`/usage` or the self-meter line shows the mode).",
    };
  }
  return { allowed: true };
}

/** Sessions that end with the summary alone, no GitHub proposals (auto-joined meetings, EJ
 *  2026-10-29: "send a summary at the end, that's it"). In memory: a restart stops and
 *  summarizes every live session before the process exits, so nothing outlives the set. */
const summaryOnlySessions = new Set<string>();

export function startScribeSession(rawInput: {
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  startedBy: string;
  summaryOnly?: boolean;
}): { sessionId: string } {
  const { summaryOnly, ...input } = rawInput;
  // Any previous session's retention window may have lapsed by the time a new one starts;
  // sweeping here means the 7-day cleanup never needs its own scheduler wiring.
  const swept = sweepExpiredScribeData();
  if (swept.sessionsDeleted > 0) {
    logger.info(`🧹 Scribe retention sweep: ${swept.sessionsDeleted} session(s), ${swept.utterancesDeleted} utterance(s)`);
  }
  const sessionId = randomUUID();
  createScribeSession({ sessionId, ...input });
  if (summaryOnly) summaryOnlySessions.add(sessionId);
  logger.info(`📝 Scribe session ${sessionId} started in guild ${input.guildId} by ${input.startedBy}`);
  return { sessionId };
}

export interface SubmitUtteranceResult {
  accepted: boolean;
  text?: string;
  reason?: string;
}

export async function submitScribeUtterance(input: ScribeUtteranceInput): Promise<SubmitUtteranceResult> {
  const session = getScribeSession(input.sessionId);
  if (!session || session.status !== 'active') {
    return { accepted: false, reason: 'no-active-session' };
  }

  // Defense in depth: the gateway already refuses to subscribe to an opted-out/blocked
  // speaker's audio stream in the first place (gateway/voice/scribe-session.ts), so this
  // should never actually trigger — but a speaker opting out mid-call shouldn't depend on
  // that cache alone catching it before the gateway's.
  if (isBlockedUser(input.userId)) {
    return { accepted: false, reason: 'opted-out-or-blocked' };
  }

  if (session.audioSecondsUsed >= scribeMaxAudioSeconds()) {
    if (!session.capped) markScribeSessionCapped(input.sessionId);
    return { accepted: false, reason: 'audio-cap-reached' };
  }

  let text: string;
  const model = scribeSttModel();
  try {
    const result = await transcribeWav(Buffer.from(input.wavBase64, 'base64'), { model });
    text = result.text;
  } catch (error) {
    logger.warn(`🎙️ Scribe STT failed for session ${input.sessionId}:`, getErrorMessage(error));
    return { accepted: false, reason: 'stt-failed' };
  }

  const costUsd = computeSttCostUsd(input.durationSeconds, model);
  addScribeUsage(input.sessionId, input.durationSeconds, costUsd);
  await UsageTracker.recordUsage({
    model_name: model,
    user_id: session.startedBy,
    message_id: input.sessionId,
    input_length: 0,
    output_length: text.length,
    response_time_ms: 0,
    capabilities_detected: 0,
    capabilities_executed: 0,
    capability_types: '',
    success: true,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    estimated_cost: costUsd,
    guild_id: session.guildId,
    step_type: 'scribe_stt',
  });

  if (text.length === 0) {
    return { accepted: true, text: '' };
  }

  appendScribeUtterance({
    sessionId: input.sessionId,
    speakerId: input.userId,
    displayName: input.displayName,
    text,
    ts: input.startedAt,
    durationSeconds: input.durationSeconds,
  });
  return { accepted: true, text };
}

export interface StopScribeSessionResult {
  pendingCount: number;
  textChannelId: string;
  capped: boolean;
  posted: boolean;
}

export async function stopScribeSession(
  sessionId: string,
  stopReason: string
): Promise<StopScribeSessionResult> {
  const session = getScribeSession(sessionId);
  if (!session) {
    throw new Error(`No scribe session ${sessionId}`);
  }

  const utterances = listScribeUtterances(sessionId);
  const defaultRepo = defaultScribeRepo(session.guildId) ?? 'room302studio/coachartie2';

  let summaryText: string;
  let pendingIds: number[] = [];
  const summaryOnly = summaryOnlySessions.delete(sessionId);
  try {
    const { summaryText: text, proposals } = await generateScribeSummary({
      withProposals: !summaryOnly,
      sessionId,
      userId: session.startedBy,
      guildId: session.guildId,
      defaultRepo,
      utterances,
    });
    summaryText = text;

    if (proposals.length > 0 && !summaryOnly) {
      const outcomes = await submitScribeProposals(proposals, {
        userId: OWNER_USER_ID,
        guildId: session.guildId,
        channelId: session.textChannelId,
      });
      pendingIds = outcomes.map((o) => o.pendingId).filter((id): id is number => id !== null);
    }
  } catch (error) {
    logger.error(`📝 Scribe summary failed for session ${sessionId}:`, getErrorMessage(error));
    summaryText = `Meeting ended, but the summary call failed (${getErrorMessage(error)}). The raw transcript (${utterances.length} line(s)) is still saved for ${scribeRetentionDays()} days.`;
  }

  finishScribeSession(sessionId, {
    summary: summaryText,
    pendingActionIds: pendingIds,
    stopReason,
  });

  let cappedNote = '';
  if (session.capped) {
    cappedNote = `\n\n⚠️ Hit the ${Math.round(scribeMaxAudioSeconds() / 60)}-minute audio cap partway through — later utterances weren't transcribed.`;
  }
  let approvalsNote = '';
  if (pendingIds.length > 0) {
    approvalsNote = `\n\n⏸️ ${pendingIds.length} GitHub action(s) waiting on EJ's approval (#${pendingIds.join(', #')}).`;
  }
  const fullText = `📝 **Scribe summary**\n\n${summaryText}${cappedNote}${approvalsNote}`;

  let posted = false;
  try {
    const result = await sendChunkedChannelMessage(session.textChannelId, fullText);
    posted = result.status < 400;
    if (!posted) {
      logger.warn(`📝 Scribe summary post failed for session ${sessionId}: ${JSON.stringify(result.body)}`);
    }
  } catch (error) {
    logger.error(`📝 Scribe summary post threw for session ${sessionId}:`, getErrorMessage(error));
  }

  return {
    pendingCount: pendingIds.length,
    textChannelId: session.textChannelId,
    capped: session.capped,
    posted,
  };
}

export function getScribeStatus(guildId: string): ScribeSession | null {
  return getActiveScribeSessionForGuild(guildId);
}
