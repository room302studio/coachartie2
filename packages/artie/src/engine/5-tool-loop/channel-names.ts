/**
 * Channel names for tool params. Artie, 2026-11-23: "Almost everything wants a raw channel or
 * guild ID. I can't say 'post in the beta channel' and have it land." So any tool param that
 * holds a channel (channelId, channel_id, forumId, threadId) also takes a name: "#beta", "beta",
 * a <#id> mention, or a thread's title. The registry resolves it against the conversation's own
 * server before the tool runs (registry.ts). Ids pass through untouched.
 *
 * This only turns a name into the id Artie could already pass; each tool keeps its own
 * permission checks. A miss on a "#name" fails with the public channel names to pick from, so
 * the retry lands; a bare word that matches nothing is left alone for the tool to judge.
 */
import { CallerError } from '../../shared/errors.js';
import * as gateway from '../../gateway/api.js';

export const CHANNEL_PARAM_KEYS = ['channelId', 'channel_id', 'forumId', 'threadId'] as const;
const SNOWFLAKE = /^\d{15,22}$/;
const MENTION = /^<#(\d{15,22})>$/;
const MAX_OPTIONS = 25;

export interface ChannelEntry {
  id: string;
  name: string;
  /** @everyone can view it: only these are offered as suggestions. */
  public: boolean;
}

/**
 * Lowercase, no leading #, letters/digits (any script)/dashes only, so "🤖prison-yard" matches
 * "prison-yard" and "#公告" still matches 公告 (Codex).
 */
export function normalizeChannelName(value: string): string {
  return String(value || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{M}\p{N}-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** The one channel a name means: an exact (normalized) match, else a unique partial one. */
export function matchChannel(entries: ChannelEntry[], wanted: string): ChannelEntry | undefined {
  const n = normalizeChannelName(wanted);
  if (!n) {
    return undefined;
  }
  const exact = entries.filter((e) => normalizeChannelName(e.name) === n);
  if (exact.length === 1) {
    return exact[0];
  }
  if (exact.length > 1) {
    return undefined;
  }
  const partial = entries.filter((e) => normalizeChannelName(e.name).includes(n));
  if (partial.length === 1) {
    return partial[0];
  }
  return undefined;
}

/** Params with any channel names swapped for ids from this guild. */
export function resolveChannelParams(params: any, guildId: string | undefined): any {
  if (!params || typeof params !== 'object' || !guildId) {
    return params;
  }
  let out = params;
  let entries: ChannelEntry[] | null = null;
  for (const key of CHANNEL_PARAM_KEYS) {
    const raw = params[key];
    if (typeof raw !== 'string') {
      continue;
    }
    const value = raw.trim();
    if (!value || SNOWFLAKE.test(value)) {
      continue;
    }
    const mention = MENTION.exec(value);
    if (mention) {
      out = { ...out, [key]: mention[1] };
      continue;
    }
    if (entries === null) {
      entries = gateway.guildChannelEntries(guildId);
    }
    const hit = matchChannel(entries, value);
    if (hit) {
      out = { ...out, [key]: hit.id };
      continue;
    }
    if (value.startsWith('#')) {
      const options = entries
        .filter((e) => e.public)
        .slice(0, MAX_OPTIONS)
        .map((e) => `#${e.name}`)
        .join(', ');
      throw new CallerError(`No single channel here matches "${value}" for ${key}. Channels: ${options}`);
    }
  }
  return out;
}
