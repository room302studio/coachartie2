import { logger } from '@coachartie/shared';
import type { Message } from 'discord.js';

/**
 * SPEAK GATE (#88 / #89) — who is allowed to wake the expensive persona model.
 *
 * Opus runs only when Artie was addressed: @mentioned, replied to, or DMed. Anything else that
 * the existing routing would have answered unprompted (a proactive answer, a respondToAll
 * persona, the strike-lift bit) must first get a YES from the cheap pre-generation judgment,
 * and if that judgment errors the answer is NO. "When in doubt, stay quiet" — the standing
 * constraint from #97: fewer, better-timed messages, never a more talkative bot.
 *
 * Per guild: GuildConfig.ambientMode — 'gated' (default everywhere) or 'never' (strictly
 * mention/reply/DM; the cheap gate isn't even consulted).
 */

export type AmbientMode = 'gated' | 'never';

export interface SpeakInputs {
  botMentioned: boolean;
  repliedToBot: boolean;
  /** DM that passed the pairing/policy check. */
  isDMAllowed: boolean;
  /** The pre-existing routing would speak unprompted (after channel whitelist + ambient budget). */
  ambientCandidate: boolean;
  /** The cheap judgment already ran for this message and said yes (proactive-answer path). */
  gateAlreadyPassed: boolean;
  ambientMode: AmbientMode;
}

export type SpeakRoute =
  | { route: 'addressed' }
  | { route: 'ambient-approved' }
  | { route: 'gate' }
  | { route: 'silent'; reason: string };

export function decideSpeakRoute(i: SpeakInputs): SpeakRoute {
  if (i.botMentioned || i.repliedToBot || i.isDMAllowed) return { route: 'addressed' };
  if (!i.ambientCandidate) return { route: 'silent', reason: 'not addressed' };
  if (i.ambientMode === 'never') return { route: 'silent', reason: 'guild is mention/reply/DM only' };
  if (i.gateAlreadyPassed) return { route: 'ambient-approved' };
  return { route: 'gate' };
}

/** Run the cheap judgment. Any error, timeout or non-boolean answer means: don't speak. */
export async function runSpeakGate(
  judge: () => Promise<boolean>,
  timeoutMs = 15_000
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const verdict = await Promise.race([
      judge(),
      new Promise<boolean>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`speak gate timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return verdict === true;
  } catch (error) {
    logger.warn('🤐 Speak gate failed — defaulting to silent:', error);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function resolveAmbientMode(config: { ambientMode?: AmbientMode } | null | undefined): AmbientMode {
  return config?.ambientMode === 'never' ? 'never' : 'gated';
}

/**
 * Is this a Discord reply to one of Artie's messages? discord.js fills mentions.repliedUser
 * from the referenced message's author whether or not the reply pinged — mentions.has() only
 * sees the pinged case, which is why a no-ping reply to Artie used to count as ambient.
 */
export async function isReplyToBot(message: Message, botId: string): Promise<boolean> {
  if (!message.reference?.messageId) return false;
  if (message.mentions.repliedUser) return message.mentions.repliedUser.id === botId;
  try {
    const referenced = await message.fetchReference();
    return referenced.author.id === botId;
  } catch {
    return false; // deleted or inaccessible — not provably to us, so not addressed
  }
}
