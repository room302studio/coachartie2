import express from 'express';
import { logger } from '@coachartie/shared';
import { moderationService } from '../services/moderation-service.js';

export function setupModerationApi(app: express.Application, client: any) {
  // POST /api/moderation/timeout
  app.post('/api/moderation/timeout', async (req, res) => {
    try {
      const { targetUserId, targetUsername, durationMinutes, reason, issuedByUserId, issuedByName } = req.body;

      if (!targetUserId || !durationMinutes || !reason) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Validate: cannot timeout staff/protected users
      const protectedIds = [
        '688448399879438340', // EJ
        '272782606347796481', // Hudson
        '475364381413212181', // Colin
        '160919772270166016', // jan_gbg
      ];

      if (protectedIds.includes(targetUserId)) {
        return res.status(403).json({ error: 'Cannot timeout protected user' });
      }

      // Apply timeout via Discord API
      const guild = client.guilds.cache.get('1420846272545296470');
      if (!guild) {
        return res.status(500).json({ error: 'Guild not found' });
      }

      const member = await guild.members.fetch(targetUserId).catch(() => null);
      if (!member) {
        return res.status(404).json({ error: 'User not in guild' });
      }

      // Calculate timeout end time
      const until = new Date(Date.now() + durationMinutes * 60_000);

      await member.timeout(durationMinutes * 60_000, reason);

      // Log to audit table
      moderationService.logAction({
        issuedByUserId,
        issuedByName,
        targetUserId,
        targetUsername,
        action: 'timeout',
        durationMinutes,
        reason,
        discordUntil: until.toISOString(),
      });

      logger.info(`⏱️ [moderation] Timed out ${targetUsername}: ${durationMinutes}min (${reason})`);

      res.json({
        success: true,
        message: `${targetUsername} timed out for ${durationMinutes} minutes`,
        until: until.toISOString(),
      });
    } catch (error) {
      logger.error('[moderation/timeout] Error:', error);
      res.status(500).json({ error: 'Timeout failed' });
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
