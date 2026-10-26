import { IncomingMessage } from '../../shared/queue/types.js';
import { logger } from '../../shared/logger.js';
import { capabilityRegistry } from '../5-tool-loop/registry.js';

/**
 * Turn fast paths that run beside the generate → tool-loop spine in run-turn.ts:
 * the voice-note TTS fast path (before the turn) and the periodic direct credit_status
 * check (after it). Moved verbatim out of run-turn.ts (was process-message) in wave 6.
 */

/**
 * VOICE-NOTE FAST PATH: a budget model (brownout Haiku) rationalizes its way
 * out of calling the tts capability ("I don't have the channel ID") no matter
 * how the prompt is worded. When someone plainly asks for a voice note, just
 * DO it — we hold the real channelId here, so there's nothing to reason about.
 *
 * Returns the short text ack when the fast path handled the turn, or null to fall
 * through to normal orchestration (no ask, no channel, or the tts call failed).
 */
export async function tryVoiceNoteFastPath(message: IncomingMessage): Promise<string | null> {
  const voiceNote = detectVoiceNoteRequest(message);
  if (voiceNote) {
    const channelId = (message.context as { channelId?: string } | undefined)?.channelId;
    const guildId = (message.context as { guildId?: string } | undefined)?.guildId;
    if (channelId) {
      logger.info(`🎙️ Voice-note fast path (${voiceNote.action}) for message ${message.id}`);
      try {
        const params: Record<string, any> = {
          channelId,
          guildId,
          userId: message.userId,
        };
        if (voiceNote.text) {
          params.text = voiceNote.text;
        }
        if (voiceNote.voice) {
          params.voice = voiceNote.voice;
        }
        const result = await capabilityRegistry.execute('tts', voiceNote.action, params);
        logger.info(`🎙️ Voice-note fast path result: ${result.slice(0, 120)}`);
        // The audio IS the reply. Short text ack, no [SILENT] (that would delete nothing).
        let ack: string;
        if (voiceNote.action === 'vibe_report') {
          ack = '🎙️ dropping a vibe report.';
        } else {
          ack = '🎙️ on it.';
        }
        return ack;
      } catch (err) {
        logger.warn(`🎙️ Voice-note fast path failed, falling back to orchestration:`, err);
        // fall through to normal orchestration
      }
    }
  }
  return null;
}

/**
 * Every AUTO_CHECK_CREDITS_EVERY messages (default 50), run credit_status:check_balance
 * directly and log the result. Never throws.
 */
export async function maybeAutoCheckCredits(messageCount: number): Promise<void> {
  // Check if we should auto-check credits
  const autoCheckEvery = parseInt(process.env.AUTO_CHECK_CREDITS_EVERY || '50');
  if (autoCheckEvery > 0 && messageCount % autoCheckEvery === 0) {
    logger.info(`📊 Auto-checking credits (message ${messageCount}/${autoCheckEvery})`);

    try {
      const creditStatus = await capabilityRegistry.execute(
        'credit_status',
        'check_balance',
        {}
      );
      logger.info(`💰 Auto Credit Check:\n${creditStatus}`);

      // Parse and check for critical alerts
      try {
        const statusData = JSON.parse(creditStatus);
        if (statusData.data?.active_alerts > 0) {
          logger.warn(`🚨 ${statusData.data.active_alerts} active credit alerts detected!`);
        }
      } catch (_e) {
        // Ignore parse errors
      }
    } catch (error) {
      logger.error('Failed to auto-check credits:', error);
    }
  }
}

/**
 * Detect an explicit request for a voice note / vibe report, so the fast path can
 * honor it deterministically instead of relying on a budget model to call the tool.
 * Deliberately tight — only fires on a clear ask, not any mention of "voice".
 */
function detectVoiceNoteRequest(
  message: IncomingMessage
): { action: 'vibe_report' | 'speak'; text?: string; voice?: string } | null {
  const raw = (message.message || '').trim();
  if (!raw) return null;
  const t = raw.toLowerCase();

  // Must read as a request (asking/telling), not just a topic mention.
  const asky = /\b(make|do|give|drop|send|record|cut|can you|could you|would you|please|lets|let'?s|gimme|gib|i want|we want|need)\b/.test(t);

  const vibeReport = /\bvibe\s?report\b|\bvibe\s?check\b|\bradio\s?(bit|report|show|hour)\b|\bnews\s?(bit|report|bulletin|broadcast)\b|\bthe\s?tapes?\b/.test(t);
  const genericVoiceNote = /\bvoice\s?(note|memo|message|report)\b|\bsay it out loud\b|\bread .* (out loud|aloud)\b|\bspeak it\b|\btalk to us\b/.test(t);

  if (!(vibeReport || genericVoiceNote)) return null;
  // A bare mention with no ask verb is too weak — skip (avoid false positives like
  // "that voice note earlier was funny").
  if (!asky && !vibeReport) return null;

  // Optional voice steer, e.g. "in the anchor voice" / "as the anchor".
  const voiceMatch = t.match(/\b(?:in|as|with|using)\s+(?:the\s+)?(artie|anchor|dj|poetic|field|dispatch|robot|rookie|caller)\b(?:\s+voice)?/);
  const voice = voiceMatch?.[1];

  // "say '<text>'" / 'read this out loud: <text>' → speak the given words.
  const speakMatch =
    raw.match(/\bsay\s+["“]([^"”]{2,})["”]/i) ||
    raw.match(/\b(?:read|speak)(?: this)?(?: out loud| aloud)?:\s*(.+)$/i);
  if (speakMatch && speakMatch[1] && !vibeReport) {
    return { action: 'speak', text: speakMatch[1].trim(), voice };
  }

  return { action: 'vibe_report', voice };
}
