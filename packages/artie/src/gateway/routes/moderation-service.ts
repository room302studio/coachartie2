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

// Security audit 2026-10-26 (sec-authority.md MEDIUM finding — autonomous moderation is
// fully LLM-discretionary with no human-in-the-loop). Keeps the feature but bounds the
// blast radius of a prompt-injected or social-engineered timeout: at most one per target
// per day, at most a handful guild-wide per hour. Shared by the moderation tool route and
// the warden path (2026-10-31).
export const AUTONOMOUS_TIMEOUT_PER_TARGET_PER_DAY = 1;
export const AUTONOMOUS_TIMEOUT_PER_GUILD_PER_HOUR = 3;

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
        created_at TEXT NOT NULL
      )`
    )
    .run();
  autonomousTimeoutsTableReady = true;
}

class ModerationService {
  /**
   * Record one Artie-initiated timeout for the rate limit below. Call AFTER the real
   * Discord timeout succeeds, never before.
   */
  recordAutonomousTimeout(targetUserId: string, guildId: string | undefined): void {
    try {
      ensureAutonomousTimeoutsTable();
      // Explicit ISO timestamp (not SQLite's CURRENT_TIMESTAMP, which formats as
      // "YYYY-MM-DD HH:MM:SS" — a different string shape than the ISO 8601 bounds the
      // callers below compare against; mixing the two breaks the lexicographic comparison
      // `created_at >= ?` relies on).
      getRawDb()
        .prepare(
          `INSERT INTO artie_autonomous_timeouts (target_user_id, guild_id, created_at) VALUES (?, ?, ?)`
        )
        .run(targetUserId, guildId ?? null, new Date().toISOString());
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
