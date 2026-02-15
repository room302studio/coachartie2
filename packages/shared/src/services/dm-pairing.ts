/**
 * DM Pairing Service
 *
 * OpenClaw-compatible pairing system for DM access control.
 * Manages pairing codes, allowlist, and policy configuration.
 */

import { logger } from '../utils/logger.js';
import { getSyncDb } from '../db/client.js';

// Types
export interface PairingCode {
  id: number;
  platform: string;
  userId: string;
  username: string | null;
  code: string;
  expiresAt: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  firstMessage: string | null;
  createdAt: string;
}

export interface AllowlistEntry {
  id: number;
  platform: string;
  userId: string;
  username: string | null;
  approvedBy: string;
  approvedAt: string;
  status: 'active' | 'revoked';
}

export interface DMPolicy {
  policy: 'pairing' | 'open' | 'closed';
  codeExpiryMinutes: number;
  pairingMessage: string | null;
}

// Constants
const DEFAULT_CODE_EXPIRY_MINUTES = 60;
const DEFAULT_PAIRING_MESSAGE = `Hi! I need to verify you before we can chat.

Your pairing code is: **{CODE}** (expires in {EXPIRY})

Ask my owner to approve you with: \`pairing approve {CODE}\``;

/**
 * Generate a random 6-digit pairing code
 */
function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Ensure DM pairing tables exist
 */
function ensureTables(): void {
  const db = getSyncDb();

  db.run(`
    CREATE TABLE IF NOT EXISTS dm_allowlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT 'discord',
      user_id TEXT NOT NULL,
      username TEXT,
      approved_by TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      revoked_at TEXT,
      revoked_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS dm_pairing_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT 'discord',
      user_id TEXT NOT NULL,
      username TEXT,
      code TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      processed_at TEXT,
      processed_by TEXT,
      first_message TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS dm_policy_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL UNIQUE,
      policy TEXT NOT NULL DEFAULT 'pairing',
      code_expiry_minutes INTEGER DEFAULT 60,
      pairing_message TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create indexes if not exist
  db.run(`CREATE INDEX IF NOT EXISTS idx_dm_allowlist_platform_user ON dm_allowlist(platform, user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_dm_pairing_code ON dm_pairing_codes(code)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_dm_pairing_status ON dm_pairing_codes(status)`);
}

/**
 * DM Pairing Service
 */
class DMPairingService {
  private initialized = false;

  /**
   * Initialize the service (creates tables if needed)
   */
  initialize(): void {
    if (this.initialized) return;
    try {
      ensureTables();
      this.initialized = true;
      logger.info('DM Pairing service initialized');
    } catch (error) {
      logger.error('Failed to initialize DM Pairing service:', error);
    }
  }

  /**
   * Get the DM policy for a platform
   */
  getPolicy(platform: string = 'discord'): DMPolicy {
    this.initialize();
    const db = getSyncDb();

    const config = db.get<{
      policy: string;
      code_expiry_minutes: number;
      pairing_message: string | null;
    }>(
      `SELECT policy, code_expiry_minutes, pairing_message FROM dm_policy_config WHERE platform = ?`,
      [platform]
    );

    if (config) {
      return {
        policy: config.policy as DMPolicy['policy'],
        codeExpiryMinutes: config.code_expiry_minutes,
        pairingMessage: config.pairing_message,
      };
    }

    // Return defaults
    return {
      policy: 'pairing',
      codeExpiryMinutes: DEFAULT_CODE_EXPIRY_MINUTES,
      pairingMessage: null,
    };
  }

  /**
   * Set the DM policy for a platform
   */
  setPolicy(platform: string, policy: DMPolicy['policy']): void {
    this.initialize();
    const db = getSyncDb();

    db.run(
      `INSERT INTO dm_policy_config (platform, policy, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(platform) DO UPDATE SET policy = ?, updated_at = datetime('now')`,
      [platform, policy, policy]
    );

    logger.info(`DM policy for ${platform} set to: ${policy}`);
  }

  /**
   * Check if a user is on the allowlist
   */
  isAllowed(platform: string, userId: string): boolean {
    this.initialize();
    const db = getSyncDb();

    const entry = db.get<{ id: number }>(
      `SELECT id FROM dm_allowlist WHERE platform = ? AND user_id = ? AND status = 'active'`,
      [platform, userId]
    );

    return !!entry;
  }

  /**
   * Get or create a pairing code for a user
   */
  getOrCreatePairingCode(
    platform: string,
    userId: string,
    username: string | null,
    firstMessage?: string
  ): { code: string; expiresAt: Date; isNew: boolean } {
    this.initialize();
    const db = getSyncDb();
    const policy = this.getPolicy(platform);

    // Check for existing valid code
    const existing = db.get<{ code: string; expires_at: string }>(
      `SELECT code, expires_at FROM dm_pairing_codes
       WHERE platform = ? AND user_id = ? AND status = 'pending'
       AND expires_at > datetime('now')
       ORDER BY created_at DESC LIMIT 1`,
      [platform, userId]
    );

    if (existing) {
      return {
        code: existing.code,
        expiresAt: new Date(existing.expires_at),
        isNew: false,
      };
    }

    // Expire old codes for this user
    db.run(
      `UPDATE dm_pairing_codes SET status = 'expired'
       WHERE platform = ? AND user_id = ? AND status = 'pending'`,
      [platform, userId]
    );

    // Generate new code
    const code = generateCode();
    const expiresAt = new Date(Date.now() + policy.codeExpiryMinutes * 60 * 1000);

    db.run(
      `INSERT INTO dm_pairing_codes (platform, user_id, username, code, expires_at, first_message)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [platform, userId, username, code, expiresAt.toISOString(), firstMessage?.slice(0, 500)]
    );

    logger.info(`Generated pairing code ${code} for ${platform}:${userId}`);

    return { code, expiresAt, isNew: true };
  }

  /**
   * Generate the pairing message to send to an unknown user
   */
  generatePairingMessage(platform: string, code: string, expiryMinutes: number): string {
    const policy = this.getPolicy(platform);
    const template = policy.pairingMessage || DEFAULT_PAIRING_MESSAGE;

    const expiryText = expiryMinutes >= 60
      ? `${Math.round(expiryMinutes / 60)} hour${expiryMinutes >= 120 ? 's' : ''}`
      : `${expiryMinutes} minutes`;

    return template
      .replace('{CODE}', code)
      .replace('{EXPIRY}', expiryText);
  }

  /**
   * Approve a pairing code
   */
  approve(code: string, approvedBy: string, reason?: string): { success: boolean; userId?: string; username?: string; error?: string } {
    this.initialize();
    const db = getSyncDb();

    // Find the pending code
    const pending = db.get<{
      id: number;
      platform: string;
      user_id: string;
      username: string | null;
      expires_at: string;
    }>(
      `SELECT id, platform, user_id, username, expires_at FROM dm_pairing_codes
       WHERE code = ? AND status = 'pending'`,
      [code]
    );

    if (!pending) {
      return { success: false, error: 'Pairing code not found or already processed' };
    }

    // Check expiry
    if (new Date(pending.expires_at) < new Date()) {
      db.run(`UPDATE dm_pairing_codes SET status = 'expired' WHERE id = ?`, [pending.id]);
      return { success: false, error: 'Pairing code has expired' };
    }

    // Mark code as approved
    db.run(
      `UPDATE dm_pairing_codes SET status = 'approved', processed_at = datetime('now'), processed_by = ?
       WHERE id = ?`,
      [approvedBy, pending.id]
    );

    // Add to allowlist
    db.run(
      `INSERT INTO dm_allowlist (platform, user_id, username, approved_by, approved_at, reason)
       VALUES (?, ?, ?, ?, datetime('now'), ?)`,
      [pending.platform, pending.user_id, pending.username, approvedBy, reason]
    );

    logger.info(`Approved pairing code ${code} for ${pending.platform}:${pending.user_id} by ${approvedBy}`);

    return {
      success: true,
      userId: pending.user_id,
      username: pending.username || undefined,
    };
  }

  /**
   * Deny a pairing code
   */
  deny(code: string, deniedBy: string): { success: boolean; error?: string } {
    this.initialize();
    const db = getSyncDb();

    const result = db.run(
      `UPDATE dm_pairing_codes SET status = 'denied', processed_at = datetime('now'), processed_by = ?
       WHERE code = ? AND status = 'pending'`,
      [deniedBy, code]
    );

    if (result.changes === 0) {
      return { success: false, error: 'Pairing code not found or already processed' };
    }

    logger.info(`Denied pairing code ${code} by ${deniedBy}`);
    return { success: true };
  }

  /**
   * Revoke a user's DM access
   */
  revoke(platform: string, userId: string, revokedBy: string): { success: boolean; error?: string } {
    this.initialize();
    const db = getSyncDb();

    const result = db.run(
      `UPDATE dm_allowlist SET status = 'revoked', revoked_at = datetime('now'), revoked_by = ?
       WHERE platform = ? AND user_id = ? AND status = 'active'`,
      [revokedBy, platform, userId]
    );

    if (result.changes === 0) {
      return { success: false, error: 'User not found on allowlist' };
    }

    logger.info(`Revoked DM access for ${platform}:${userId} by ${revokedBy}`);
    return { success: true };
  }

  /**
   * List pending pairing codes
   */
  listPending(platform?: string): PairingCode[] {
    this.initialize();
    const db = getSyncDb();

    // Clean up expired codes first
    db.run(`UPDATE dm_pairing_codes SET status = 'expired' WHERE status = 'pending' AND expires_at < datetime('now')`);

    const query = platform
      ? `SELECT * FROM dm_pairing_codes WHERE status = 'pending' AND platform = ? ORDER BY created_at DESC`
      : `SELECT * FROM dm_pairing_codes WHERE status = 'pending' ORDER BY created_at DESC`;

    const rows = db.all<{
      id: number;
      platform: string;
      user_id: string;
      username: string | null;
      code: string;
      expires_at: string;
      status: string;
      first_message: string | null;
      created_at: string;
    }>(query, platform ? [platform] : []);

    return rows.map(row => ({
      id: row.id,
      platform: row.platform,
      userId: row.user_id,
      username: row.username,
      code: row.code,
      expiresAt: row.expires_at,
      status: row.status as PairingCode['status'],
      firstMessage: row.first_message,
      createdAt: row.created_at,
    }));
  }

  /**
   * List allowlisted users
   */
  listAllowed(platform?: string): AllowlistEntry[] {
    this.initialize();
    const db = getSyncDb();

    const query = platform
      ? `SELECT * FROM dm_allowlist WHERE status = 'active' AND platform = ? ORDER BY approved_at DESC`
      : `SELECT * FROM dm_allowlist WHERE status = 'active' ORDER BY approved_at DESC`;

    const rows = db.all<{
      id: number;
      platform: string;
      user_id: string;
      username: string | null;
      approved_by: string;
      approved_at: string;
      status: string;
    }>(query, platform ? [platform] : []);

    return rows.map(row => ({
      id: row.id,
      platform: row.platform,
      userId: row.user_id,
      username: row.username,
      approvedBy: row.approved_by,
      approvedAt: row.approved_at,
      status: row.status as AllowlistEntry['status'],
    }));
  }

  /**
   * Add a user directly to allowlist (bypass pairing)
   */
  addToAllowlist(
    platform: string,
    userId: string,
    username: string | null,
    addedBy: string,
    reason?: string
  ): void {
    this.initialize();
    const db = getSyncDb();

    // Check if already exists
    const existing = db.get<{ id: number; status: string }>(
      `SELECT id, status FROM dm_allowlist WHERE platform = ? AND user_id = ?`,
      [platform, userId]
    );

    if (existing) {
      if (existing.status === 'active') {
        return; // Already allowed
      }
      // Re-activate
      db.run(
        `UPDATE dm_allowlist SET status = 'active', approved_by = ?, approved_at = datetime('now'), reason = ?
         WHERE id = ?`,
        [addedBy, reason, existing.id]
      );
    } else {
      db.run(
        `INSERT INTO dm_allowlist (platform, user_id, username, approved_by, approved_at, reason)
         VALUES (?, ?, ?, ?, datetime('now'), ?)`,
        [platform, userId, username, addedBy, reason]
      );
    }

    logger.info(`Added ${platform}:${userId} to DM allowlist by ${addedBy}`);
  }
}

// Singleton export
export const dmPairingService = new DMPairingService();
