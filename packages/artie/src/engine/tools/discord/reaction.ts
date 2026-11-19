/**
 * Discord Reaction Capability
 * Lets Artie slap an emoji reaction on a message — defaults to the message he's
 * currently responding to. Meant for his habit of hitting genuinely poignant
 * messages with an unhinged, obscure emoji instead of (or alongside) words.
 */

import {
  RegisteredCapability,
  CapabilityContext,
} from '../../5-tool-loop/registry.js';
import { logger } from '../../../shared/logger.js';
import * as gateway from '../../../gateway/api.js';
import {
  listStandingReactions,
  listReactionEvents,
  type PersistedReaction,
} from '../../../shared/db/reaction-store.js';
import { isOptedOut } from '../../../shared/privacy-opt-out.js';
import { isBlockedUser } from '../../../shared/blocklist.js';

/** Shape of gateway.readMessageReactions' body.message (mirrors gateway reaction-log.ts). */
export interface LiveMessageReactions {
  messageId: string;
  channelId: string;
  snippet: string;
  createdAt: number;
  reactions: Array<{ emoji: string; count: number; who: string[] }>;
}

const SNIPPET_MAX = 80;
const WHO_MAX = 10;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_HOURS = 24;
const MAX_HOURS = 14 * 24;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

export function snippetOf(text: string | undefined): string {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= SNIPPET_MAX) return flat;
  return flat.slice(0, SNIPPET_MAX - 3) + '...';
}

export function ageLabel(thenMs: number, now: number): string {
  const min = Math.max(0, Math.round((now - thenMs) / 60000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export interface ReactionView {
  emoji: string;
  count: number;
  who: string[];
}

export interface MessageReactionsView {
  message_id: string;
  snippet: string;
  age: string;
  reactions: ReactionView[];
}

/** Group standing persisted reactions by message, then emoji. Newest-reacted message first. */
export function formatPersisted(rows: PersistedReaction[], now: number, limit: number): MessageReactionsView[] {
  const byMessage = new Map<string, PersistedReaction[]>();
  for (const row of rows) {
    const list = byMessage.get(row.messageId) ?? [];
    list.push(row);
    byMessage.set(row.messageId, list);
  }
  const out: MessageReactionsView[] = [];
  for (const [messageId, list] of byMessage) {
    // Grouped by the emoji's identity (a custom emoji's id), labeled afterwards: two different
    // custom emojis that share a name stay separate (Codex).
    const byEmoji = new Map<string, { label: string; who: string[] }>();
    for (const r of list) {
      const entry = byEmoji.get(r.emoji) ?? { label: r.emojiLabel || r.emoji, who: [] };
      entry.who.push(r.userLabel);
      byEmoji.set(r.emoji, entry);
    }
    const reactions: ReactionView[] = [...byEmoji.values()].map(({ label, who }) => ({
      emoji: label,
      count: who.length,
      who: who.slice(0, WHO_MAX),
    }));
    reactions.sort((a, b) => b.count - a.count);
    const excerpt = list.find((r) => r.messageExcerpt)?.messageExcerpt;
    out.push({
      message_id: messageId,
      snippet: snippetOf(excerpt),
      age: ageLabel(Math.max(...list.map((r) => r.at)), now),
      reactions,
    });
  }
  return out.slice(0, limit);
}

export function formatLive(msg: LiveMessageReactions, now: number): MessageReactionsView {
  return {
    message_id: msg.messageId,
    snippet: snippetOf(msg.snippet),
    age: ageLabel(msg.createdAt, now),
    reactions: msg.reactions.map((r) => ({
      emoji: r.emoji,
      count: r.count,
      who: r.who.slice(0, WHO_MAX),
    })),
  };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function readReactions(params: any, context?: CapabilityContext): Promise<string> {
  // Scope comes ONLY from the conversation, never from model-supplied params.
  const channelId = context?.channelId;
  const guildId = context?.guildId ?? null;
  if (!channelId) {
    return JSON.stringify({
      success: false,
      error:
        "this message didn't come from a Discord channel (it arrived through the API/bridge), so there are no reactions to read here. Reactions can only be read from inside the Discord channel or DM where they happened.",
    });
  }
  const now = Date.now();
  const messageId = String(params.message_id || '').trim();

  // Both read paths show earlier messages and who reacted: the asker must be allowed to read
  // this channel's history themselves, not just the bot (Codex). Fails closed.
  const askerId = context?.userId;
  let allowed = false;
  if (askerId) {
    try {
      allowed = await gateway.canReadHistory(String(channelId), guildId, String(askerId));
    } catch {
      allowed = false;
    }
  }
  if (!allowed) {
    return JSON.stringify({
      success: false,
      error: "you'd need Read Message History in this channel to look up reactions here",
    });
  }

  if (messageId) {
    try {
      const resp = await gateway.readMessageReactions(String(channelId), messageId, guildId);
      if (gateway.isOk(resp)) {
        const live = (resp.body as any).message as LiveMessageReactions;
        return JSON.stringify({ success: true, source: 'live', messages: [formatLive(live, now)] });
      }
    } catch (error) {
      logger.warn('[reaction] live read failed, falling back to the log:', error);
    }
    // Message gone or Discord unreachable: the 14-day log may still know (Artie's own messages).
    const rows = listStandingReactions({
      guildId,
      channelId: String(channelId),
      messageId,
      sinceMs: MAX_HOURS * HOUR_MS,
      now,
    });
    if (rows.length === 0) {
      return JSON.stringify({
        success: false,
        error: 'could not read that message live, and nothing is logged for it in this conversation',
      });
    }
    return JSON.stringify({ success: true, source: 'log', messages: formatPersisted(rows, now, 1) });
  }

  const hours = clampInt(params.hours, DEFAULT_HOURS, 1, MAX_HOURS);
  const limit = clampInt(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  // Current channel only. A server-wide read returned snippets and reactor names from private
  // channels the asker can't see (Codex), and per-channel permission checks aren't worth it.
  try {
    const rows = listStandingReactions({
      guildId,
      channelId: String(channelId),
      scope: 'channel',
      sinceMs: hours * HOUR_MS,
      now,
    });
    return JSON.stringify({
      success: true,
      source: 'log',
      window_hours: hours,
      messages: formatPersisted(rows, now, limit),
    });
  } catch (error) {
    logger.error('[reaction] log read failed:', error);
    return JSON.stringify({ success: false, error: 'reaction log unavailable' });
  }
}

const ROLLUP_DEFAULT_HOURS = 7 * 24;

interface RoleCounts {
  from_asker: number;
  from_others: number;
  unknown: number;
}

interface RollupEmoji extends RoleCounts {
  emoji: string;
  count: number;
}

function emptyCounts(): RoleCounts {
  return { from_asker: 0, from_others: 0, unknown: 0 };
}

function addRole(counts: RoleCounts, role: PersistedReaction['reactorRole']): void {
  if (role === 'asker') counts.from_asker++;
  else if (role === 'other') counts.from_others++;
  else counts.unknown++;
}

/**
 * A reply excerpt can name the very person who reacted ("thanks Alice"), which would undo the
 * anonymity (Codex). Their @-mentions and display names become "someone".
 */
export function redactReactors(excerpt: string | undefined, reactors: PersistedReaction[] | undefined): string | undefined {
  if (!excerpt || !reactors) return excerpt;
  let text = excerpt;
  for (const r of reactors) {
    text = text.split(`<@${r.userId}>`).join('someone').split(`<@!${r.userId}>`).join('someone');
    const label = r.userLabel.trim();
    if (label.length === 0) continue;
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`(^|[^\\p{L}\\p{N}_])@?${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'giu'), '$1someone');
  }
  return text;
}

function emojiList(byEmoji: Map<string, RollupEmoji>): RollupEmoji[] {
  return [...byEmoji.values()].sort((a, b) => b.count - a.count);
}

/**
 * Feedback rollup over a longer window (Artie 2026-11-19: "a rollup over a longer window, so I
 * see patterns", whether the reactor was the person he answered, removed reactions, and the
 * reply text). The privacy rule, approved with the feature by EJ the same day:
 *  - never a reactor's name or id, only asker / someone else / unknown
 *  - opted-out and banned people's reactions are left out entirely
 *  - in a server: that server's counts, reply text only from the current channel (whose
 *    history the asker can read); other channels are counts with no text
 *  - in a DM: that DM only
 *  - off Discord (API/bridge, loopback or token only): every server, never a DM
 * `rows` is the window's events, oldest first; `textChannelId` limits which replies show text
 * (null = all of them).
 */
export function buildRollup(
  rows: PersistedReaction[],
  now: number,
  limit: number,
  textChannelId: string | null
): {
  totals: RollupEmoji[];
  taken_back: number;
  messages: Array<{ message_id: string; snippet: string; age: string; taken_back: number; reactions: RollupEmoji[] }>;
  counted_without_text: number;
} {
  const kept = rows.filter((r) => !isOptedOut(r.userId) && !isBlockedUser(r.userId));
  // Latest event per (message, emoji, person) decides whether the reaction still stands.
  const latest = new Map<string, PersistedReaction>();
  const takenBackBy = new Map<string, number>();
  let takenBack = 0;
  for (const r of kept) {
    const key = `${r.messageId}\u0000${r.emoji}\u0000${r.userId}`;
    // A removal counts unless it repeats one already seen; its add may predate the window.
    if (r.action === 'removed') {
      if (latest.get(key)?.action !== 'removed') {
        takenBack++;
        takenBackBy.set(r.messageId, (takenBackBy.get(r.messageId) ?? 0) + 1);
      }
    }
    latest.set(key, r);
  }

  // Everyone who reacted to each message in the window, to blank them out of its excerpt.
  // All rows, not just kept: an opted-out or banned reactor must not stay named either (Codex).
  const reactorsOn = new Map<string, PersistedReaction[]>();
  for (const r of rows) {
    const list = reactorsOn.get(r.messageId) ?? [];
    list.push(r);
    reactorsOn.set(r.messageId, list);
  }

  const totals = new Map<string, RollupEmoji>();
  const perMessage = new Map<string, { rows: PersistedReaction[]; byEmoji: Map<string, RollupEmoji> }>();
  let withoutText = 0;
  for (const r of latest.values()) {
    if (r.action !== 'added') continue;
    const total = totals.get(r.emoji) ?? { emoji: r.emojiLabel || r.emoji, count: 0, ...emptyCounts() };
    total.count++;
    addRole(total, r.reactorRole);
    totals.set(r.emoji, total);
    if (textChannelId !== null && r.channelId !== textChannelId) {
      withoutText++;
      continue;
    }
    const entry = perMessage.get(r.messageId) ?? { rows: [], byEmoji: new Map<string, RollupEmoji>() };
    entry.rows.push(r);
    const e = entry.byEmoji.get(r.emoji) ?? { emoji: r.emojiLabel || r.emoji, count: 0, ...emptyCounts() };
    e.count++;
    addRole(e, r.reactorRole);
    entry.byEmoji.set(r.emoji, e);
    perMessage.set(r.messageId, entry);
  }

  const messages = [...perMessage.entries()]
    .map(([messageId, entry]) => {
      const last = Math.max(...entry.rows.map((r) => r.at));
      return {
        message_id: messageId,
        snippet: snippetOf(
          redactReactors(entry.rows.find((r) => r.messageExcerpt)?.messageExcerpt, reactorsOn.get(messageId))
        ),
        age: ageLabel(last, now),
        taken_back: takenBackBy.get(messageId) ?? 0,
        reactions: emojiList(entry.byEmoji),
        weight: entry.rows.length,
        last,
      };
    })
    .sort((a, b) => b.weight - a.weight || b.last - a.last)
    .slice(0, limit)
    .map(({ weight: _w, last: _l, ...rest }) => rest);

  return { totals: emojiList(totals), taken_back: takenBack, messages, counted_without_text: withoutText };
}

async function rollupReactions(params: any, context?: CapabilityContext): Promise<string> {
  // Scope comes ONLY from the conversation, never from model-supplied params.
  const channelId = context?.channelId ?? null;
  const guildId = context?.guildId ?? null;
  const now = Date.now();
  const hours = clampInt(params.hours, ROLLUP_DEFAULT_HOURS, 1, MAX_HOURS);
  const limit = clampInt(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);

  let scope = 'every server, no DMs (API/bridge view)';
  let textChannelId: string | null = null;
  if (channelId) {
    let allowed = false;
    const askerId = context?.userId;
    if (askerId) {
      try {
        allowed = await gateway.canReadHistory(String(channelId), guildId, String(askerId));
      } catch {
        allowed = false;
      }
    }
    if (!allowed) {
      return JSON.stringify({
        success: false,
        error: "you'd need Read Message History in this channel to look up reactions here",
      });
    }
    scope = 'this DM';
    if (guildId) {
      scope = 'this server (reply text from this channel only)';
      textChannelId = String(channelId);
    }
  }

  try {
    const rows = listReactionEvents({ guildId, channelId, sinceMs: hours * HOUR_MS, now });
    return JSON.stringify({
      success: true,
      window_hours: hours,
      scope,
      privacy: 'reactors are never named: asker = the person that reply answered',
      ...buildRollup(rows, now, limit, textChannelId),
    });
  } catch (error) {
    logger.error('[reaction] rollup failed:', error);
    return JSON.stringify({ success: false, error: 'reaction log unavailable' });
  }
}

export const discordReactionCapability: RegisteredCapability = {
  name: 'discord-reaction',
  emoji: '😶',
  actions: {
    react: {
      effect: 'discord',
      params: {
        emoji: { type: 'string', description: 'A single emoji to react with', required: true },
        message_id: {
          type: 'string',
          description: 'Message to react to (default: the message you are responding to)',
        },
      },
    },
    read: {
      effect: 'read',
      params: {
        message_id: {
          type: 'string',
          description: 'Read live reactions on this message in the current conversation',
        },
        hours: { type: 'integer', description: 'Look back this many hours (default 24, max 336)' },
        limit: { type: 'integer', description: 'Max messages to return (default 10, max 25)' },
      },
    },
    rollup: {
      effect: 'read',
      params: {
        hours: { type: 'integer', description: 'Look back this many hours (default 168 = a week, max 336)' },
        limit: { type: 'integer', description: 'Max replies to list (default 10, max 25)' },
      },
    },
  },
  supportedActions: ['react', 'read', 'rollup'],
  description:
    'React to a message with a single emoji. By default you react to the message you are ' +
    'responding to right now — just pass an emoji. When a message is genuinely poignant, ' +
    'profound, or absurdly moving, hit it with one unhinged, obscure emoji (🪳 🦴 🕳️ 🧌 🛗 🪗 ' +
    '🫀 🧷 🪬 🚽 🦟 🧫) instead of explaining the joke. Optional message_id to react to a specific message. ' +
    'action="read" looks reactions up: with message_id it reads that message live (emoji, counts, who); ' +
    'without it, it lists who reacted to your recent messages in this conversation (last 24h by default, ' +
    'kept 14 days). It only sees this channel, or this DM. ' +
    'action="rollup" is your feedback pattern over a longer window (default a week): emoji totals, ' +
    'how many came from the person each reply answered vs someone else, reactions taken back, and ' +
    'your most-reacted replies with their text. Never names anyone. In a server it counts the whole ' +
    'server but shows reply text only from this channel; in a DM only that DM; through the API it ' +
    'covers every server and no DMs.',
  requiredParams: [],
  examples: [
    '<capability name="discord-reaction" action="read" />',
    '<capability name="discord-reaction" action="read" message_id="1520088794551025684" />',
    '<capability name="discord-reaction" action="react" emoji="🪳" />',
    '<capability name="discord-reaction" action="react" emoji="🛗" message_id="1520088794551025684" />',
  ],

  handler: async (params: any, _content: string | undefined, context?: CapabilityContext) => {
    if (params.action === 'read') {
      return readReactions(params, context);
    }
    if (params.action === 'rollup') {
      return rollupReactions(params, context);
    }
    // channelId is auto-injected into params (like discord-threads); context is a fallback.
    const channelId = params.channelId || context?.channelId;
    const messageId = params.message_id || context?.messageId;
    const emoji = String(params.emoji || '').trim();

    if (!channelId || !messageId) {
      return JSON.stringify({
        success: false,
        error: 'need a channel and a message to react to (none in context)',
      });
    }
    if (!emoji) {
      return JSON.stringify({ success: false, error: 'emoji param is required' });
    }

    try {
      // Gateway's POST /api/channels/:id/messages/:id/reactions, in-process since wave 9
      const resp = await gateway.addReaction(String(channelId), String(messageId), { emoji });
      const data = resp.body as any;
      if (!gateway.isOk(resp) || !data.success) {
        return JSON.stringify({ success: false, error: data.error || 'reaction failed' });
      }
      logger.info(`[reaction] ${emoji} on ${messageId}`);
      return JSON.stringify({ success: true, message: `Reacted ${emoji}` });
    } catch (error) {
      logger.error('[reaction] failed:', error);
      return JSON.stringify({ success: false, error: 'reaction request failed — discord service may be down' });
    }
  },
};
