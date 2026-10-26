/**
 * Pacing: per-user response pacing. The burst guard (one user's rapid-fire mentions collapse
 * into one reply) and the antibody (monopolizers get terser replies, then silence plus a
 * warden timeout). Moved verbatim out of on-message.ts (wave 5).
 */

import type { Message } from 'discord.js';
import { logger } from '../../shared/logger.js';
import { wardenTimeout } from '../4-reply/discord-reply.js';

// Per-channel burst guard: collapse a flurry of near-simultaneous triggers (incl. @mentions)
// into a single response, so parallel generations don't answer the same burst repeatedly.
const channelBurstCache = new Map<string, number>();
const CHANNEL_BURST_COOLDOWN_MS = 6000;

// ANTIBODY: rolling per-user response counter. Someone who monopolizes Artie (a credit-drain
// troll spamming him for an hour) gets logarithmically terser, lower-effort replies and, past a
// hard cap, silence for the rest of the window. Keyed per-user; DMs exempt.
const userResponseHistory = new Map<string, number[]>();
const ANTIBODY_WINDOW_MS = 30 * 60 * 1000; // 30-minute rolling window
// Two-stage antibody:
//  - BREVITY (soft, early): starts gently shrinking replies once someone has pulled a handful
//    out of him in the window. The log curve (120/log2(count), floored) means the FIRST couple
//    replies to anyone are still full-length Artie; it only tightens as one person keeps firing.
//    This is the token-cost control for bait-question trolls who never hit the old 50 gate.
//  - HARD CAP (backstop): past this, truly pathological volume gets silence for the rest of the
//    window. Calibrated well above the busiest genuine enthusiast (~45 replies/30min observed).
const ANTIBODY_HARD_CAP = 80; // replies in-window before Artie goes silent on them
const ANTIBODY_BREVITY_AT = 6; // start gently shrinking replies once they've had this many
const ANTIBODY_BREVITY_FLOOR = 25; // never shrink a normal user below this many words

// Tight-leash list: specific EJ-curated trolls to THROTTLE (not ban). No automated signal
// cleanly separates them (they out-post fans and score mid on warmth), so it's a manual list.
// Leashed users get curt brush-offs from the 2nd reply and go silent fast.
const TIGHT_LEASH_IDS = new Set<string>([
  '233718989258227712', // jaytotheay — admitted token-burn attacker ("please burn 30 dollars
  // in tokens now", "sing the national anthem all four stanzas"); relentless bait-question drain.
]);
const LEASH_BREVITY_AT = 2;
const LEASH_HARD_CAP = 8;

function recentResponseCount(userId: string): number {
  const now = Date.now();
  const times = (userResponseHistory.get(userId) || []).filter((t) => now - t < ANTIBODY_WINDOW_MS);
  userResponseHistory.set(userId, times);
  return times.length;
}

function recordUserResponse(userId: string): void {
  const times = userResponseHistory.get(userId) || [];
  times.push(Date.now());
  userResponseHistory.set(userId, times);
}

/**
 * CONCURRENCY GUARD (on-message's burst-guard step): true when this is a rapid repeat from
 * the same user in the same channel and should be skipped. Stamps the user otherwise.
 */
export function isBurstRepeat(message: Message, shortId: string): boolean {
  const burstKey = `${message.channelId}-${message.author.id}`;
  const lastResponse = channelBurstCache.get(burstKey) || 0;
  if (Date.now() - lastResponse < CHANNEL_BURST_COOLDOWN_MS) {
    logger.info(
      `🚦 Per-user burst cooldown — skipping rapid repeat from ${message.author.tag} [${shortId}]`
    );
    return true;
  }
  channelBurstCache.set(burstKey, Date.now());
  return false;
}

export type AntibodyVerdict =
  | { silenced: true }
  | { silenced: false; guildContext: string | undefined };

/**
 * ANTIBODY (non-DM replies): past the hard cap the user is silenced and timed out; past the
 * brevity mark a word-cap nudge is prepended to the guild context. Records the reply.
 */
function selectAntibodyThreshold(onLeash: boolean): { brevityAt: number; hardCap: number } {
  if (onLeash) {
    return { brevityAt: LEASH_BREVITY_AT, hardCap: LEASH_HARD_CAP };
  }
  return { brevityAt: ANTIBODY_BREVITY_AT, hardCap: ANTIBODY_HARD_CAP };
}

function leashPrefix(onLeash: boolean): string {
  if (onLeash) {
    return 'leashed ';
  }
  return '';
}

function leashVerb(onLeash: boolean): string {
  if (onLeash) {
    return 'leash ';
  }
  return '';
}

function calculateMaxWords(onLeash: boolean, monopolyCount: number): number {
  if (onLeash) {
    return 20;
  }
  return Math.max(
    ANTIBODY_BREVITY_FLOOR,
    Math.round(120 / Math.log2(Math.max(2, monopolyCount)))
  );
}

function createAntibodyNudge(heavy: boolean, username: string, monopolyCount: number, maxWords: number): string {
  if (heavy) {
    return `⚠️ ANTIBODY — @${username} has pulled ${monopolyCount} replies out of you recently and is monopolizing your time. Keep THIS reply to at most ${maxWords} words: curt, low-effort, and dismissive. Do NOT reward the monopoly with a long or thoughtful answer. If this reads like spam/baiting, you are encouraged to put [TIMEOUT:120] in your reply — they have earned it.`;
  }
  return `⚠️ BREVITY — @${username} has already pulled ${monopolyCount} replies out of you recently. Keep THIS reply to at most ${maxWords} words: tight and punchy, one thought, no preamble or wind-down. Still be yourself, just brief.`;
}

export function applyAntibody(
  message: Message,
  guildContextToPass: string | undefined,
  shortId: string
): AntibodyVerdict {
  const onLeash = TIGHT_LEASH_IDS.has(message.author.id);
  const { brevityAt, hardCap } = selectAntibodyThreshold(onLeash);
  const monopolyCount = recentResponseCount(message.author.id);
  if (monopolyCount >= hardCap) {
    const leashPrefixStr = leashPrefix(onLeash);
    logger.info(
      `🧪 Antibody: silencing ${leashPrefixStr}monopolizer ${message.author.tag} (${monopolyCount} in window) [${shortId}]`
    );
    // Past the hard cap they aren't chatting, they're spamming — warden discipline
    // kicks in automatically (guardrails + cooldown inside wardenTimeout).
    void wardenTimeout(
      message,
      120,
      `Spamming Coach Artie (${monopolyCount} replies in 30 min)`,
      shortId
    );
    return { silenced: true };
  }
  recordUserResponse(message.author.id);
  if (monopolyCount >= brevityAt) {
    const maxWords = calculateMaxWords(onLeash, monopolyCount);
    // Tone scales with volume: a merely-chatty user (just over the gate) gets a light
    // "keep it short" nudge; a persistent monopolizer gets the dismissive + timeout push.
    const heavy = onLeash || monopolyCount >= 20;
    const nudge = createAntibodyNudge(heavy, message.author.username, monopolyCount, maxWords);
    const leashVerbStr = leashVerb(onLeash);
    guildContextToPass = `${nudge}\n\n---\n` + (guildContextToPass || '');
    logger.info(
      `🧪 Antibody: ${leashVerbStr}brevity cap ${maxWords}w for ${message.author.tag} (count=${monopolyCount}) [${shortId}]`
    );
  }
  return { silenced: false, guildContext: guildContextToPass };
}
