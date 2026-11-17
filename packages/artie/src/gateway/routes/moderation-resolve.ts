/**
 * Pure logic for the moderation routes: who is meant, whether the bot may act on them, and
 * what a Discord failure means in plain words. No discord.js, no I/O, so it is unit-tested
 * over plain objects (tests/gateway/moderation-resolve.test.ts).
 *
 * Why: 2026-10-30 Artie was asked to time out "salty pancakes" and got back
 * { success:false, error:"Timeout failed" } with no cause. Every failure now names its cause.
 */

export const MIN_TIMEOUT_MINUTES = 1;
export const MAX_TIMEOUT_MINUTES = 60;
export const MAX_CANDIDATES_LISTED = 5;

/** The names a guild member can be known by. */
export interface MemberCandidate {
  id: string;
  username?: string | null;
  globalName?: string | null;
  nickname?: string | null;
}

export type UserRef = { kind: 'id'; id: string } | { kind: 'name'; name: string } | { kind: 'empty' };

/** A snowflake, <@id>, <@!id>, or a name (leading @ stripped). */
export function parseUserRef(raw: unknown): UserRef {
  const text = String(raw ?? '').trim();
  if (!text) return { kind: 'empty' };
  const mention = text.match(/^<@!?(\d{15,21})>$/);
  if (mention) return { kind: 'id', id: mention[1] };
  const bare = text.match(/^(\d{15,21})$/);
  if (bare) return { kind: 'id', id: bare[1] };
  const name = text.replace(/^@/, '').trim();
  if (!name) return { kind: 'empty' };
  return { kind: 'name', name };
}

function norm(s: string | null | undefined): string {
  return (s || '').trim().toLowerCase();
}

/**
 * One entry per member id, LAST one wins: callers append fresher sources (REST search, recent
 * messages) after the cache, so a renamed member is judged by their current names, not a stale
 * cached snapshot (Codex).
 */
function dedupe(list: MemberCandidate[]): MemberCandidate[] {
  const byId = new Map<string, MemberCandidate>();
  for (const c of list) {
    byId.delete(c.id);
    byId.set(c.id, c);
  }
  return [...byId.values()];
}

/** "name (aka nick) [id]" for an error message the model can relay. */
export function describeCandidate(c: MemberCandidate): string {
  const names = [c.username, c.globalName, c.nickname]
    .map((n) => (n || '').trim())
    .filter((n, i, all) => n && all.indexOf(n) === i);
  let label = 'unknown';
  if (names.length) label = names.join(' / ');
  return `${label} (id ${c.id})`;
}

function listCandidates(list: MemberCandidate[]): string {
  const shown = list.slice(0, MAX_CANDIDATES_LISTED).map(describeCandidate).join('; ');
  if (list.length > MAX_CANDIDATES_LISTED) {
    return `${shown}; and ${list.length - MAX_CANDIDATES_LISTED} more`;
  }
  return shown;
}

export type ResolveResult =
  | { ok: true; id: string }
  | {
      ok: false;
      reason: 'empty' | 'not_found' | 'ambiguous' | 'uncertain';
      status: number;
      error: string;
      candidates?: MemberCandidate[];
    };

/**
 * A name match only counts when the member search was complete. If the REST search failed or
 * hit its result cap, an unseen second member with the same name could exist, and moderation
 * must not pick the cached one (Codex). Then the caller has to name them exactly.
 */
export function requireCompleteSearch(result: ResolveResult, searchComplete: boolean, name: string): ResolveResult {
  if (!result.ok || searchComplete) return result;
  return {
    ok: false,
    reason: 'uncertain',
    status: 409,
    error:
      `I couldn't confirm "${name}" is the only member with that name (the member search ` +
      `failed or was cut off). Use their @mention or user id so I act on the right person.`,
  };
}

/**
 * Resolve a name against a candidate list. Exact, case-insensitive match on username,
 * globalName or nickname. One hit: use it. Several: fail and list them. None: say so, with
 * partial matches as hints when there are any.
 */
export function resolveByName(name: string, candidates: MemberCandidate[]): ResolveResult {
  const wanted = norm(name.replace(/^@/, ''));
  const all = dedupe(candidates);
  const exact = all.filter((c) => [c.username, c.globalName, c.nickname].some((n) => norm(n) === wanted));
  if (exact.length === 1) return { ok: true, id: exact[0].id };
  if (exact.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      status: 409,
      candidates: exact,
      error:
        `"${name}" matches ${exact.length} members: ${listCandidates(exact)}. ` +
        'Ask which one is meant, then retry with the id.',
    };
  }
  const similar = all.filter((c) =>
    [c.username, c.globalName, c.nickname].some((n) => {
      const v = norm(n);
      return v && wanted && (v.includes(wanted) || wanted.includes(v));
    })
  );
  let hint = '';
  if (similar.length) {
    hint = ` Closest members: ${listCandidates(similar)}. Retry with the exact name or id.`;
  }
  return {
    ok: false,
    reason: 'not_found',
    status: 404,
    candidates: similar,
    error: `No member named "${name}" (checked usernames, display names and nicknames) in this server.${hint}`,
  };
}

/** Full resolution of a raw reference. Ids and mentions pass straight through. */
export function resolveUserRef(raw: unknown, candidates: MemberCandidate[]): ResolveResult {
  const ref = parseUserRef(raw);
  if (ref.kind === 'empty') {
    return { ok: false, reason: 'empty', status: 400, error: 'No user given: pass user as an id, @mention, username or display name.' };
  }
  if (ref.kind === 'id') return { ok: true, id: ref.id };
  return resolveByName(ref.name, candidates);
}

/** Timeout length: whole minutes, 1-60. Never silently clamped, so the answer matches the action. */
export function parseTimeoutMinutes(
  raw: unknown
): { ok: true; minutes: number } | { ok: false; status: number; error: string } {
  const n = Number(raw);
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(n)) {
    return { ok: false, status: 400, error: `durationMinutes must be a number from ${MIN_TIMEOUT_MINUTES} to ${MAX_TIMEOUT_MINUTES} (got "${String(raw ?? '')}").` };
  }
  if (n < MIN_TIMEOUT_MINUTES || n > MAX_TIMEOUT_MINUTES) {
    return {
      ok: false,
      status: 400,
      error: `Duration out of range: ${n} minutes. Artie's timeouts are ${MIN_TIMEOUT_MINUTES}-${MAX_TIMEOUT_MINUTES} minutes; escalate to a human mod for longer.`,
    };
  }
  return { ok: true, minutes: Math.round(n) };
}

/**
 * Facts about the situation. Anything undefined is "unknown" and never blocks, so a partial
 * picture (or a test double) cannot invent a refusal.
 */
export interface PreflightFacts {
  action: 'timeout' | 'role';
  targetName: string;
  targetIsOwner?: boolean;
  targetIsAdministrator?: boolean;
  botHasPermission?: boolean;
  botHighestRolePosition?: number;
  targetHighestRolePosition?: number;
  /** For role actions: the role being added/removed. */
  rolePosition?: number;
  roleName?: string;
}

export type Preflight = { ok: true } | { ok: false; status: number; error: string };

export function preflight(f: PreflightFacts): Preflight {
  let verb = 'change roles for';
  if (f.action === 'timeout') verb = 'time out';
  if (f.targetIsOwner) {
    return { ok: false, status: 403, error: `Cannot ${verb} ${f.targetName}: they own the server, and Discord never allows that.` };
  }
  if (f.action === 'timeout' && f.targetIsAdministrator) {
    return { ok: false, status: 403, error: `Cannot time out ${f.targetName}: they have the Administrator permission, and Discord does not allow timing out admins.` };
  }
  if (f.botHasPermission === false) {
    let perm = 'Manage Roles';
    if (f.action === 'timeout') perm = 'Moderate Members';
    return { ok: false, status: 403, error: `Missing permission: Artie's role does not have ${perm} in this server. A server admin has to grant it.` };
  }
  const bot = f.botHighestRolePosition;
  if (bot !== undefined && f.targetHighestRolePosition !== undefined && f.targetHighestRolePosition >= bot) {
    return { ok: false, status: 403, error: `Cannot ${verb} ${f.targetName}: their highest role is at or above Artie's, so Discord refuses. A server admin would have to move Artie's role higher.` };
  }
  if (bot !== undefined && f.rolePosition !== undefined && f.rolePosition >= bot) {
    return { ok: false, status: 403, error: `Cannot use role "${f.roleName ?? 'that role'}": it is at or above Artie's highest role. A server admin would have to move Artie's role higher.` };
  }
  return { ok: true };
}

/** Discord API error codes worth naming (https://discord.com/developers/docs/topics/opcodes-and-status-codes). */
const DISCORD_CODES: Record<number, { status: number; error: string }> = {
  50013: { status: 403, error: "Discord refused: Artie is missing permissions here (needs Moderate Members for timeouts / Manage Roles for roles, and his role must sit above the target's)." },
  50001: { status: 403, error: "Discord refused: Artie has no access to that server or channel." },
  10007: { status: 404, error: 'That user is not a member of this server (Discord: Unknown Member).' },
  10013: { status: 404, error: 'Discord does not know that user id (Unknown User).' },
  10011: { status: 404, error: 'Discord does not know that role (Unknown Role).' },
  50035: { status: 400, error: 'Discord rejected the request as invalid (for timeouts, the length must be at most 28 days).' },
  30010: { status: 400, error: 'Discord says the server has too many roles.' },
};

/** Turn whatever a discord.js call threw into a cause a person can act on. */
export function describeDiscordError(err: unknown, fallback: string): { status: number; error: string } {
  const e = err as { code?: unknown; status?: unknown; message?: unknown } | null;
  const code = Number(e?.code);
  if (Number.isFinite(code) && DISCORD_CODES[code]) return DISCORD_CODES[code];
  if (e?.status === 429) {
    return { status: 429, error: 'Discord is rate limiting Artie right now. Wait a minute and try again.' };
  }
  if (e?.status === 403) {
    return { status: 403, error: 'Discord refused with 403 Forbidden: Artie lacks the permission or role height for this.' };
  }
  let message = '';
  if (typeof e?.message === 'string') message = e.message.trim();
  if (message) {
    return { status: 500, error: `${fallback}: ${message.slice(0, 200)}` };
  }
  return { status: 500, error: `${fallback}: unknown error (see gateway logs)` };
}
