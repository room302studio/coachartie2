import express from 'express';
import { logger } from '../../shared/logger.js';
import { moderationService } from './moderation-service.js';
import { isProtectedUser } from '../../shared/config/protected-users.js';
import { isStaffRole } from '../../shared/staff-role.js';
import { type ApiResult, sendResult } from '../../shared/api-result.js';

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
  if (!guild) return { ok: false, error: 'Guild not found', status: 500 };

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return { ok: false, error: 'User not in guild', status: 404 };

  if (member.user.bot) return { ok: false, error: 'Cannot moderate bots', status: 403 };
  if (
    PROTECTED_IDS.includes(userId) ||
    isProtectedUser(member.user.username, userId) ||
    isProtectedUser(member.displayName, userId) ||
    member.roles.cache.some((r: any) => isStaffRole(r.name))
  ) {
    return { ok: false, error: 'Cannot moderate protected user or staff', status: 403 };
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
export async function resolveUserId(
  client: any,
  guildId: string | undefined,
  who: string | undefined,
  channelId?: string
): Promise<string | null> {
  const raw = String(who || '').trim();
  if (!raw) return null;
  const id = raw.match(/^<@!?(\d{15,21})>$/)?.[1] || raw.match(/^(\d{15,21})$/)?.[1];
  if (id) return id;
  const name = raw.replace(/^@/, '').toLowerCase();
  const matches = (u: { username?: string; globalName?: string | null }, nick?: string | null) =>
    [u.username, u.globalName, nick].some((n) => (n || '').toLowerCase() === name);

  const guild = client.guilds.cache.get(guildId || SUBWAY_BUILDER_GUILD_ID);
  if (guild) {
    const found = await guild.members.search({ query: name.slice(0, 32), limit: 10 }).catch(() => null);
    const hit = found && [...found.values()].find((m: any) => matches(m.user, m.nickname));
    if (hit) return hit.user.id;
  }
  if (channelId) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    const recent = channel && 'messages' in channel ? await channel.messages.fetch({ limit: 100 }).catch(() => null) : null;
    const author = recent && [...recent.values()].find((m: any) => matches(m.author, m.member?.nickname));
    if (author) return author.author.id;
  }
  return null;
}

export async function timeoutMember(client: any, body: any): Promise<ApiResult> {
  try {
    const { guildId, durationMinutes, reason, channelId } = body;
    const who = body.userId || body.targetUserId || body.user || body.username;
    const userId = await resolveUserId(client, guildId, who, channelId);

    if (!userId || !durationMinutes || !reason) {
      return reply(400, {
        error: userId
          ? 'Missing required: durationMinutes, reason'
          : `Couldn't find a member called "${who ?? ''}" in this server`,
      });
    }

    const check = await fetchModeratableMember(client, guildId, userId);
    if (!check.ok) {
      return reply(check.status, { error: check.error });
    }
    const member = check.member;

    const minutes = Math.min(60, Math.max(1, Number(durationMinutes)));
    const until = new Date(Date.now() + minutes * 60_000);
    await member.timeout(minutes * 60_000, reason);

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
    return reply(500, { error: 'Timeout failed' });
  }
}

export async function addRole(client: any, body: any): Promise<ApiResult> {
  try {
    const { guildId, roleName, reason, channelId } = body;
    const userId = await resolveUserId(client, guildId, body.userId || body.user, channelId);
    if (!userId || !roleName) {
      return reply(400, { error: 'Missing required: userId, roleName' });
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
      return reply(404, { error: `Role "${roleName}" not found in guild` });
    }

    await member.roles.add(role, reason || 'Coach Artie moderation');
    logger.info(`🛡️ [moderation] Added role ${role.name} to ${member.user.username} (${reason})`);
    return reply(200, { success: true, message: `Added ${role.name} to ${member.user.username}` });
  } catch (error) {
    logger.error('[moderation/add-role] Error:', error);
    return reply(500, { error: 'Add role failed - may lack permissions' });
  }
}

export async function removeRole(client: any, body: any): Promise<ApiResult> {
  try {
    const { guildId, roleName, channelId } = body;
    const userId = await resolveUserId(client, guildId, body.userId || body.user, channelId);
    if (!userId || !roleName) {
      return reply(400, { error: 'Missing required: userId, roleName' });
    }

    const guild = client.guilds.cache.get(guildId || SUBWAY_BUILDER_GUILD_ID);
    if (!guild) return reply(500, { error: 'Guild not found' });
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return reply(404, { error: 'User not in guild' });

    const role = guild.roles.cache.find(
      (r: any) => r.name.toLowerCase() === String(roleName).toLowerCase()
    );
    if (!role) {
      return reply(404, { error: `Role "${roleName}" not found in guild` });
    }

    await member.roles.remove(role, 'Coach Artie moderation');
    logger.info(`🛡️ [moderation] Removed role ${role.name} from ${member.user.username}`);
    return reply(200, { success: true, message: `Removed ${role.name} from ${member.user.username}` });
  } catch (error) {
    logger.error('[moderation/remove-role] Error:', error);
    return reply(500, { error: 'Remove role failed' });
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
