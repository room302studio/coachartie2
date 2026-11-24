// Hard-banned users: Artie must behave as if they don't exist. Their messages are
// dropped at intake (discord message-handler), stripped from channel-history context,
// excluded from observational learning, and no memories may be formed about them or
// surface in recall. EJ-curated — this is a moderation decision, not heuristics.
//
// Both packages (discord + capabilities) enforce this, which is why it lives in shared:
// the discord package gates intake/context, capabilities gates memory formation/recall.

import { isOptedOut } from './privacy-opt-out.js';
import { escapeRegex } from './regex.js';

interface BlockedUser {
  id: string; // Discord snowflake — immutable, survives renames
  names: string[]; // usernames/display names they're known by, for content matching
  since?: string; // YYYY-MM-DD the ban started, for the on-demand banlist report
}

export const BLOCKED_USERS: BlockedUser[] = [
  // yellowaquarium (id 1064472458448617502) — banned 2026-07-15 for burning credits
  // with hour-long troll spam; served their sentence, unblocked 2026-07-21 as a
  // (nearly) model citizen. Empty list = nobody is invisible and no 💔 reactions fire.
  // rhodie3587: banned 2026-11-18 by EJ after Artie hit his daily cap mid-reply in #prison.
  { id: '929158677133402122', names: ['rhodie3587', 'rhodie'], since: '2026-11-18' },
];

// Fallback label for a banned user with no known name. Naming them is fine; @-pinging
// them is not (EJ 2026-11-19 struck the old "never name them" rule).
export const BLOCKED_USER_EPITHET = 'the banned one';

export const BLOCKED_USER_IDS: ReadonlySet<string> = new Set(BLOCKED_USERS.map((u) => u.id));

// Name matching is deliberately loose (case-insensitive substring): these names only
// appear in Discord-sourced text, and a false positive just means one less memory.
const BLOCKED_NAME_PATTERNS = BLOCKED_USERS.flatMap((u) => u.names.map((n) => n.toLowerCase()));

/**
 * True for anyone Artie must treat as absent from his DATA: EJ's blocklist plus users who
 * opted out themselves (services/privacy-opt-out.ts). Gates intake, history, digests,
 * memory formation and recall. For "banned" treatment specifically (💔, the epithet),
 * check BLOCKED_USER_IDS instead; an opt-out is a choice, not a punishment.
 */
export function isBlockedUser(userId?: string | null): boolean {
  return !!userId && (BLOCKED_USER_IDS.has(userId) || isOptedOut(userId));
}

/**
 * True if the text mentions a blocked user by id or any known name.
 * Used to keep them out of formed memories and recalled context.
 */
export function mentionsBlockedUser(text?: string | null): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    BLOCKED_NAME_PATTERNS.some((name) => lower.includes(name)) ||
    BLOCKED_USERS.some((u) => lower.includes(u.id))
  );
}

/**
 * Turn @-pings of banned users in OUTBOUND text into their plain name, so Artie never
 * pings someone he's ignoring. Naming them is fine (EJ 2026-11-19: "i never told you to
 * never name them"); the old name-to-epithet scrub was removed then. `users` is
 * injectable for tests.
 */
export function scrubBlockedUserMentions(
  text: string,
  users: readonly BlockedUser[] = BLOCKED_USERS
): string {
  if (!text) return text;
  let out = text;
  for (const u of users) {
    // Someone who is banned AND opted out keeps full anonymity: no name, id or ping
    // (Codex 2026-11-19). Opting out is their choice; the ban doesn't override it.
    if (isOptedOut(u.id)) {
      out = out.replace(new RegExp(`<@!?${u.id}>`, 'g'), BLOCKED_USER_EPITHET);
      out = out.replace(new RegExp(u.id, 'g'), BLOCKED_USER_EPITHET);
      for (const name of u.names) {
        out = out.replace(new RegExp(`(?<!\\w)@?${escapeRegex(name)}(?!\\w)`, 'gi'), BLOCKED_USER_EPITHET);
      }
      continue;
    }
    let plain = BLOCKED_USER_EPITHET;
    if (u.names.length > 0) plain = u.names[0];
    // A callback, so a "$&" in a name is inserted literally and can't re-insert the ping.
    out = out.replace(new RegExp(`<@!?${u.id}>`, 'g'), () => plain);
  }
  return out;
}
