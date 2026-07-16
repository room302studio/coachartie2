// Hard-banned users: Artie must behave as if they don't exist. Their messages are
// dropped at intake (discord message-handler), stripped from channel-history context,
// excluded from observational learning, and no memories may be formed about them or
// surface in recall. EJ-curated — this is a moderation decision, not heuristics.
//
// Both packages (discord + capabilities) enforce this, which is why it lives in shared:
// the discord package gates intake/context, capabilities gates memory formation/recall.

export interface BlockedUser {
  id: string; // Discord snowflake — immutable, survives renames
  names: string[]; // usernames/display names they're known by, for content matching
}

export const BLOCKED_USERS: BlockedUser[] = [
  {
    // banned 2026-07-15 for burning credits with hour-long troll spam
    id: '1064472458448617502',
    names: ['yellowaquarium', 'yellow aquarium'],
  },
];

// What Artie calls a blocked user when one comes up. Policy (EJ, 2026-07-16):
// mentioning them is fine, naming or @-pinging them is not.
export const BLOCKED_USER_EPITHET = 'the banned one';

export const BLOCKED_USER_IDS: ReadonlySet<string> = new Set(BLOCKED_USERS.map((u) => u.id));

// Name matching is deliberately loose (case-insensitive substring): these names only
// appear in Discord-sourced text, and a false positive just means one less memory.
const BLOCKED_NAME_PATTERNS = BLOCKED_USERS.flatMap((u) => u.names.map((n) => n.toLowerCase()));

export function isBlockedUser(userId?: string | null): boolean {
  return !!userId && BLOCKED_USER_IDS.has(userId);
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace blocked users' names and @-mentions in OUTBOUND text with a neutral
 * epithet. Referring to them is allowed; naming or pinging them is not. This is
 * the output-side guarantee — names can still reach Artie's context via other
 * people's messages, but they can't leave his mouth.
 */
export function scrubBlockedUserMentions(text: string): string {
  if (!text) return text;
  let out = text;
  for (const u of BLOCKED_USERS) {
    out = out.replace(new RegExp(`<@!?${u.id}>`, 'g'), BLOCKED_USER_EPITHET);
    out = out.replace(new RegExp(u.id, 'g'), BLOCKED_USER_EPITHET);
    for (const name of u.names) {
      // "@name" and possessives read fine after replacement ("the banned one's")
      out = out.replace(new RegExp(`@?${escapeRegex(name)}`, 'gi'), BLOCKED_USER_EPITHET);
    }
  }
  return out;
}
