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
    names: ['yellowaquarium'],
  },
];

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
