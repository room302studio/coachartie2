/**
 * Real-time reaction log (part 3 — "if someone thumbs-downs me mid-convo, I want to see it
 * then, not in a batch later"). In-memory, per-channel, same style as channel-activity.ts:
 * this is "what just happened to my own messages", not something worth persisting — the
 * existing batch-processed path (handleFeedbackReaction in on-reaction.ts) already writes the
 * durable memory/trace-feedback record for the sentiment-bearing emoji; this log is additive
 * and records EVERY emoji (not just the ones with known sentiment), because "I want to see it
 * then" means ALL reactions, not just the ones another system already decided mattered.
 *
 * Requires the GuildMessageReactions intent, which is NOT privileged and is already requested
 * unconditionally in gateway/main.ts — this feature needs no DISCORD_PRIVILEGED_INTENTS gate.
 */

import type { Client } from 'discord.js';
import { logger } from '../../shared/logger.js';
import { insertReaction } from '../../shared/db/reaction-store.js';

export interface ReactionLogEntry {
  messageId: string;
  channelId: string;
  emoji: string;
  userLabel: string;
  /** Guild of the channel; null for a DM. Persisted with the entry. */
  guildId?: string | null;
  /** Needed for the 14-day persisted log; entries without it stay in-memory only. */
  userId?: string;
  /** 'removed' entries are persisted but never shown in the prompt note. Default 'added'. */
  action?: 'added' | 'removed';
  /** A short excerpt of the message that got reacted to, when available (it's always
   * Artie's own message, so content is normally present regardless of privileged intents). */
  messageExcerpt?: string;
  at: number;
}

const MAX_ENTRIES_PER_CHANNEL = 50;
const RECENT_WINDOW_MS = 30 * 60 * 1000; // "last ~30 min" per the feature request

const byChannel = new Map<string, ReactionLogEntry[]>();

function persistReaction(entry: ReactionLogEntry): void {
  if (!entry.userId) return;
  try {
    let action: 'added' | 'removed' = 'added';
    if (entry.action === 'removed') action = 'removed';
    insertReaction({
      guildId: entry.guildId ?? null,
      channelId: entry.channelId,
      messageId: entry.messageId,
      emoji: entry.emoji,
      userId: entry.userId,
      userLabel: entry.userLabel,
      messageExcerpt: entry.messageExcerpt,
      action,
      at: entry.at,
    });
  } catch (error) {
    // The prompt buffer still works without the table; never break reaction handling.
    logger.warn('[reaction-log] persist failed:', error);
  }
}

export function recordReaction(entry: ReactionLogEntry): void {
  persistReaction(entry);
  if (entry.action === 'removed') return;
  const list = byChannel.get(entry.channelId) ?? [];
  list.push(entry);
  const cutoff = entry.at - RECENT_WINDOW_MS;
  const pruned = list.filter((e) => e.at >= cutoff);
  byChannel.set(entry.channelId, pruned.slice(-MAX_ENTRIES_PER_CHANNEL));
}

/** Reactions on Artie's messages in `channelId` within the last ~30 minutes, newest last. */
export function getRecentReactions(
  channelId: string,
  now: number = Date.now(),
  windowMs: number = RECENT_WINDOW_MS
): ReactionLogEntry[] {
  const list = byChannel.get(channelId) ?? [];
  const cutoff = now - windowMs;
  return list.filter((e) => e.at >= cutoff);
}

/** Test-only: clear state between test cases. */
export function resetReactionLog(channelId?: string): void {
  if (channelId) byChannel.delete(channelId);
  else byChannel.clear();
}

/**
 * One compact line for discordContext — "@Bob 👎'd your reply about X 4m ago; @Carol 👍'd
 * your last message 1m ago." Capped at a few, newest first, so this never grows into a
 * transcript of its own.
 */
export function formatRecentReactionsNote(
  reactions: ReactionLogEntry[],
  now: number = Date.now(),
  limit = 5
): string | undefined {
  if (reactions.length === 0) return undefined;
  const recent = [...reactions].sort((a, b) => b.at - a.at).slice(0, limit);
  const parts = recent.map((r) => {
    const ageMin = Math.max(0, Math.round((now - r.at) / 60000));
    let ageLabel: string;
    if (ageMin === 0) {
      ageLabel = 'just now';
    } else {
      ageLabel = `${ageMin}m ago`;
    }
    let excerpt: string;
    if (r.messageExcerpt) {
      excerpt = ` on "${r.messageExcerpt.slice(0, 40)}"`;
    } else {
      excerpt = '';
    }
    return `@${r.userLabel} ${r.emoji}${excerpt} (${ageLabel})`;
  });
  return `Recent reactions to your messages here: ${parts.join('; ')}.`;
}

export interface LiveReaction {
  emoji: string;
  count: number;
  who: string[];
}

export interface LiveMessageReactions {
  messageId: string;
  channelId: string;
  snippet: string;
  createdAt: number;
  reactions: LiveReaction[];
}

const LIVE_MAX_EMOJI = 15;
const LIVE_MAX_USERS = 25;

/**
 * Live read of one message's reactions from Discord. The caller passes the conversation's own
 * channel and guild; the fetched channel must belong to that guild (or be a DM when guildId is
 * null), so a message id from elsewhere can never be read.
 */
export async function fetchLiveReactions(
  discordClient: Client,
  channelId: string,
  messageId: string,
  expectedGuildId: string | null
): Promise<{ status: number; body: any }> {
  try {
    const channel: any = await discordClient.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !('messages' in channel)) {
      return { status: 404, body: { success: false, error: 'channel not usable' } };
    }
    const channelGuild: string | null = channel.guildId ?? null;
    if (channelGuild !== (expectedGuildId ?? null)) {
      return { status: 403, body: { success: false, error: 'channel is outside this conversation' } };
    }
    const msg: any = await channel.messages.fetch(messageId);
    if (!msg) {
      return { status: 404, body: { success: false, error: 'message not found' } };
    }
    const reactions: LiveReaction[] = [];
    const all = [...msg.reactions.cache.values()].slice(0, LIVE_MAX_EMOJI);
    for (const r of all as any[]) {
      let emoji = r.emoji.name || '?';
      if (r.emoji.id) emoji = `:${r.emoji.name}:`;
      let who: string[] = [];
      try {
        const users = await r.users.fetch({ limit: LIVE_MAX_USERS });
        who = [...users.values()].map((u: any) => {
          const member = msg.guild?.members?.cache?.get(u.id);
          return member?.displayName || u.displayName || u.username || u.id;
        });
      } catch (error) {
        logger.debug('[reaction-log] users fetch failed:', error);
      }
      reactions.push({ emoji, count: r.count ?? who.length, who });
    }
    const live: LiveMessageReactions = {
      messageId,
      channelId,
      snippet: String(msg.content || '').slice(0, 200),
      createdAt: msg.createdTimestamp,
      reactions,
    };
    return { status: 200, body: { success: true, message: live } };
  } catch (error) {
    return { status: 404, body: { success: false, error: `could not read message: ${String(error)}` } };
  }
}
