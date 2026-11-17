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
import { listStandingReactions, type PersistedReaction } from '../../../shared/db/reaction-store.js';

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
    const byEmoji = new Map<string, string[]>();
    for (const r of list) {
      const who = byEmoji.get(r.emoji) ?? [];
      who.push(r.userLabel);
      byEmoji.set(r.emoji, who);
    }
    const reactions: ReactionView[] = [...byEmoji.entries()].map(([emoji, who]) => ({
      emoji,
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
    return JSON.stringify({ success: false, error: 'no channel in context to read reactions from' });
  }
  const now = Date.now();
  const messageId = String(params.message_id || '').trim();

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
  let scope: 'channel' | 'guild' = 'channel';
  if (params.scope === 'guild') scope = 'guild';
  try {
    const rows = listStandingReactions({
      guildId,
      channelId: String(channelId),
      scope,
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
        scope: {
          type: 'string',
          enum: ['channel', 'guild'],
          description: 'channel (default) or the whole server; DMs only ever see their own channel',
        },
      },
    },
  },
  supportedActions: ['react', 'read'],
  description:
    'React to a message with a single emoji. By default you react to the message you are ' +
    'responding to right now — just pass an emoji. When a message is genuinely poignant, ' +
    'profound, or absurdly moving, hit it with one unhinged, obscure emoji (🪳 🦴 🕳️ 🧌 🛗 🪗 ' +
    '🫀 🧷 🪬 🚽 🦟 🧫) instead of explaining the joke. Optional message_id to react to a specific message. ' +
    'action="read" looks reactions up: with message_id it reads that message live (emoji, counts, who); ' +
    'without it, it lists who reacted to your recent messages in this conversation (last 24h by default, ' +
    'kept 14 days). It only sees this server/channel, or this DM.',
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
