/**
 * Pure constants and decision functions for scribe mode's timing rules — split out from
 * scribe-session.ts (which wires these to real discord.js/@discordjs/voice objects) so the
 * rules themselves are testable with plain data and vitest's fake timers, no Discord mocking
 * required.
 */

/** @discordjs/voice's EndBehaviorType.AfterSilence duration: cut an utterance after this much
 *  silence from that speaker. */
export const SILENCE_MS = 1000;

/** Utterances shorter than this are dropped before they're ever sent to STT — breath sounds,
 *  "um", a mic bump. */
export const MIN_UTTERANCE_SECONDS = 0.6;

/** Auto-stop: once the voice channel has had zero non-bot humans for this long. */
export const NO_HUMAN_TIMEOUT_MS = 2 * 60 * 1000;

/** Auto-stop: hard cap on a single session's wall-clock length, regardless of activity. */
export const HARD_CAP_MS = 2 * 60 * 60 * 1000;

export function isUtteranceLongEnough(
  durationSeconds: number,
  minSeconds: number = MIN_UTTERANCE_SECONDS
): boolean {
  return durationSeconds >= minSeconds;
}

export function hasHardCapElapsed(
  startedAtMs: number,
  nowMs: number,
  capMs: number = HARD_CAP_MS
): boolean {
  return nowMs - startedAtMs >= capMs;
}

/** Non-bot member count from anything shaped like a discord.js member collection — kept as a
 *  plain array of `{ user: { bot: boolean } }` so a test can pass plain objects. */
export function countNonBotMembers(members: Iterable<{ user: { bot: boolean } }>): number {
  let count = 0;
  for (const member of members) {
    if (!member.user.bot) count++;
  }
  return count;
}
