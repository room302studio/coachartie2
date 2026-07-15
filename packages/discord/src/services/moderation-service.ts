import { logger } from '@coachartie/shared';
import { execSync } from 'child_process';

const DB_PATH = '/data2/apps/coachartie2/packages/discord/data/coachartie.db';

export class ModerationService {
  /**
   * Log a moderation action (timeout/ban) to the audit table
   */
  logAction(params: {
    issuedByUserId: string;
    issuedByName: string;
    targetUserId: string;
    targetUsername: string;
    action: 'timeout' | 'ban' | 'unban';
    durationMinutes?: number;
    reason: string;
    discordUntil?: string;
  }) {
    try {
      const query = `
        INSERT INTO moderation_audit
        (issued_by_user_id, issued_by_name, target_user_id, target_username, action, duration_minutes, reason, discord_until, status)
        VALUES ('${params.issuedByUserId}', '${params.issuedByName}', '${params.targetUserId}', '${params.targetUsername}', '${params.action}', ${params.durationMinutes || null}, '${params.reason.replace(/'/g, "''")}', '${params.discordUntil || null}', 'active')
      `;

      execSync(`sqlite3 ${DB_PATH} "${query}"`);

      logger.info(
        `[moderation-audit] ${params.action.toUpperCase()}: ${params.targetUsername} by ${params.issuedByName} (${params.reason})`
      );
    } catch (error) {
      logger.error('[moderation-audit] Failed to log action:', error);
    }
  }

  /**
   * Get audit log for a user
   */
  getAuditLog(userId: string, limit = 10) {
    try {
      const result = execSync(
        `sqlite3 ${DB_PATH} "SELECT * FROM moderation_audit WHERE target_user_id = '${userId}' OR issued_by_user_id = '${userId}' ORDER BY created_at DESC LIMIT ${limit}"`,
        { encoding: 'utf-8' }
      );
      return result;
    } catch (error) {
      logger.debug('[moderation-audit] Get audit log failed:', error);
      return '';
    }
  }
}

export const moderationService = new ModerationService();
