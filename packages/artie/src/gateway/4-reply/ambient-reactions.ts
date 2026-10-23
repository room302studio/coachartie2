/**
 * Ambient reactions: a cheap emoji instead of words. The rare ambient reaction to ordinary
 * chatter, and the rate-limited 💔 a blocked user gets. No LLM call, no tokens. Moved
 * verbatim out of on-message.ts (wave 5).
 */

import type { Message } from 'discord.js';
import Chance from 'chance';
import { logger } from '../../shared/logger.js';
import { getSyncDb } from '../../shared/db/client.js';
import { checkOutbound } from './outbound-gate.js';

const chance = new Chance();

// Blocked users get a 💔 instead of words. Words cost credits — the exact thing that got them
// banned — but a reaction is free, and it reads as "I see you, and no" rather than a void the
// troll can keep poking. Per-user cooldown so the heartbreak can't itself be farmed: spam
// forty messages, get one 💔. Keyed by author id (the immutable snowflake), so renames don't
// reset it.
const BLOCKED_REACTION = '💔';
const BLOCKED_REACTION_COOLDOWN_MS = 5 * 60 * 1000;
const lastBlockedReactionAt = new Map<string, number>();

/**
 * The 💔 for a hard-banned user (on-message's blocked-user step). Only in coach-artie
 * places, and at most one per user per cooldown.
 */
export function reactToBlockedUser(message: Message): void {
  const now = Date.now();
  const lastReaction = lastBlockedReactionAt.get(message.author.id) ?? 0;
  if (
    checkOutbound('reaction', message).allowed &&
    now - lastReaction >= BLOCKED_REACTION_COOLDOWN_MS
  ) {
    // Stamp before awaiting: a burst of spam arrives faster than the API round-trip, and
    // an unstamped window would let the whole burst through the cooldown check at once.
    lastBlockedReactionAt.set(message.author.id, now);
    message
      .react(BLOCKED_REACTION)
      .catch((err) => logger.debug(`Failed to 💔 blocked user ${message.author.tag}:`, err));
  }
}

// Ambient reactions: Artie sometimes just reacts to a message instead of staying silent.
// Free (no LLM call, no tokens) and it makes him feel present in a channel without him
// barging into conversations he wasn't invited to — the exact thing we spent a week making
// him stop doing. The whole point is that it's RARE: the wrong emoji on the right message is
// only funny because he doesn't do it every time. Roll the dice, mostly lose.
const AMBIENT_REACTION_LIKELIHOOD = parseInt(process.env.AMBIENT_REACTION_LIKELIHOOD || '4'); // percent
const AMBIENT_REACTION_COOLDOWN_MS = parseInt(
  process.env.AMBIENT_REACTION_COOLDOWN_MS || '90000'
); // per channel
const AMBIENT_REACTION_MIN_WORDS = 4; // one-word chatter isn't worth a reaction
const lastAmbientReactionAt = new Map<string, number>();

// Artie's emoji vocabulary is CONTENT, not code: it lives in the prompts table under
// AMBIENT_REACTION_EMOJI (whitespace-separated), so retuning what he's allowed to say costs
// a sqlite UPDATE instead of a build + deploy + restart. Same rule as PROMPT_SYSTEM — if
// you're about to paste personality into a .ts file, it belongs in the DB instead.
// Cached 30s to match promptManager, so an edit shows up within half a minute.
const AMBIENT_EMOJI_PROMPT = 'AMBIENT_REACTION_EMOJI';
const EMOJI_CACHE_MS = 30_000;
let emojiCache: { at: number; emoji: string[] } | null = null;
let warnedNoPalette = false;

function getAmbientEmoji(): string[] {
  const now = Date.now();
  if (emojiCache && now - emojiCache.at < EMOJI_CACHE_MS) {
    return emojiCache.emoji;
  }
  try {
    const row = getSyncDb().get<{ content?: string }>(
      `SELECT content FROM prompts WHERE name = ? AND is_active = 1`,
      [AMBIENT_EMOJI_PROMPT]
    );
    const emoji = (row?.content ?? '').split(/\s+/).filter(Boolean);
    emojiCache = { at: now, emoji };
    // No palette means the feature is silently off, which is exactly the kind of quiet
    // nothing that took hours to find last time. Say it out loud, once.
    if (emoji.length === 0 && !warnedNoPalette) {
      warnedNoPalette = true;
      logger.warn(
        `No ${AMBIENT_EMOJI_PROMPT} palette in the prompts table — ambient reactions are OFF. ` +
          `Add a row with whitespace-separated emoji to turn them back on.`
      );
    }
    return emoji;
  } catch (err) {
    logger.warn('Could not read ambient emoji palette:', err);
    return [];
  }
}

/**
 * Roll for an ambient reaction. Per-CHANNEL cooldown (not per-user): the spam risk is a
 * channel full of emoji, and one busy user shouldn't be able to soak up every roll.
 */
export function maybeAmbientReact(message: Message): void {
  // Structural channel check — do NOT rely on this being called below the gate in
  // the handler; ordering is exactly what broke twice. (Routine denial, no log.)
  if (!checkOutbound('reaction', message).allowed) return;
  if (message.author.bot) return;
  if (message.content.trim().split(/\s+/).length < AMBIENT_REACTION_MIN_WORDS) return;

  const now = Date.now();
  const last = lastAmbientReactionAt.get(message.channelId) ?? 0;
  if (now - last < AMBIENT_REACTION_COOLDOWN_MS) return;
  if (!chance.bool({ likelihood: AMBIENT_REACTION_LIKELIHOOD })) return;

  const palette = getAmbientEmoji();
  if (palette.length === 0) return;

  // Stamp before the await so a burst can't slip several reactions through at once.
  lastAmbientReactionAt.set(message.channelId, now);
  message
    .react(chance.pickone(palette))
    .catch((err) => logger.debug('Ambient reaction failed:', err));
}
