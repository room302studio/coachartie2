import { logger, getRawDb } from '@coachartie/shared';

/**
 * Moderation audit log (timeouts, bans) in the shared DB's moderation_audit table.
 *
 * Prepared statements only. This used to splice Discord display names into a shell
 * command (`execSync(sqlite3 … "INSERT … '${name}'")`): any user whose name contained $( )
 * or a quote could run commands on the host when a mod acted on them. It also never wrote
 * a row (0 rows against 45 logged timeouts, 2026-10-23).
 */
export class ModerationService {
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
      getRawDb()
        .prepare(
          `INSERT INTO moderation_audit
            (issued_by_user_id, issued_by_name, target_user_id, target_username, action,
             duration_minutes, reason, discord_until, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`
        )
        .run(
          params.issuedByUserId,
          params.issuedByName,
          params.targetUserId,
          params.targetUsername,
          params.action,
          params.durationMinutes ?? null,
          params.reason,
          params.discordUntil ?? null
        );

      logger.info(
        `[moderation-audit] ${params.action.toUpperCase()}: ${params.targetUsername} by ${params.issuedByName} (${params.reason})`
      );
    } catch (error) {
      logger.error('[moderation-audit] Failed to log action:', error);
    }
  }

  /** Most recent actions where the user was the target or the issuer. */
  getAuditLog(userId: string, limit = 10): unknown[] {
    try {
      return getRawDb()
        .prepare(
          `SELECT * FROM moderation_audit
            WHERE target_user_id = ? OR issued_by_user_id = ?
            ORDER BY created_at DESC LIMIT ?`
        )
        .all(userId, userId, limit);
    } catch (error) {
      logger.debug('[moderation-audit] Get audit log failed:', error);
      return [];
    }
  }
}

export const moderationService = new ModerationService();
