/**
 * Tool exposure log: one row per reply recording which tools Artie was offered, which he
 * called, and what each candidate tool router WOULD have offered (shadow mode).
 *
 * Why (EJ, 2026-10-31): "collect better data so we don't have to run shit like that" — the
 * alternative was paying to replay old turns against a smaller tool list. With this, every
 * live turn is an eval sample: a router's recall is just "was the tool he actually used in
 * the set it would have shown", measured on real traffic for free. Routers here are shadows
 * only; nothing they compute changes what the model sees.
 *
 * Joins: message_id = generation_traces.message_id (input/response text, model, 👍/👎),
 * and capability_invocations via trace_id for params/results.
 */
import { createHash } from 'crypto';
import { getSyncDb } from '../../shared/db/client.js';
import { logger } from '../../shared/logger.js';
import type { ToolDefinition } from '../5-tool-loop/tool-schema.js';

const POPULAR_WINDOW_DAYS = 30;
const CHANNEL_WINDOW_HOURS = 24;
const POPULAR_CACHE_MS = 10 * 60_000;
const CHARS_PER_TOKEN = 2.7; // observed for Anthropic models (prompt-cache.ts header)
// started_at is ISO ("2026-10-31T14:56:05.587Z"); datetime() would give "2026-10-31 14:56:05",
// and comparing those as strings lets a whole boundary day through.
const ISO_CUTOFF = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`;

interface ShadowSet {
  offered: string[];
}

export interface ToolTurnContext {
  messageId: string;
  traceId?: string | null;
  userId: string;
  guildId?: string;
  channelId?: string;
}

let tableReady = false;
let popularCache: { at: number; names: string[] } | undefined;

function ensureTable(): void {
  if (tableReady) return;
  getSyncDb().run(
    `CREATE TABLE IF NOT EXISTS tool_turn_log (
       message_id TEXT PRIMARY KEY,
       trace_id TEXT,
       user_id TEXT NOT NULL,
       guild_id TEXT,
       channel_id TEXT,
       created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
       offered_count INTEGER NOT NULL,
       offered_hash TEXT NOT NULL,
       tool_block_tokens INTEGER NOT NULL,
       called TEXT NOT NULL DEFAULT '[]',
       shadow TEXT NOT NULL DEFAULT '{}'
     )`
  );
  tableReady = true;
}

/** Tools by invocation count over the last month, most used first (cached briefly). */
function popularTools(now: number): string[] {
  if (popularCache && now - popularCache.at < POPULAR_CACHE_MS) return popularCache.names;
  const rows = getSyncDb().all<{ capability_name: string }>(
    `SELECT capability_name FROM capability_invocations
     WHERE started_at > ${ISO_CUTOFF}
     GROUP BY capability_name ORDER BY count(*) DESC`,
    [`-${POPULAR_WINDOW_DAYS} days`]
  );
  popularCache = { at: now, names: rows.map((r) => r.capability_name) };
  return popularCache.names;
}

/** Tools used in this channel recently: usage is bursty (a day of tts), so this carries most signal. */
function recentChannelTools(channelId: string | undefined): string[] {
  if (!channelId) return [];
  return getSyncDb()
    .all<{ capability_name: string }>(
      `SELECT DISTINCT ci.capability_name FROM capability_invocations ci
       JOIN generation_traces gt ON gt.id = ci.trace_id
       WHERE gt.channel_id = ? AND ci.started_at > ${ISO_CUTOFF}`,
      [channelId, `-${CHANNEL_WINDOW_HOURS} hours`]
    )
    .map((r) => r.capability_name);
}

/**
 * What each candidate router would offer for this turn, from data that existed before it
 * (computed at turn start, so a turn never "predicts" its own tool call).
 */
export function shadowRouters(ctx: ToolTurnContext, now: number = Date.now()): Record<string, ShadowSet> {
  try {
    const popular = popularTools(now);
    const recent = recentChannelTools(ctx.channelId);
    return {
      top12: { offered: popular.slice(0, 12) },
      top8_channel24h: { offered: [...new Set([...popular.slice(0, 8), ...recent])] },
    };
  } catch (error) {
    logger.debug('Tool exposure: shadow routers unavailable', error);
    return {};
  }
}

/** Whether a shadow set contained every tool the turn actually called; null for no-tool turns. */
export function shadowHit(set: ShadowSet, called: string[]): boolean | null {
  if (called.length === 0) return null;
  return called.every((name) => set.offered.includes(name));
}

function toolBlockStats(offered: ToolDefinition[]): { hash: string; tokens: number } {
  const json = JSON.stringify(offered);
  return {
    hash: createHash('sha256').update(json).digest('hex').slice(0, 16),
    tokens: Math.round(json.length / CHARS_PER_TOKEN),
  };
}

/** Write the turn's row. Logging only: a failure here never touches the reply. */
export function recordToolTurn(input: {
  ctx: ToolTurnContext;
  offered: ToolDefinition[];
  called: string[];
  shadow: Record<string, ShadowSet>;
}): void {
  try {
    ensureTable();
    const { hash, tokens } = toolBlockStats(input.offered);
    const shadow: Record<string, ShadowSet & { size: number; hit: boolean | null }> = {};
    for (const [name, set] of Object.entries(input.shadow)) {
      shadow[name] = { ...set, size: set.offered.length, hit: shadowHit(set, input.called) };
    }
    getSyncDb().run(
      `INSERT OR REPLACE INTO tool_turn_log
         (message_id, trace_id, user_id, guild_id, channel_id, offered_count, offered_hash,
          tool_block_tokens, called, shadow)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.ctx.messageId,
        input.ctx.traceId ?? null,
        input.ctx.userId,
        input.ctx.guildId ?? null,
        input.ctx.channelId ?? null,
        input.offered.length,
        hash,
        tokens,
        JSON.stringify(input.called),
        JSON.stringify(shadow),
      ]
    );
  } catch (error) {
    logger.warn('Tool exposure: could not record turn', error);
  }
}
