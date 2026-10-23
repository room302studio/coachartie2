// Hard-banned users: Artie must behave as if they don't exist. Their messages are
// dropped at intake (discord message-handler), stripped from channel-history context,
// excluded from observational learning, and no memories may be formed about them or
// surface in recall. EJ-curated — this is a moderation decision, not heuristics.
//
// Both packages (discord + capabilities) enforce this, which is why it lives in shared:
// the discord package gates intake/context, capabilities gates memory formation/recall.

import { isOptedOut } from './privacy-opt-out.js';
import { escapeRegex } from './regex.js';

export interface BlockedUser {
  id: string; // Discord snowflake — immutable, survives renames
  names: string[]; // usernames/display names they're known by, for content matching
}

export const BLOCKED_USERS: BlockedUser[] = [
  // yellowaquarium (id 1064472458448617502) — banned 2026-07-15 for burning credits
  // with hour-long troll spam; served their sentence, unblocked 2026-07-21 as a
  // (nearly) model citizen. Empty list = nobody is invisible and no 💔 reactions fire.
];

// What Artie calls a blocked user when one comes up. Policy (EJ, 2026-07-16):
// mentioning them is fine, naming or @-pinging them is not.
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
 * Replace blocked users' names and @-mentions in OUTBOUND text with a neutral
 * epithet. Referring to them is allowed; naming or pinging them is not. This is
 * the output-side guarantee — names can still reach Artie's context via other
 * people's messages, but they can't leave his mouth.
 *
 * Names match as whole words (ledger #4): a short blocked name inside a longer word
 * ("kai" in "kaiser") is left alone. Lookarounds rather than \b, so a name that starts
 * or ends with punctuation still matches. `users` is injectable for tests.
 */
export function scrubBlockedUserMentions(
  text: string,
  users: readonly BlockedUser[] = BLOCKED_USERS
): string {
  if (!text) return text;
  let out = text;
  for (const u of users) {
    out = out.replace(new RegExp(`<@!?${u.id}>`, 'g'), BLOCKED_USER_EPITHET);
    out = out.replace(new RegExp(u.id, 'g'), BLOCKED_USER_EPITHET);
    for (const name of u.names) {
      // "@name" and possessives read fine after replacement ("the banned one's")
      out = out.replace(
        new RegExp(`(?<!\\w)@?${escapeRegex(name)}(?!\\w)`, 'gi'),
        BLOCKED_USER_EPITHET
      );
    }
  }
  return out;
}
