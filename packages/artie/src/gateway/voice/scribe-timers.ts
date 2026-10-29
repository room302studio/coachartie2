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
 *  plain array of `{ user: { bot: boolean } }` so a test can pass plain objects.
 *  SCRIBE_COUNT_AS_HUMAN_IDS (comma-separated user ids) counts those bots as people: the hook
 *  that lets a test-speaker bot drive an end-to-end scribe test (join, transcribe, leave). */
export function countNonBotMembers(
  members: Iterable<{ id?: string; user: { bot: boolean; id?: string } }>,
  env: NodeJS.ProcessEnv = process.env
): number {
  const asHuman = new Set(
    (env.SCRIBE_COUNT_AS_HUMAN_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  let count = 0;
  for (const member of members) {
    const id = member.user.id ?? member.id;
    if (!member.user.bot || (id !== undefined && asHuman.has(id))) count++;
  }
  return count;
}

export interface NoHumanStepInput {
  /** When the channel last had zero non-bot humans, or null if it currently has some (or the
   *  countdown hasn't started). */
  noHumanSince: number | null;
  humanCount: number;
  nowMs: number;
  timeoutMs?: number;
}

export interface NoHumanStepResult {
  /** The new value to store back on the session. */
  noHumanSince: number | null;
  /** True once zero-humans has held for `timeoutMs` — the caller should stop the session. */
  shouldStop: boolean;
}

/**
 * The "no humans left for 2 minutes" auto-stop rule, as a pure state transition — called by
 * scribe-session.ts's tick() with real data, and directly by tests with plain numbers (no
 * discord.js/timer mocking needed to exercise the 2-minute countdown itself).
 */
export function noHumanStep(input: NoHumanStepInput): NoHumanStepResult {
  const timeoutMs = input.timeoutMs ?? NO_HUMAN_TIMEOUT_MS;
  if (input.humanCount > 0) {
    return { noHumanSince: null, shouldStop: false };
  }
  if (input.noHumanSince === null) {
    return { noHumanSince: input.nowMs, shouldStop: false };
  }
  const shouldStop = input.nowMs - input.noHumanSince >= timeoutMs;
  return { noHumanSince: input.noHumanSince, shouldStop };
}
