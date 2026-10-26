/**
 * Per-channel ring buffer of recent activity, in memory (gateway process only, not the DB —
 * this is "what just happened", not something worth persisting). Two consumers:
 *
 * - "Landed while you were thinking" (burst debounce, part 2b): when a batched turn is about
 *   to be answered, pickLandedMessages() finds anything that arrived in that channel after the
 *   batch opened and isn't one of the batch's own messages — so the reply can note what
 *   changed instead of answering into a conversation that already moved on.
 * - Recent reactions (part 3): see reaction-log.ts, which keeps its own small ring buffer in
 *   the same style but keyed differently (per message, not per channel-arrival-order), so it
 *   is NOT stored here.
 */

export interface ChannelActivityEntry {
  messageId: string;
  authorLabel: string;
  content: string;
  ts: number;
  /** Who this message was aimed at, when it was a reply to or @-mention of someone other
   *  than Artie. Lets the landed note show a side conversation as one. */
  toLabel?: string;
}

const MAX_ENTRIES_PER_CHANNEL = 40;
const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes — this is "just now", not history

const buffers = new Map<string, ChannelActivityEntry[]>();

/** Record one message's arrival. Call for every message that reaches this point in the
 * pipeline (blocked/opted-out users are already dropped upstream, so never recorded here). */
export function recordChannelActivity(channelId: string, entry: ChannelActivityEntry): void {
  const list = buffers.get(channelId) ?? [];
  list.push(entry);
  const cutoff = entry.ts - MAX_AGE_MS;
  const pruned = list.filter((e) => e.ts >= cutoff);
  buffers.set(channelId, pruned.slice(-MAX_ENTRIES_PER_CHANNEL));
}

/** Read-only snapshot, for tests and for pickLandedMessages. */
export function getChannelActivity(channelId: string): ChannelActivityEntry[] {
  return buffers.get(channelId) ?? [];
}

/** Test-only: drop everything (vitest describes share module state across files otherwise). */
export function resetChannelActivity(channelId?: string): void {
  if (channelId) buffers.delete(channelId);
  else buffers.clear();
}

/**
 * Pure: what "landed" after a batch opened. Anything recorded with ts > sinceTs that isn't
 * one of the batch's own message ids — i.e. other traffic in the channel while this batch's
 * messages were being gathered/answered. Capped and rendered compactly: this rides in the
 * prompt on every batched/ambient-busy reply, so it stays a one-line note, not a transcript.
 */
export function pickLandedMessages(
  activity: ChannelActivityEntry[],
  sinceTs: number,
  excludeMessageIds: Set<string>,
  limit = 5
): ChannelActivityEntry[] {
  return activity
    .filter((e) => e.ts > sinceTs && !excludeMessageIds.has(e.messageId))
    .slice(-limit);
}

function formatEntryLine(e: ChannelActivityEntry): string {
  let toClause = '';
  if (e.toLabel) {
    toClause = ` (to ${e.toLabel})`;
  }
  let contentClause = '';
  if (e.content) {
    contentClause = `: "${e.content.slice(0, 60)}"`;
  }
  return `${e.authorLabel}${toClause}${contentClause}`;
}

function pluralMessages(count: number): string {
  if (count === 1) {
    return '';
  }
  return 's';
}

/** Render pickLandedMessages() output as the one-line note that goes in discordContext. */
export function formatLandedNote(landed: ChannelActivityEntry[]): string | undefined {
  if (landed.length === 0) return undefined;
  const parts = landed.map(formatEntryLine);
  const pluralS = pluralMessages(landed.length);
  return `While you were composing this reply, ${landed.length} more message${pluralS} landed in this channel, in arrival order — ${parts.join('; ')}. You may be answering a question that's already moved on; adjust if so. Lines marked (to X) are people talking to each other, not to you.`;
}
