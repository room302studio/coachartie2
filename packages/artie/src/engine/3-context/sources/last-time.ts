/**
 * Per-person "last time" line — Artie's own request: "Not personality numbers, just
 * 'last talked 3 days ago about X, owes you a bug report.' Callbacks are where my
 * warmth comes from." Lives next to the 🔢 ids line and the self-meter line in the
 * Discord situational-awareness block (see 3-context/assemble.ts
 * addDiscordSituationalAwareness), and like the self-meter, it's one pure formatter
 * (`lastTimeLine`) plus a fact-gathering function that does the actual I/O.
 *
 * Deliberately cheap: no extra LLM call. Everything comes from rows Artie already
 * writes on every turn (messages, memories, objectives/todo_items) — a few synchronous
 * SQLite reads, done once per reply.
 */

import { getSyncDb } from '../../../shared/db/client.js';
import { isBlockedUser } from '../../../shared/blocklist.js';
import { mentionsOptedOutUser } from '../../../shared/privacy-opt-out.js';
import { stripCapabilityTags } from '../../memory/recall.js';
import { collapseWhitespace } from '../../../shared/text.js';
import { logger } from '../../../shared/logger.js';

export interface LastTimeFacts {
  /** ISO timestamp of the previous exchange — never the message being answered right now. */
  lastAt: string;
  /** A short, cheap guess at what that exchange (or the relationship) was about. */
  topic: string | null;
  /** An open task/goal tied to this person, if the data has one. */
  openLoop: string | null;
}

/**
 * "3d ago" style age. Extends past channel-digest's 2-day cap (digestAge in
 * shared/db/channel-digest-store.ts) with weeks/months/years — a person Artie hasn't
 * talked to in two months shouldn't get "61d ago".
 */
export function relativeAge(iso: string, now: Date = new Date()): string {
  const mins = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60000));
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 21) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 10) return `${weeks}w ago`;
  const months = Math.round(days / 30);
  if (months < 18) return `${months}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

const SNIPPET_MAX = 60;

function snippet(text: string): string {
  const clean = collapseWhitespace(stripCapabilityTags(text || '')).trim();
  return clean.length > SNIPPET_MAX ? `${clean.slice(0, SNIPPET_MAX).trim()}…` : clean;
}

/** The one line. Pure — same shape as self-meter's selfMeterLine. */
export function lastTimeLine(facts: LastTimeFacts, now: Date = new Date()): string {
  const bits = [`last talked ${relativeAge(facts.lastAt, now)}`];
  if (facts.topic) bits.push(`about ${facts.topic}`);
  let line = `⏱️ ${bits.join(', ')}`;
  if (facts.openLoop) line += ` — open: ${facts.openLoop}`;
  return `${line}.`;
}

/**
 * The last real EXCHANGE with this speaker — a message of theirs that Artie actually
 * replied to — scoped to this guild (or this DM channel when there's no guild).
 *
 * Deliberately NOT "their most recent row in `messages`": the queue worker stores
 * EVERY forwarded Discord message for history, including passive ones never generated
 * on (`shouldSkipPassiveGeneration`, checked after the insert) — so in a gated-ambient
 * guild a chatty regular's most recent row is almost always something said to someone
 * else, posted seconds ago. The live message being answered right now is also already
 * a row by this point (inserted before `processMessage()` runs) and is excluded the
 * same way: it has no assistant reply yet. Same row-pairing shape as
 * `getConversationHistory` above (reply must land in the next few rows of the SAME
 * channel, before anything else this user said) — reused here, not reinvented.
 *
 * `created_at` is normalized to `...Z` because `messages.created_at` is written via
 * SQLite's `datetime('now')`, which has no timezone suffix; `strftime` makes it
 * explicit UTC so `new Date(...)` doesn't get parsed as local time downstream.
 */
function lastExchangeRow(
  userId: string,
  scope: { guildId?: string; channelId?: string }
): { value: string; created_at: string } | null {
  const db = getSyncDb();
  const scopeColumn = scope.guildId ? 'guild_id' : scope.channelId ? 'channel_id' : null;
  if (!scopeColumn) return null; // no scope to anchor "history" to — don't guess
  const scopeValue = scope.guildId || scope.channelId;

  const row = db.get<{ value: string; created_at: string }>(
    `SELECT m.value AS value, strftime('%Y-%m-%dT%H:%M:%SZ', m.created_at) AS created_at
     FROM messages m
     WHERE m.user_id = ? AND m.${scopeColumn} = ? AND coalesce(m.role, '') != 'assistant'
       AND EXISTS (
         SELECT 1 FROM messages a
          WHERE a.channel_id = m.channel_id AND a.role = 'assistant'
            AND a.id > m.id AND a.id <= m.id + 4
            AND NOT EXISTS (SELECT 1 FROM messages u
                             WHERE u.channel_id = m.channel_id AND u.user_id = m.user_id
                               AND u.id > m.id AND u.id < a.id)
       )
     ORDER BY m.id DESC LIMIT 1`,
    [userId, scopeValue]
  );
  return row || null;
}

/** Latest importance >= 7 memory about this person, guild-scoped like getRecentMemories. */
function highImportanceMemoryTopic(userId: string, guildId?: string): string | null {
  try {
    const db = getSyncDb();
    const guildFilter = guildId ? 'AND (guild_id = ? OR guild_id IS NULL)' : '';
    const params = guildId ? [userId, guildId] : [userId];
    const row = db.get<{ content: string }>(
      `SELECT content FROM memories
       WHERE user_id = ? ${guildFilter} AND importance >= 7
       ORDER BY timestamp DESC LIMIT 1`,
      params
    );
    if (!row || mentionsOptedOutUser(row.content)) return null;
    return snippet(row.content);
  } catch (error) {
    logger.warn('last-time: high-importance memory lookup failed', error);
    return null;
  }
}

/** The most recent memory tagged 'user-profile' for this person, if one has been built. */
function userProfileSummary(userId: string): string | null {
  try {
    const db = getSyncDb();
    const row = db.get<{ content: string }>(
      `SELECT content FROM memories
       WHERE user_id = ? AND tags LIKE '%user-profile%'
       ORDER BY timestamp DESC LIMIT 1`,
      [userId]
    );
    if (!row || mentionsOptedOutUser(row.content)) return null;
    return snippet(row.content);
  } catch (error) {
    logger.warn('last-time: user-profile memory lookup failed', error);
    return null;
  }
}

/** One open task/goal tied to this person: a blocked objective beats an active one, which
 *  beats a plain pending todo item. Title/content only — never the full note. */
function openLoopFor(userId: string): string | null {
  try {
    const db = getSyncDb();
    const objective = db.get<{ title: string }>(
      `SELECT title FROM objectives
       WHERE owner = ? AND status IN ('active', 'blocked')
       ORDER BY (status = 'blocked') DESC, updated_at DESC LIMIT 1`,
      [userId]
    );
    if (objective) return snippet(objective.title);

    const todoItem = db.get<{ content: string }>(
      `SELECT ti.content AS content FROM todo_items ti
       JOIN todo_lists tl ON tl.id = ti.list_id
       WHERE tl.user_id = ? AND ti.status = 'pending'
       ORDER BY ti.position ASC LIMIT 1`,
      [userId]
    );
    return todoItem ? snippet(todoItem.content) : null;
  } catch (error) {
    logger.warn('last-time: open-loop lookup failed', error);
    return null;
  }
}

/**
 * Fetch the facts; `lastTimeLine` renders them. Returns null when there's no prior
 * exchange in scope, or the speaker is blocked/opted-out — the caller skips the line
 * entirely rather than printing an empty or stale one.
 */
export function getLastTimeFacts(
  userId: string,
  scope: { guildId?: string; channelId?: string }
): LastTimeFacts | null {
  if (!userId || isBlockedUser(userId)) return null;

  const prior = lastExchangeRow(userId, scope);
  if (!prior) return null;

  // Cheapest signal first: the user's own last message, if it's descriptive enough and
  // doesn't name someone who opted out. Falls back to stored memory about them.
  let topic = mentionsOptedOutUser(prior.value) ? '' : snippet(prior.value);
  if (topic.length < 10) {
    topic = highImportanceMemoryTopic(userId, scope.guildId) || userProfileSummary(userId) || '';
  }

  return {
    lastAt: prior.created_at,
    topic: topic || null,
    openLoop: openLoopFor(userId),
  };
}
