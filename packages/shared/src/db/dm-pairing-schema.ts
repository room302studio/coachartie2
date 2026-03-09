/**
 * DM Pairing Schema
 *
 * OpenClaw-compatible pairing system for DM access control.
 * Unknown users get a pairing code, owner approves, user gets added to allowlist.
 */

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

/**
 * DM Allowlist - Users approved to DM the bot
 */
export const dmAllowlist = sqliteTable('dm_allowlist', {
  id: integer('id').primaryKey({ autoIncrement: true }),

  // User identification
  platform: text('platform').notNull().default('discord'), // discord, slack, telegram
  userId: text('user_id').notNull(),
  username: text('username'), // Display name for reference

  // Approval info
  approvedBy: text('approved_by').notNull(), // Owner who approved
  approvedAt: text('approved_at').notNull(),
  reason: text('reason'), // Optional note

  // Status
  status: text('status').notNull().default('active'), // active, revoked
  revokedAt: text('revoked_at'),
  revokedBy: text('revoked_by'),

  // Metadata
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  platformUserIdx: index('idx_dm_allowlist_platform_user').on(table.platform, table.userId),
  statusIdx: index('idx_dm_allowlist_status').on(table.status),
}));

/**
 * DM Pairing Codes - Pending approval requests
 */
export const dmPairingCodes = sqliteTable('dm_pairing_codes', {
  id: integer('id').primaryKey({ autoIncrement: true }),

  // User requesting access
  platform: text('platform').notNull().default('discord'),
  userId: text('user_id').notNull(),
  username: text('username'),

  // Pairing code
  code: text('code').notNull(), // 6-digit code
  expiresAt: text('expires_at').notNull(), // 1 hour from creation

  // Status
  status: text('status').notNull().default('pending'), // pending, approved, denied, expired
  processedAt: text('processed_at'),
  processedBy: text('processed_by'),

  // First message context (helps owner decide)
  firstMessage: text('first_message'),

  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  codeIdx: index('idx_dm_pairing_code').on(table.code),
  platformUserIdx: index('idx_dm_pairing_platform_user').on(table.platform, table.userId),
  statusIdx: index('idx_dm_pairing_status').on(table.status),
}));

/**
 * DM Policy Configuration - Per-platform settings
 */
export const dmPolicyConfig = sqliteTable('dm_policy_config', {
  id: integer('id').primaryKey({ autoIncrement: true }),

  platform: text('platform').notNull().unique(), // discord, slack, telegram, or 'default'

  // Policy mode: 'pairing' (default), 'open', 'closed'
  // - pairing: Unknown users get pairing code
  // - open: Anyone can DM (public bot mode)
  // - closed: Only allowlist, no pairing (current behavior)
  policy: text('policy').notNull().default('pairing'),

  // Code expiry in minutes (default 60)
  codeExpiryMinutes: integer('code_expiry_minutes').default(60),

  // Custom message for unknown users
  pairingMessage: text('pairing_message'),

  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
});
