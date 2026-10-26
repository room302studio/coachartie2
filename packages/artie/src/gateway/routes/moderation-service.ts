import { logger } from '../../shared/logger.js';
import { getRawDb } from '../../shared/db/client.js';

/**
 * Moderation audit log (timeouts, bans) in the shared DB's moderation_audit table.
 *
 * Prepared statements only. This used to splice Discord display names into a shell
 * command (`execSync(sqlite3 … "INSERT … '${name}'")`): any user whose name contained $( )
 * or a quote could run commands on the host when a mod acted on them. It also never wrote
 * a row (0 rows against 45 logged timeouts, 2026-10-23).
 */

let autonomousTimeoutsTableReady = false;

/**
 * Own small table for the autonomous-timeout rate limit (security audit 2026-10-26,
 * sec-authority.md MEDIUM finding), separate from moderation_audit above: that table has no
 * CREATE statement anywhere in this codebase (it logged 0 rows against 45 real timeouts per
 * the comment above it), so a rate limit built on it would silently never trigger. This one
 * creates itself.
 */
function ensureAutonomousTimeoutsTable(): void {
  if (autonomousTimeoutsTableReady) return;
  getRawDb()
    .prepare(
      `CREATE TABLE IF NOT EXISTS artie_autonomous_timeouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_user_id TEXT NOT NULL,
        guild_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`
    )
    .run();
  autonomousTimeoutsTableReady = true;
}

export class ModerationService {
  /**
   * Record one Artie-initiated timeout for the rate limit below. Call AFTER the real
   * Discord timeout succeeds, never before.
   */
  recordAutonomousTimeout(targetUserId: string, guildId: string | undefined): void {
    try {
      ensureAutonomousTimeoutsTable();
      getRawDb()
        .prepare(
          `INSERT INTO artie_autonomous_timeouts (target_user_id, guild_id) VALUES (?, ?)`
        )
        .run(targetUserId, guildId ?? null);
    } catch (error) {
      logger.error('[moderation-rate-limit] Failed to record autonomous timeout:', error);
    }
  }

  /** How many Artie-initiated timeouts a target has had since `sinceIso`. */
  countAutonomousTimeoutsForTarget(targetUserId: string, sinceIso: string): number {
    try {
      ensureAutonomousTimeoutsTable();
      const row = getRawDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM artie_autonomous_timeouts
            WHERE target_user_id = ? AND created_at >= ?`
        )
        .get(targetUserId, sinceIso) as { n: number } | undefined;
      return row?.n ?? 0;
    } catch (error) {
      logger.debug('[moderation-rate-limit] Count for target failed:', error);
      return 0;
    }
  }

  /** How many Artie-initiated timeouts a guild has had since `sinceIso`, any target. */
  countAutonomousTimeoutsForGuild(guildId: string | undefined, sinceIso: string): number {
    if (!guildId) return 0;
    try {
      ensureAutonomousTimeoutsTable();
      const row = getRawDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM artie_autonomous_timeouts
            WHERE guild_id = ? AND created_at >= ?`
        )
        .get(guildId, sinceIso) as { n: number } | undefined;
      return row?.n ?? 0;
    } catch (error) {
      logger.debug('[moderation-rate-limit] Count for guild failed:', error);
      return 0;
    }
  }


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
