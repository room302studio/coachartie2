import express from 'express';
import { logger } from '@coachartie/shared';
import { moderationService } from '../services/moderation-service.js';
import { isProtectedUser } from '../config/protected-users.js';

const SUBWAY_BUILDER_GUILD_ID = '1420846272545296470';
const STAFF_ROLE_RE = /\b(dev|developer|moderator|admin|administrator|staff|sbat)\b/i;

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
    member.roles.cache.some((r: any) => STAFF_ROLE_RE.test(r.name))
  ) {
    return { ok: false, error: 'Cannot moderate protected user or staff', status: 403 };
  }

  return { ok: true, member };
}

export function setupModerationApi(app: express.Application, client: any) {
  // POST /api/moderation/timeout
  // Called by the discord-moderation capability: { guildId, userId, durationMinutes, reason }
  app.post('/api/moderation/timeout', async (req, res) => {
    try {
      const { guildId, durationMinutes, reason } = req.body;
      const userId = req.body.userId || req.body.targetUserId;

      if (!userId || !durationMinutes || !reason) {
        return res.status(400).json({ error: 'Missing required: userId, durationMinutes, reason' });
      }

      const check = await fetchModeratableMember(client, guildId, userId);
      if (!check.ok) {
        return res.status(check.status).json({ error: check.error });
      }
      const member = check.member;

      const minutes = Math.min(60, Math.max(1, Number(durationMinutes)));
      const until = new Date(Date.now() + minutes * 60_000);
      await member.timeout(minutes * 60_000, reason);

      moderationService.logAction({
        issuedByUserId: req.body.issuedByUserId || 'coach-artie',
        issuedByName: req.body.issuedByName || 'Coach Artie',
        targetUserId: userId,
        targetUsername: member.user.username,
        action: 'timeout',
        durationMinutes: minutes,
        reason,
        discordUntil: until.toISOString(),
      });

      logger.info(`⏱️ [moderation] Timed out ${member.user.username}: ${minutes}min (${reason})`);

      res.json({
        success: true,
        message: `${member.user.username} timed out for ${minutes} minutes`,
        until: until.toISOString(),
      });
    } catch (error) {
      logger.error('[moderation/timeout] Error:', error);
      res.status(500).json({ error: 'Timeout failed' });
    }
  });

  // POST /api/moderation/add-role — { guildId, userId, roleName, reason }
  app.post('/api/moderation/add-role', async (req, res) => {
    try {
      const { guildId, userId, roleName, reason } = req.body;
      if (!userId || !roleName) {
        return res.status(400).json({ error: 'Missing required: userId, roleName' });
      }

      const check = await fetchModeratableMember(client, guildId, userId);
      if (!check.ok) {
        return res.status(check.status).json({ error: check.error });
      }
      const member = check.member;

      const role = member.guild.roles.cache.find(
        (r: any) => r.name.toLowerCase() === String(roleName).toLowerCase()
      );
      if (!role) {
        return res.status(404).json({ error: `Role "${roleName}" not found in guild` });
      }

      await member.roles.add(role, reason || 'Coach Artie moderation');
      logger.info(`🛡️ [moderation] Added role ${role.name} to ${member.user.username} (${reason})`);
      res.json({ success: true, message: `Added ${role.name} to ${member.user.username}` });
    } catch (error) {
      logger.error('[moderation/add-role] Error:', error);
      res.status(500).json({ error: 'Add role failed - may lack permissions' });
    }
  });

  // POST /api/moderation/remove-role — { guildId, userId, roleName }
  app.post('/api/moderation/remove-role', async (req, res) => {
    try {
      const { guildId, userId, roleName } = req.body;
      if (!userId || !roleName) {
        return res.status(400).json({ error: 'Missing required: userId, roleName' });
      }

      const guild = client.guilds.cache.get(guildId || SUBWAY_BUILDER_GUILD_ID);
      if (!guild) return res.status(500).json({ error: 'Guild not found' });
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) return res.status(404).json({ error: 'User not in guild' });

      const role = guild.roles.cache.find(
        (r: any) => r.name.toLowerCase() === String(roleName).toLowerCase()
      );
      if (!role) {
        return res.status(404).json({ error: `Role "${roleName}" not found in guild` });
      }

      await member.roles.remove(role, 'Coach Artie moderation');
      logger.info(`🛡️ [moderation] Removed role ${role.name} from ${member.user.username}`);
      res.json({ success: true, message: `Removed ${role.name} from ${member.user.username}` });
    } catch (error) {
      logger.error('[moderation/remove-role] Error:', error);
      res.status(500).json({ error: 'Remove role failed' });
    }
  });

  // GET /api/moderation/audit/:userId
  app.get('/api/moderation/audit/:userId', (req, res) => {
    try {
      const audit = moderationService.getAuditLog(req.params.userId, 20);
      res.json(audit);
    } catch (error) {
      logger.error('[moderation/audit] Error:', error);
      res.status(500).json({ error: 'Failed to fetch audit' });
    }
  });

  logger.info('✅ Moderation API endpoints registered');
}
