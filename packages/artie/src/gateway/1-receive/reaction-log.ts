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

export interface ReactionLogEntry {
  messageId: string;
  channelId: string;
  emoji: string;
  userLabel: string;
  /** A short excerpt of the message that got reacted to, when available (it's always
   * Artie's own message, so content is normally present regardless of privileged intents). */
  messageExcerpt?: string;
  at: number;
}

const MAX_ENTRIES_PER_CHANNEL = 50;
const RECENT_WINDOW_MS = 30 * 60 * 1000; // "last ~30 min" per the feature request

const byChannel = new Map<string, ReactionLogEntry[]>();

export function recordReaction(entry: ReactionLogEntry): void {
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
