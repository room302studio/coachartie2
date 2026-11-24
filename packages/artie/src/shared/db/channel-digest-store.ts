/**
 * Channel digests: one rolling summary per Discord channel ("what's been going on in here").
 *
 * This replaces the old observation firehose (#91), which stored every 25-minute channel
 * summary as a memory: 7,161 of them, 0 ever recalled. A digest is NOT a memory. It's one
 * upserted row per channel that the reply path reads directly for the channel Artie was
 * @mentioned in, so it's always the current picture and never competes in memory recall.
 *
 * The discord process owns the cursor (last_message_id) and decides when to refresh; the
 * capabilities process does the cheap LLM call and writes the row. Both read it.
 */

import { getSyncDb } from './client.js';

interface ChannelDigest {
  guildId: string;
  channelId: string;
  channelName: string;
  digest: string;
  lastMessageId: string | null;
  messagesSeen: number;
  updatedAt: string; // ISO, UTC
}

let tableReady = false;

function ensureTable(): void {
  if (tableReady) return;
  getSyncDb().run(`
    CREATE TABLE IF NOT EXISTS channel_digests (
      channel_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_name TEXT NOT NULL DEFAULT '',
      digest TEXT NOT NULL DEFAULT '',
      last_message_id TEXT,
      messages_seen INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `);
  tableReady = true;
}

interface DigestRow {
  channel_id: string;
  guild_id: string;
  channel_name: string;
  digest: string;
  last_message_id: string | null;
  messages_seen: number;
  updated_at: string;
}

function fromRow(r: DigestRow): ChannelDigest {
  return {
    guildId: r.guild_id,
    channelId: r.channel_id,
    channelName: r.channel_name,
    digest: r.digest,
    lastMessageId: r.last_message_id,
    messagesSeen: r.messages_seen,
    updatedAt: r.updated_at,
  };
}

export function getChannelDigest(channelId: string): ChannelDigest | null {
  ensureTable();
  const row = getSyncDb().get<DigestRow>(`SELECT * FROM channel_digests WHERE channel_id = ?`, [
    channelId,
  ]);
  if (row) {
    return fromRow(row);
  }
  return null;
}

/**
 * Advance the cursor without touching the digest text. Used to seed a channel on first
 * sight (so a restart never summarizes old history) and when a batch was all bots.
 */
export function setChannelDigestCursor(
  guildId: string,
  channelId: string,
  channelName: string,
  lastMessageId: string
): void {
  ensureTable();
  getSyncDb().run(
    `INSERT INTO channel_digests (channel_id, guild_id, channel_name, last_message_id, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET last_message_id = excluded.last_message_id,
                                           channel_name = excluded.channel_name`,
    [channelId, guildId, channelName, lastMessageId, new Date(0).toISOString()]
  );
}

export function saveChannelDigest(d: {
  guildId: string;
  channelId: string;
  channelName: string;
  digest: string;
  lastMessageId: string;
  newMessages: number;
}): void {
  ensureTable();
  getSyncDb().run(
    `INSERT INTO channel_digests
       (channel_id, guild_id, channel_name, digest, last_message_id, messages_seen, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET digest = excluded.digest,
       channel_name = excluded.channel_name,
       last_message_id = excluded.last_message_id,
       messages_seen = channel_digests.messages_seen + excluded.messages_seen,
       updated_at = excluded.updated_at`,
    [
      d.channelId,
      d.guildId,
      d.channelName,
      d.digest,
      d.lastMessageId,
      d.newMessages,
      new Date().toISOString(),
    ]
  );
}

/** "3h ago" style age for the prompt; the model needs to know how fresh the picture is. */
export function digestAge(updatedAt: string, now: Date = new Date()): string {
  const mins = Math.max(0, Math.round((now.getTime() - new Date(updatedAt).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
