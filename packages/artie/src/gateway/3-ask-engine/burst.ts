/**
 * Burst debounce: "three people talking at once means I answer message 1 after messages 2
 * and 3 already changed the topic. Batch bursts." (Artie's own words.)
 *
 * A per-channel window: the FIRST addressed message in a channel starts a timer
 * (`BURST_DEBOUNCE_MS`, default 2500ms); every other addressed message that arrives in the
 * same channel before the timer fires joins the same batch WITHOUT resetting the timer — a
 * single message is capped at exactly `windowMs` of added latency, never more, no matter how
 * many more arrive right behind it. When the timer fires the whole batch is handed to one
 * `flush` call and the channel's buffer is deleted immediately, so anything arriving the
 * instant after opens a brand-new batch rather than joining a "batch in flight" — there is no
 * in-flight state here at all, which is what guarantees that.
 *
 * Pure except for `setTimeout`/`Date.now` (both overridable, so this is deterministic under
 * vitest's fake timers). No Discord.js types in this file on purpose — it batches generic
 * items, so the actual Discord plumbing (building the combined turn, calling the engine)
 * lives in the caller (on-message.ts) and is easy to keep out of this file's tests.
 */

export interface BurstSchedulerOptions {
  clock?: () => number;
}

interface PendingBatch<T> {
  items: T[];
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
}

export class BurstScheduler<T> {
  private readonly clock: () => number;
  private readonly buffers = new Map<string, PendingBatch<T>>();

  constructor(options: BurstSchedulerOptions = {}) {
    this.clock = options.clock ?? Date.now;
  }

  /**
   * Add `item` to `channelId`'s pending batch, flushing it (calling `flush` with every item
   * collected so far, oldest first) once the window elapses. `windowMs` is read fresh each
   * time a NEW batch starts (so an env change takes effect on the next batch, not the current
   * one); items joining an already-open batch never change or extend its deadline — that's
   * the cap that guarantees a single message never waits longer than one window.
   * `windowMs: 0` flushes on the next tick — still batches same-tick arrivals, just with no
   * added latency.
   */
  add(channelId: string, item: T, flush: (items: T[]) => void | Promise<void>, windowMs: number): void {
    const existing = this.buffers.get(channelId);
    if (existing) {
      existing.items.push(item);
      return;
    }
    const startedAt = this.clock();
    const timer = setTimeout(() => {
      const batch = this.buffers.get(channelId);
      // Delete BEFORE calling flush: a message that arrives while flush() is still running
      // (generating/tool-looping) must start a fresh batch, never append to this one.
      this.buffers.delete(channelId);
      if (batch) void flush(batch.items);
    }, Math.max(0, windowMs));
    this.buffers.set(channelId, { items: [item], timer, startedAt });
  }

  /** How many items are waiting in `channelId`'s pending batch right now (0 if none). */
  pendingCount(channelId: string): number {
    return this.buffers.get(channelId)?.items.length ?? 0;
  }

  /** When `channelId`'s current batch opened (undefined if there isn't one). */
  startedAt(channelId: string): number | undefined {
    return this.buffers.get(channelId)?.startedAt;
  }

  /** Test/shutdown helper: flush every pending batch right now, bypassing their timers. */
  flushAll(flush: (channelId: string, items: T[]) => void | Promise<void>): void {
    for (const [channelId, batch] of [...this.buffers.entries()]) {
      clearTimeout(batch.timer);
      this.buffers.delete(channelId);
      void flush(channelId, batch.items);
    }
  }
}

/** Env knob, read lazily (not at module load) so tests can set it per-case. 0 disables batching
 * (every message flushes on its own, still through the same code path). */
export function burstDebounceMs(): number {
  const raw = parseInt(process.env.BURST_DEBOUNCE_MS ?? '', 10);
  if (Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  return 2500;
}

/** One burst item's renderable shape — everything needed to fold it into a combined turn. */
export interface BurstMessage {
  messageId: string;
  authorLabel: string;
  content: string;
}

/**
 * Combine a batch into one turn's worth of text. A lone message passes through unchanged
 * (no "Alice: " prefix noise on the overwhelmingly common single-message case). A real burst
 * is rendered as one line per author so the model can tell who said what without guessing.
 */
export function combineBurstContent(entries: BurstMessage[]): string {
  if (entries.length === 0) return '';
  if (entries.length === 1) return entries[0].content;
  return entries.map((e) => `${e.authorLabel}: ${e.content || '[no text]'}`).join('\n');
}

/** The `discordContext.burst` field for a combined turn — undefined for a lone message, so a
 * single-message turn's context is byte-identical to pre-batching behavior. */
export function renderBurstForContext(
  entries: BurstMessage[]
): Array<{ author: string; content: string; messageId: string }> | undefined {
  if (entries.length <= 1) return undefined;
  return entries.map((e) => ({ author: e.authorLabel, content: e.content, messageId: e.messageId }));
}
