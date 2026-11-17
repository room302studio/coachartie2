import express from 'express';
import { logger } from '../../shared/logger.js';
import {
  moderationService,
  AUTONOMOUS_TIMEOUT_PER_TARGET_PER_DAY,
  AUTONOMOUS_TIMEOUT_PER_GUILD_PER_HOUR,
} from './moderation-service.js';
import { isProtectedUser } from '../../shared/config/protected-users.js';
import { isStaffRole } from '../../shared/staff-role.js';
import { type ApiResult, sendResult } from '../../shared/api-result.js';
import {
  type MemberCandidate,
  type ResolveResult,
  parseUserRef,
  resolveByName,
  requireCompleteSearch,
  resolveUserRef,
  parseTimeoutMinutes,
  preflight,
  describeDiscordError,
} from './moderation-resolve.js';

// Wave 9: each moderation route's handler body is an exported function returning the
// status + JSON it used to send; gateway/api.ts calls them in-process for the engine's
// moderation tool.
const reply = (status: number, body: any): ApiResult => ({ status, body });

const SUBWAY_BUILDER_GUILD_ID = '1420846272545296470';

// Discord user IDs that can never be moderated, in addition to the
// username-based list in config/protected-users.ts
const PROTECTED_IDS = [
  '688448399879438340', // EJ
  '272782606347796481', // Hudson
  '475364381413212181', // Colin
  '160919772270166016', // jan_gbg
];

/**
 * Fetch the guild member and run every moderation guardrail.
 * Returns { member } on pass, { error, status } on fail.
 */
async function fetchModeratableMember(
  client: any,
  guildId: string,
  userId: string
): Promise<{ ok: true; member: any } | { ok: false; error: string; status: number }> {
  const guild = client.guilds.cache.get(guildId || SUBWAY_BUILDER_GUILD_ID);
  if (!guild) {
    return { ok: false, error: 'This server is not available to Artie (guild not found in the Discord client).', status: 500 };
  }

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return { ok: false, error: `User ${userId} is not a member of this server.`, status: 404 };

  if (member.user.bot) return { ok: false, error: 'Cannot moderate bots', status: 403 };
  if (
    PROTECTED_IDS.includes(userId) ||
    isProtectedUser(member.user.username, userId) ||
    isProtectedUser(member.displayName, userId) ||
    member.roles.cache.some((r: any) => isStaffRole(r.name))
  ) {
    return {
      ok: false,
      error: `Cannot moderate ${member.displayName || member.user.username}: they are a protected user or staff (exempt by policy). Use escalate if a human should look.`,
      status: 403,
    };
  }

  return { ok: true, member };
}

/**
 * Turn whatever Artie has (a snowflake, an @-mention, a username or display name) into a
 * user id. He only ever sees names, so demanding a raw id meant every timeout failed
 * (2026-10-23: "I can't pull a Discord user ID just from a username"). Tries, in order:
 * an id or <@id>, the guild member search (REST; no privileged intent needed), then the
 * authors of recent messages in the channel he was talking in.
 */
export async function resolveTarget(
  client: any,
  guildId: string | undefined,
  who: string | undefined,
  channelId?: string
): Promise<ResolveResult> {
  const ref = parseUserRef(who);
  if (ref.kind !== 'name') return resolveUserRef(who, []);

  const toCandidate = (m: any): MemberCandidate => ({
    id: m.user?.id ?? m.id,
    username: m.user?.username,
    globalName: m.user?.globalName,
    nickname: m.nickname,
  });
  const candidates: MemberCandidate[] = [];
  const SEARCH_LIMIT = 25;
  let searchComplete = false;

  const guild = client.guilds.cache.get(guildId || SUBWAY_BUILDER_GUILD_ID);
  if (guild) {
    // Cache first (free), then the REST search (prefix match on username/nickname). Never a
    // full member list fetch: that is huge on a big guild and needs a privileged intent.
    const cached = guild.members?.cache;
    if (cached && typeof cached.values === 'function') {
      for (const m of cached.values()) candidates.push(toCandidate(m));
    }
    if (typeof guild.members?.search === 'function') {
      const found = await guild.members
        .search({ query: ref.name.slice(0, 32), limit: SEARCH_LIMIT })
        .catch(() => null);
      if (found) {
        for (const m of found.values()) candidates.push(toCandidate(m));
        // A full page may hide more matches; a failed search hides everything uncached.
        searchComplete = found.size < SEARCH_LIMIT;
      }
    }
  }
  // Display names (globalName) are not searchable over REST, so who has just spoken is ALWAYS
  // gathered too, before any match is accepted: an early return on a cached "Sam" could hide a
  // second, uncached "Sam" in the channel and time out the wrong person (Codex). One resolve
  // over every source means two people with the name come back as ambiguous.
  if (channelId) {
    const channel = await client.channels?.fetch(channelId).catch(() => null);
    let recent: any = null;
    if (channel && 'messages' in channel) {
      recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    }
    if (recent) {
      for (const m of recent.values()) {
        candidates.push({
          id: m.author.id,
          username: m.author.username,
          globalName: m.author.globalName,
          nickname: m.member?.nickname,
        });
      }
    }
  }
  const result = resolveByName(ref.name, candidates);
  // The REST search only covers username and nickname. A match made ONLY on a display name
  // (globalName) can't be proven unique: another member could share it and be in neither the
  // cache nor recent messages (Codex). Those need an @mention or id.
  let coveredBySearch = false;
  if (result.ok) {
    const wanted = ref.name.trim().toLowerCase();
    coveredBySearch = candidates.some(
      (c) =>
        c.id === result.id &&
        [c.username, c.nickname].some((n) => (n || '').trim().toLowerCase() === wanted)
    );
  }
  return requireCompleteSearch(result, searchComplete && coveredBySearch, ref.name);
}

/** Facts for the pure preflight, read defensively (a partial guild just means "unknown"). */
function preflightFacts(
  member: any,
  action: 'timeout' | 'role',
  role?: any
): Parameters<typeof preflight>[0] {
  const guild = member.guild;
  const me = guild?.members?.me;
  const facts: Parameters<typeof preflight>[0] = {
    action,
    targetName: member.displayName || member.user?.username || 'that user',
    roleName: role?.name,
    rolePosition: role?.position,
  };
  if (guild?.ownerId !== undefined) facts.targetIsOwner = guild.ownerId === member.id;
  if (member.permissions?.has) facts.targetIsAdministrator = member.permissions.has('Administrator');
  if (me?.permissions?.has) {
    let needed = 'ManageRoles';
    if (action === 'timeout') needed = 'ModerateMembers';
    facts.botHasPermission = me.permissions.has(needed);
  }
  facts.botHighestRolePosition = me?.roles?.highest?.position;
  facts.targetHighestRolePosition = member.roles?.highest?.position;
  return facts;
}

export async function timeoutMember(client: any, body: any): Promise<ApiResult> {
  try {
    const { guildId, durationMinutes, reason, channelId } = body;
    const who = body.userId || body.targetUserId || body.user || body.username;
    const resolved = await resolveTarget(client, guildId, who, channelId);
    if (!resolved.ok) {
      return reply(resolved.status, { error: resolved.error });
    }
    const userId = resolved.id;

    if (!durationMinutes || !reason) {
      return reply(400, { error: 'Missing required: durationMinutes, reason' });
    }
    const parsed = parseTimeoutMinutes(durationMinutes);
    if (!parsed.ok) {
      return reply(parsed.status, { error: parsed.error });
    }

    const check = await fetchModeratableMember(client, guildId, userId);
    if (!check.ok) {
      return reply(check.status, { error: check.error });
    }
    const member = check.member;
    const gate = preflight(preflightFacts(member, 'timeout'));
    if (!gate.ok) {
      return reply(gate.status, { error: gate.error });
    }

    // fetchModeratableMember already defaults to Subway Builder when guildId is missing
    // (fetchModeratableMember/resolveUserId both do), so the per-guild counter has to use
    // the SAME resolved guild — otherwise a no-guild timeout acts in Subway Builder but is
    // recorded under `null`, never counting toward that guild's hourly cap.
    const effectiveGuildId = guildId || SUBWAY_BUILDER_GUILD_ID;

    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const targetCount = moderationService.countAutonomousTimeoutsForTarget(userId, oneDayAgo);
    if (targetCount >= AUTONOMOUS_TIMEOUT_PER_TARGET_PER_DAY) {
      return reply(429, {
        error: `Already timed out this person in the last 24h — escalate to a human mod instead of timing out again.`,
      });
    }
    const guildCount = moderationService.countAutonomousTimeoutsForGuild(effectiveGuildId, oneHourAgo);
    if (guildCount >= AUTONOMOUS_TIMEOUT_PER_GUILD_PER_HOUR) {
      return reply(429, {
        error: `Already issued ${guildCount} autonomous timeouts in this server in the last hour — escalate to a human mod instead.`,
      });
    }

    const minutes = parsed.minutes;
    const until = new Date(now.getTime() + minutes * 60_000);
    await member.timeout(minutes * 60_000, reason);
    moderationService.recordAutonomousTimeout(userId, effectiveGuildId);

    moderationService.logAction({
      issuedByUserId: body.issuedByUserId || 'coach-artie',
      issuedByName: body.issuedByName || 'Coach Artie',
      targetUserId: userId,
      targetUsername: member.user.username,
      action: 'timeout',
      durationMinutes: minutes,
      reason,
      discordUntil: until.toISOString(),
    });

    logger.info(`⏱️ [moderation] Timed out ${member.user.username}: ${minutes}min (${reason})`);

    return reply(200, {
      success: true,
      message: `${member.user.username} timed out for ${minutes} minutes`,
      until: until.toISOString(),
    });
  } catch (error) {
    logger.error('[moderation/timeout] Error:', error);
    const why = describeDiscordError(error, 'Timeout failed');
    return reply(why.status, { error: why.error });
  }
}

export async function addRole(client: any, body: any): Promise<ApiResult> {
  try {
    const { guildId, roleName, reason, channelId } = body;
    const resolved = await resolveTarget(client, guildId, body.userId || body.user, channelId);
    if (!resolved.ok) {
      return reply(resolved.status, { error: resolved.error });
    }
    const userId = resolved.id;
    if (!roleName) {
      return reply(400, { error: 'Missing required: roleName' });
    }

    const check = await fetchModeratableMember(client, guildId, userId);
    if (!check.ok) {
      return reply(check.status, { error: check.error });
    }
    const member = check.member;

    const role = member.guild.roles.cache.find(
      (r: any) => r.name.toLowerCase() === String(roleName).toLowerCase()
    );
    if (!role) {
      return reply(404, { error: `Role "${roleName}" not found in this server.` });
    }
    const gate = preflight(preflightFacts(member, 'role', role));
    if (!gate.ok) {
      return reply(gate.status, { error: gate.error });
    }

    await member.roles.add(role, reason || 'Coach Artie moderation');
    logger.info(`🛡️ [moderation] Added role ${role.name} to ${member.user.username} (${reason})`);
    return reply(200, { success: true, message: `Added ${role.name} to ${member.user.username}` });
  } catch (error) {
    logger.error('[moderation/add-role] Error:', error);
    const why = describeDiscordError(error, 'Add role failed');
    return reply(why.status, { error: why.error });
  }
}

export async function removeRole(client: any, body: any): Promise<ApiResult> {
  try {
    const { guildId, roleName, channelId } = body;
    const resolved = await resolveTarget(client, guildId, body.userId || body.user, channelId);
    if (!resolved.ok) {
      return reply(resolved.status, { error: resolved.error });
    }
    const userId = resolved.id;
    if (!roleName) {
      return reply(400, { error: 'Missing required: roleName' });
    }

    // Same protected-user/staff/bot guard as addRole and timeoutMember (security audit
    // 2026-10-26: removeRole used to skip it).
    const check = await fetchModeratableMember(client, guildId, userId);
    if (!check.ok) {
      return reply(check.status, { error: check.error });
    }
    const member = check.member;
    const guild = member.guild;

    const role = guild.roles.cache.find(
      (r: any) => r.name.toLowerCase() === String(roleName).toLowerCase()
    );
    if (!role) {
      return reply(404, { error: `Role "${roleName}" not found in this server.` });
    }
    const gate = preflight(preflightFacts(member, 'role', role));
    if (!gate.ok) {
      return reply(gate.status, { error: gate.error });
    }

    await member.roles.remove(role, 'Coach Artie moderation');
    logger.info(`🛡️ [moderation] Removed role ${role.name} from ${member.user.username}`);
    return reply(200, { success: true, message: `Removed ${role.name} from ${member.user.username}` });
  } catch (error) {
    logger.error('[moderation/remove-role] Error:', error);
    const why = describeDiscordError(error, 'Remove role failed');
    return reply(why.status, { error: why.error });
  }
}

export function getModerationAudit(params: Record<string, string>): ApiResult {
  try {
    const audit = moderationService.getAuditLog(params.userId, 20);
    return reply(200, audit);
  } catch (error) {
    logger.error('[moderation/audit] Error:', error);
    return reply(500, { error: 'Failed to fetch audit' });
  }
}

export function setupModerationApi(app: express.Application, client: any) {
  // POST /api/moderation/timeout
  // Called by the discord-moderation capability: { guildId, userId, durationMinutes, reason }
  app.post('/api/moderation/timeout', async (req, res) => sendResult(res, await timeoutMember(client, req.body)));

  // POST /api/moderation/add-role — { guildId, userId, roleName, reason }
  app.post('/api/moderation/add-role', async (req, res) => sendResult(res, await addRole(client, req.body)));

  // POST /api/moderation/remove-role — { guildId, userId, roleName }
  app.post('/api/moderation/remove-role', async (req, res) => sendResult(res, await removeRole(client, req.body)));

  // GET /api/moderation/audit/:userId
  app.get('/api/moderation/audit/:userId', (req, res) => sendResult(res, getModerationAudit(req.params)));

  logger.info('✅ Moderation API endpoints registered');
}
