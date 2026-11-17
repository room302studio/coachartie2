/**
 * Persisted reaction log: reactions people leave on Artie's own messages, 14 days.
 *
 * The gateway writes here from reaction-log.ts (the same place the in-memory 30-minute prompt
 * buffer is fed); the discord-reaction tool's `read` action reads it. Table is created on first
 * touch, like channel_digests. Table definition mirrored in schema.ts (reactionLog).
 *
 * Scope is the caller's job and is enforced by the query shape: every read takes a channel or a
 * guild id the engine got from the conversation context, never from the model.
 */

import { getSyncDb } from './client.js';

export const REACTION_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

export interface PersistedReaction {
  guildId: string | null;
  channelId: string;
  messageId: string;
  emoji: string;
  userId: string;
  userLabel: string;
  messageExcerpt?: string;
  action: 'added' | 'removed';
  at: number;
}

interface ReactionRow {
  guild_id: string | null;
  channel_id: string;
  message_id: string;
  emoji: string;
  user_id: string;
  user_label: string;
  message_excerpt: string | null;
  action: string;
  at: number;
}

let tableReady = false;
let lastPruneAt = 0;

function ensureTable(): void {
  if (tableReady) return;
  const db = getSyncDb();
  db.run(`
    CREATE TABLE IF NOT EXISTS reaction_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_label TEXT NOT NULL,
      message_excerpt TEXT,
      action TEXT NOT NULL DEFAULT 'added',
      at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_reaction_log_channel_at ON reaction_log(channel_id, at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_reaction_log_message ON reaction_log(message_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_reaction_log_at ON reaction_log(at)`);
  tableReady = true;
}

/** Test-only: forget that the table exists / when we last pruned (a test may swap the DB). */
export function resetReactionStoreState(): void {
  tableReady = false;
  lastPruneAt = 0;
}

/** Delete rows older than 14 days. Returns how many were removed. */
export function pruneReactions(now: number = Date.now()): number {
  ensureTable();
  const result = getSyncDb().run(`DELETE FROM reaction_log WHERE at < ?`, [
    now - REACTION_RETENTION_MS,
  ]);
  lastPruneAt = now;
  return Number((result as any)?.changes ?? 0);
}

export function insertReaction(r: PersistedReaction): void {
  ensureTable();
  getSyncDb().run(
    `INSERT INTO reaction_log
       (guild_id, channel_id, message_id, emoji, user_id, user_label, message_excerpt, action, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.guildId,
      r.channelId,
      r.messageId,
      r.emoji,
      r.userId,
      r.userLabel,
      r.messageExcerpt ?? null,
      r.action,
      r.at,
    ]
  );
  if (r.at - lastPruneAt > PRUNE_EVERY_MS) {
    pruneReactions(r.at);
  }
}

export interface ReactionQuery {
  /** The conversation's guild; null/undefined for a DM (then only channelId rows match). */
  guildId?: string | null;
  /** Always set by the caller from context. With scope 'guild' it is only used for DMs. */
  channelId: string;
  /** 'channel' (default): just this channel. 'guild': every channel of the guild (never in DMs). */
  scope?: 'channel' | 'guild';
  messageId?: string;
  sinceMs: number;
  now?: number;
}

/**
 * Reactions that currently stand: for each (message, emoji, user) the latest event wins, and
 * only 'added' survives. Newest first.
 */
export function listStandingReactions(q: ReactionQuery): PersistedReaction[] {
  ensureTable();
  const now = q.now ?? Date.now();
  const where: string[] = [`at >= ?`, `at <= ?`];
  const args: any[] = [now - q.sinceMs, now];

  if (q.guildId && q.scope === 'guild') {
    where.push(`guild_id = ?`);
    args.push(q.guildId);
  } else {
    where.push(`channel_id = ?`);
    args.push(q.channelId);
    if (q.guildId) {
      where.push(`guild_id = ?`);
      args.push(q.guildId);
    } else {
      where.push(`guild_id IS NULL`);
    }
  }
  if (q.messageId) {
    where.push(`message_id = ?`);
    args.push(q.messageId);
  }

  const rows = getSyncDb().all<ReactionRow>(
    `SELECT guild_id, channel_id, message_id, emoji, user_id, user_label, message_excerpt, action, at
       FROM reaction_log WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC`,
    args
  );

  const seen = new Set<string>();
  const standing: PersistedReaction[] = [];
  for (const row of rows) {
    const key = `${row.message_id}\u0000${row.emoji}\u0000${row.user_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (row.action !== 'added') continue;
    standing.push({
      guildId: row.guild_id,
      channelId: row.channel_id,
      messageId: row.message_id,
      emoji: row.emoji,
      userId: row.user_id,
      userLabel: row.user_label,
      messageExcerpt: row.message_excerpt ?? undefined,
      action: 'added',
      at: row.at,
    });
  }
  return standing;
}
