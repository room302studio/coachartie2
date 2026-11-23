/**
 * Guild message search for Artie's own use (the discord-search tool). EJ, 2026-11-23: "a tool
 * he uses internally only, and allow him to search only the guild/server he is currently in".
 *
 * Uses Discord's GET /guilds/{guild.id}/messages/search (needs READ_MESSAGE_HISTORY and the
 * MESSAGE_CONTENT intent, which Artie has since DISCORD_PRIVILEGED_INTENTS=true). His own
 * messages table only holds messages addressed to him, so Discord's index is the real source.
 *
 * Scope, all enforced here, never by the model:
 *  - the guild is the conversation's guild (the caller passes it from turn context);
 *  - only channels the person Artie is talking to can see and read history in. Someone who
 *    isn't a member (a system turn) gets what @everyone can see;
 *  - and only what the conversation's whole audience can see (audienceCanRead): every role and
 *    individually-granted member that can view the conversation channel must be able to read
 *    the result channel. So a moderator asking in #general never pulls #mods text into a
 *    public reply (Codex);
 *  - forum and media channels are searched through their parent id: Discord expands a parent
 *    filter to every thread under it, archived ones included (probed live 2026-11-23). A hit in
 *    a thread counts only if it's a public thread whose parent the asker can read;
 *  - private threads are left out (membership, not permissions, decides who sees them);
 *  - opted-out and banned users' messages are dropped.
 */
import type { Client } from 'discord.js';
import { logger } from '../../shared/logger.js';
import { isBlockedUser } from '../../shared/blocklist.js';
import { isOptedOut } from '../../shared/privacy-opt-out.js';

export const SEARCH_MAX_LIMIT = 25;
const EXCERPT_MAX = 300;
/** Discord accepts at most 500 channel_id filters per search. */
const MAX_CHANNEL_FILTERS = 500;
/** Index-not-ready (202) retries: Discord says wait retry_after; we cap the total wait. */
const MAX_INDEX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 5000;
const PRIVATE_THREAD_TYPE = 12;
/** Announcement and public threads: their permissions come from the parent channel. */
const PUBLIC_THREAD_TYPES = new Set([10, 11]);
/** Forum and media channels hold only threads; discord.js says they aren't text-based. */
const THREAD_ONLY_TYPES = new Set([15, 16]);
/** Discord API error code 10007, "Unknown Member". */
const UNKNOWN_MEMBER = 10007;
/** Discord API error codes 10003 "Unknown Channel" and 50001 "Missing Access". */
const UNKNOWN_CHANNEL = 10003;
const MISSING_ACCESS = 50001;
const SNOWFLAKE = /^\d{15,22}$/;
/** Discord's epoch (2015-01-01T00:00:00Z), the zero point of snowflake timestamps. */
const DISCORD_EPOCH_MS = 1420070400000;

export interface SearchOptions {
  query?: string;
  authorId?: string;
  channelId?: string;
  limit?: number;
  sortBy?: 'timestamp' | 'relevance';
  /** The channel the conversation is in (from turn context, never the model): sets the audience. */
  fromChannelId?: string;
  /** Only messages after / before this date (anything Date.parse reads, e.g. 2026-05-01). */
  after?: string;
  before?: string;
}

/** Extra result pages to read when hidden hits crowd out visible ones (Codex). */
const MAX_PAGES = 3;

/** True when a `before` bound is at or before Discord existed, so nothing can match. */
export function beforeDiscord(date: string | undefined): boolean {
  const ms = Date.parse(String(date || ''));
  return Number.isFinite(ms) && ms <= DISCORD_EPOCH_MS;
}

/** The smallest snowflake at a date, or undefined if the date doesn't parse or predates Discord. */
export function snowflakeAt(date: string | undefined): string | undefined {
  const ms = Date.parse(String(date || ''));
  if (!Number.isFinite(ms) || ms <= DISCORD_EPOCH_MS) {
    return undefined;
  }
  return String(BigInt(ms - DISCORD_EPOCH_MS) << 22n);
}

export interface SearchHit {
  author: string;
  authorId: string;
  channel: string;
  channelId: string;
  timestamp: string;
  excerpt: string;
  url: string;
}

/** Text flattened to one line and cut to EXCERPT_MAX characters. */
export function excerptOf(text: string | undefined | null): string {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= EXCERPT_MAX) {
    return flat;
  }
  return flat.slice(0, EXCERPT_MAX - 1) + '…';
}

interface RawAttachment {
  filename?: unknown;
  content_type?: unknown;
}
interface RawEmbed {
  title?: unknown;
  url?: unknown;
}
interface RawSticker {
  name?: unknown;
}

/** "image", "audio", "video" or "file", from a MIME type. */
function attachmentKind(contentType: unknown): string {
  const kind = String(contentType || '').split('/')[0];
  if (kind === 'image' || kind === 'audio' || kind === 'video') {
    return kind;
  }
  return 'file';
}

function listOf<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }
  return [];
}

/**
 * What a message holds besides text, as short markers (Artie, 2026-11-23: an image post came
 * back as a blank excerpt and he couldn't tell what it was). Works on the search API's raw shape
 * (attachments / embeds / sticker_items arrays).
 */
export function contentMarkers(m: {
  attachments?: unknown;
  embeds?: unknown;
  sticker_items?: unknown;
  message_snapshots?: unknown;
}): string[] {
  const out: string[] = [];
  // A forward has no content of its own: the text lives in the snapshot (Artie's blank Nov 4
  // excerpt was one). Same channel, same audience, so it's as readable as the forward itself.
  for (const s of listOf<{ message?: { content?: unknown; attachments?: unknown; embeds?: unknown } }>(m.message_snapshots)) {
    const inner = s.message ?? {};
    const text = String(inner.content || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const parts = [text, ...contentMarkers({ attachments: inner.attachments, embeds: inner.embeds })].filter(Boolean);
    out.push(`[forwarded: ${parts.join(' ') || 'a message'}]`);
  }
  for (const a of listOf<RawAttachment>(m.attachments)) {
    out.push(`[${attachmentKind(a.content_type)}: ${String(a.filename || 'unnamed').slice(0, 60)}]`);
  }
  for (const e of listOf<RawEmbed>(m.embeds)) {
    const label = String(e.title || e.url || '').slice(0, 80);
    if (label) {
      out.push(`[embed: ${label}]`);
    } else {
      out.push('[embed]');
    }
  }
  for (const s of listOf<RawSticker>(m.sticker_items)) {
    out.push(`[sticker: ${String(s.name || '').slice(0, 40)}]`);
  }
  return out;
}

/** A requested limit clamped to 1..25 (default 10). */
export function clampLimit(limit: number | undefined): number {
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n) || n < 1) {
    return 10;
  }
  return Math.min(n, SEARCH_MAX_LIMIT);
}

/** The search query string: repeated channel_id keys, as Discord's array params expect. */
export function buildSearchQuery(opts: SearchOptions, channelIds: string[]): URLSearchParams {
  const q = new URLSearchParams();
  const content = String(opts.query || '').trim().slice(0, 1024);
  if (content) {
    q.set('content', content);
  }
  if (opts.authorId) {
    q.append('author_id', opts.authorId);
  }
  for (const id of channelIds.slice(0, MAX_CHANNEL_FILTERS)) {
    q.append('channel_id', id);
  }
  const minId = snowflakeAt(opts.after);
  if (minId) {
    q.set('min_id', minId);
  }
  const maxId = snowflakeAt(opts.before);
  if (maxId) {
    q.set('max_id', maxId);
  }
  q.set('limit', String(clampLimit(opts.limit)));
  if (opts.sortBy === 'relevance') {
    q.set('sort_by', 'relevance');
  }
  return q;
}

/**
 * The hit message from each result group (Discord returns an array of arrays; the context
 * messages it once sent alongside are gone, but take the one flagged `hit` if present).
 */
export function pickHits(groups: unknown): any[] {
  if (!Array.isArray(groups)) {
    return [];
  }
  const hits: any[] = [];
  for (const group of groups) {
    if (!Array.isArray(group) || group.length === 0) {
      continue;
    }
    const flagged = group.find((m: any) => m && m.hit);
    hits.push(flagged || group[0]);
  }
  return hits;
}

/**
 * The display name of a hit's channel if the asker may see it, else undefined. A channel in the
 * allowed set is fine; a thread Discord listed in the response (not in our cache, e.g. an
 * archived forum post) is fine only if it's public and its parent is in the allowed set.
 */
export function visibleChannelName(
  channelId: string,
  allowedChannels: Map<string, string>,
  threads: Map<string, any>
): string | undefined {
  if (allowedChannels.has(channelId)) {
    return allowedChannels.get(channelId) || channelId;
  }
  const thread = threads.get(channelId);
  if (!thread || !PUBLIC_THREAD_TYPES.has(Number(thread.type))) {
    return undefined;
  }
  const parentId = String(thread.parent_id || '');
  if (!allowedChannels.has(parentId)) {
    return undefined;
  }
  return `${thread.name || channelId} (in #${allowedChannels.get(parentId)})`;
}

/** Hits the asker may see, minus opted-out/banned authors, shaped for the model. */
export function shapeHits(
  hits: any[],
  guildId: string,
  allowedChannels: Map<string, string>,
  displayName: (userId: string, fallback: string) => string,
  threads: Map<string, any> = new Map()
): SearchHit[] {
  const out: SearchHit[] = [];
  for (const m of hits) {
    const channelId = String(m?.channel_id || '');
    const authorId = String(m?.author?.id || '');
    const channelName = visibleChannelName(channelId, allowedChannels, threads);
    if (!channelName || !authorId) {
      continue;
    }
    if (isBlockedUser(authorId) || isOptedOut(authorId)) {
      continue;
    }
    out.push({
      author: displayName(authorId, m.author.global_name || m.author.username || 'someone'),
      authorId,
      channel: channelName,
      channelId,
      timestamp: String(m.timestamp || ''),
      excerpt: excerptOf([m.content, ...contentMarkers(m)].filter(Boolean).join(' ')),
      url: `https://discord.com/channels/${guildId}/${channelId}/${m.id}`,
    });
  }
  return out;
}

interface Readable {
  /** Channels, forum/media parents and cached public threads both can read: id → name. */
  allowed: Map<string, string>;
  /** The ids to send as channel_id filters: everything in `allowed` except threads. */
  filterIds: string[];
  /** True when Artie can read some channel the asker can't, so it was left out. */
  skipped: boolean;
}

const canRead = (p: any) => Boolean(p) && p.has('ViewChannel') && p.has('ReadMessageHistory');

/** Discord permission overwrite type for a single member (0 is a role). */
const MEMBER_OVERWRITE = 1;

function overwritesOf(ch: any): any[] {
  return [...(ch?.permissionOverwrites?.cache?.values?.() || [])];
}

/**
 * True when no holder of this role can view the conversation channel: the channel denies the
 * role ViewChannel and no role overwrite allows it (role allows beat role denies). Members with
 * their own allow are checked one by one elsewhere.
 */
function roleShutOut(conv: any, roleId: string): boolean {
  const ows = overwritesOf(conv);
  const denied = ows.some((o: any) => String(o.id) === roleId && o.deny?.has?.('ViewChannel'));
  const anyRoleAllow = ows.some((o: any) => o.type !== MEMBER_OVERWRITE && o.allow?.has?.('ViewChannel'));
  return denied && !anyRoleAllow;
}

/**
 * True when a channel (a thread's parent stands in) denies viewing or history to one member or
 * to a role other than @everyone, and that member or role's holders could be in the
 * conversation's audience. Checking roles one at a time can't see those (someone holding the
 * conversation's role plus the denied role), so such channels are left out, failing closed
 * (Codex). A restriction role that is also shut out of the conversation (Subway Builder's
 * "clueless", denied in 24 channels) is harmless and doesn't count.
 */
export function hasTargetedDeny(guild: any, ch: any, conv?: any): boolean {
  let target = ch;
  if (ch?.isThread?.()) {
    target = guild.channels.cache.get(String(ch.parentId));
    if (!target) {
      return true;
    }
  }
  const everyoneId = String(guild.roles.everyone?.id ?? guild.id);
  for (const o of overwritesOf(target)) {
    if (String(o.id) === everyoneId) {
      continue;
    }
    if (!o.deny?.has?.('ViewChannel') && !o.deny?.has?.('ReadMessageHistory')) {
      continue;
    }
    if (!conv) {
      return true;
    }
    if (o.type === MEMBER_OVERWRITE) {
      const member = guild.members.cache.get(String(o.id));
      if (!member || conv.permissionsFor?.(member)?.has('ViewChannel')) {
        return true;
      }
      continue;
    }
    if (!roleShutOut(conv, String(o.id))) {
      return true;
    }
  }
  return false;
}

/**
 * Whether everyone who can see the conversation can also read a given channel. The audience is
 * every role that can view the conversation channel (a thread's parent stands in for the thread)
 * plus members granted view individually; each must be able to read the result channel. Checking
 * roles, not just @everyone, matters on servers that gate #general behind a member role (Codex).
 * An unknown conversation channel is judged as @everyone, the strict choice.
 */
export function audienceCanRead(guild: any, fromChannelId: string | undefined): (ch: any) => boolean {
  const everyone = guild.roles.everyone;
  let conv: any = fromChannelId && guild.channels.cache.get(String(fromChannelId));
  if (conv?.isThread?.()) {
    conv = guild.channels.cache.get(String(conv.parentId));
  }
  if (!conv) {
    return (ch: any) => !hasTargetedDeny(guild, ch) && canRead(ch.permissionsFor?.(everyone));
  }
  const roles = [...(guild.roles.cache?.values?.() || [everyone])];
  const viewerRoles = roles.filter((r: any) => conv.permissionsFor?.(r)?.has('ViewChannel'));
  const overwrites = [...(conv.permissionOverwrites?.cache?.values?.() || [])];
  const viewerMembers = overwrites
    .filter((o: any) => o.type === MEMBER_OVERWRITE && o.allow?.has?.('ViewChannel'))
    .map((o: any) => String(o.id));
  return (ch: any) => {
    if (hasTargetedDeny(guild, ch, conv)) {
      return false;
    }
    for (const role of viewerRoles) {
      if (!canRead(ch.permissionsFor?.(role))) {
        return false;
      }
    }
    for (const id of viewerMembers) {
      // A member we can't resolve fails closed.
      const member = guild.members.cache.get(id);
      if (!member || !canRead(ch.permissionsFor?.(member))) {
        return false;
      }
    }
    return true;
  };
}

/**
 * Channels (forum and media parents, and cached public threads) in this guild that Artie, the
 * asker and the conversation's whole audience can view and read history in.
 * A non-member asker is judged as @everyone.
 */
async function readableChannels(guild: any, askerId: string | null, fromChannelId?: string): Promise<Readable> {
  const everyone = guild.roles.everyone;
  const audienceOk = audienceCanRead(guild, fromChannelId);
  let viewer: any = everyone;
  // A non-snowflake asker is a system turn (observational-system, the bridge): @everyone.
  if (askerId && SNOWFLAKE.test(askerId)) {
    try {
      viewer = await guild.members.fetch(askerId);
    } catch (error: any) {
      // Only a confirmed "not a member" may fall back to @everyone. Any other failure (network,
      // rate limit) fails closed: a member's deny overwrites must never be skipped (Codex).
      if (error?.code !== UNKNOWN_MEMBER) {
        throw error;
      }
    }
  }
  const me = guild.members.me;
  const allowed = new Map<string, string>();
  const filterIds: string[] = [];
  let skipped = false;
  const channels = [...guild.channels.cache.values()];
  for (const ch of channels as any[]) {
    if (!ch || ch.type === PRIVATE_THREAD_TYPE) {
      continue;
    }
    const threadOnly = THREAD_ONLY_TYPES.has(ch.type);
    if (!ch.isTextBased?.() && !threadOnly) {
      continue;
    }
    const theirs = ch.permissionsFor?.(viewer);
    const mine = me && ch.permissionsFor?.(me);
    if (!theirs || !mine || !canRead(mine)) {
      continue;
    }
    if (!canRead(theirs) || !audienceOk(ch)) {
      skipped = true;
      continue;
    }
    allowed.set(String(ch.id), String(ch.name || ch.id));
    if (!ch.isThread?.()) {
      filterIds.push(String(ch.id));
    }
  }
  return { allowed, filterIds, skipped };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The requested channel id if the asker and audience may read it, else undefined. A channel in
 * the allowed set is fine; an uncached thread (e.g. an archived forum post) is looked up and must
 * be public, in this guild, under an allowed parent. On a hit its name is added to `allowed`.
 */
async function resolveWantedChannel(
  discordClient: Client,
  guildId: string,
  allowed: Map<string, string>,
  wanted: string
): Promise<string | undefined> {
  if (allowed.has(wanted)) {
    return wanted;
  }
  let thread: any = null;
  try {
    thread = await discordClient.channels.fetch(wanted);
  } catch (error: any) {
    // Only "no such channel" / "no access" mean empty; an outage must look like one (Codex).
    if (error?.code !== UNKNOWN_CHANNEL && error?.code !== MISSING_ACCESS) {
      throw error;
    }
  }
  const raw = { type: thread?.type, parent_id: thread?.parentId, name: thread?.name };
  const name = visibleChannelName(wanted, allowed, new Map([[wanted, raw]]));
  if (name && thread?.guildId === guildId) {
    allowed.set(wanted, name);
    return wanted;
  }
  return undefined;
}

/**
 * Which of this guild's channels the asker and the conversation's whole audience may read
 * (`allowed`), and whether one requested channel or thread is among them (`ok`). The same check
 * search and channel reads use, exported for tools with their own fetch path (discord-forums).
 */
export async function audienceReadable(
  discordClient: Client,
  guildId: string,
  askerId: string | null,
  fromChannelId: string | undefined,
  channelId?: string
): Promise<{ allowed: Set<string>; ok: boolean }> {
  const guild: any = discordClient.guilds.cache.get(guildId);
  if (!guild) {
    return { allowed: new Set(), ok: false };
  }
  const { allowed } = await readableChannels(guild, askerId, fromChannelId);
  let ok = false;
  if (channelId) {
    ok = Boolean(await resolveWantedChannel(discordClient, guildId, allowed, String(channelId)));
  }
  return { allowed: new Set(allowed.keys()), ok };
}

export interface ReadOptions {
  channelId: string;
  /** The conversation's channel (from turn context, never the model): sets the audience. */
  fromChannelId?: string;
  limit?: number;
  /** Message ids to page by: only messages before / after this one. */
  before?: string;
  after?: string;
  pinned?: boolean;
}

export interface ReadMessage extends SearchHit {
  id: string;
}

/**
 * Recent or pinned messages in one channel or thread, for Artie's own context: the
 * discord-channels tool (2026-11-23; before this its routes were never served and every call
 * got a 404). Same scope as search, through the same checks: this guild only, a channel the
 * asker and the conversation's whole audience can read, public threads under such a channel,
 * opted-out and banned authors dropped. Oldest first, each with its id, so Artie can react to or
 * reply about "the message three back".
 */
export async function readChannelMessages(
  discordClient: Client,
  guildId: string | null,
  askerId: string | null,
  opts: ReadOptions
): Promise<{ status: number; body: any }> {
  if (!guildId) {
    return { status: 400, body: { success: false, error: 'reading a channel only works inside a server' } };
  }
  try {
    const guild: any = discordClient.guilds.cache.get(guildId);
    if (!guild) {
      return { status: 404, body: { success: false, error: 'not in that server' } };
    }
    const { allowed } = await readableChannels(guild, askerId, opts.fromChannelId);
    const wanted = await resolveWantedChannel(discordClient, guildId, allowed, String(opts.channelId || ''));
    if (!wanted) {
      return {
        status: 403,
        body: { success: false, error: 'not a channel everyone in this conversation can read (or not in this server)' },
      };
    }
    const channel: any = await discordClient.channels.fetch(wanted);
    if (!channel?.messages?.fetch) {
      return {
        status: 400,
        body: { success: false, error: 'that is a forum: read one of its posts (threads), or search it with discord-search' },
      };
    }
    let fetched: any;
    if (opts.pinned) {
      fetched = await channel.messages.fetchPinned();
    } else {
      const query: Record<string, unknown> = { limit: clampLimit(opts.limit) };
      if (opts.before && SNOWFLAKE.test(String(opts.before))) {
        query.before = String(opts.before);
      }
      if (opts.after && SNOWFLAKE.test(String(opts.after))) {
        query.after = String(opts.after);
      }
      fetched = await channel.messages.fetch(query);
    }
    const raw = [...(fetched?.values?.() || [])].map((m: any) => ({
      id: m.id,
      channel_id: wanted,
      author: { id: m.author?.id, username: m.author?.username, global_name: m.author?.globalName },
      content: m.content,
      // Same raw shape the search API returns, so contentMarkers can label non-text posts.
      attachments: [...(m.attachments?.values?.() || [])].map((a) => ({ filename: a.name, content_type: a.contentType })),
      embeds: (m.embeds || []).map((e: { title?: string; url?: string }) => ({ title: e.title, url: e.url })),
      sticker_items: [...(m.stickers?.values?.() || [])].map((s) => ({ name: s.name })),
      message_snapshots: [...(m.messageSnapshots?.values?.() || [])].map(
        (s: { content?: string; attachments?: Map<string, { name?: string; contentType?: string | null }>; embeds?: Array<{ title?: string | null; url?: string | null }> }) => ({
          message: {
            content: s.content,
            attachments: [...(s.attachments?.values() || [])].map((a) => ({ filename: a.name, content_type: a.contentType })),
            embeds: (s.embeds || []).map((e) => ({ title: e.title, url: e.url })),
          },
        })
      ),
      timestamp: m.createdAt?.toISOString?.() || '',
    }));
    const displayName = (userId: string, fallback: string) => guild.members.cache.get(userId)?.displayName || fallback;
    // The message id is the last segment of each hit's jump link.
    const messages: ReadMessage[] = shapeHits(raw, guildId, allowed, displayName)
      .map((h) => ({ ...h, id: h.url.slice(h.url.lastIndexOf('/') + 1) }))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return {
      status: 200,
      body: { success: true, channel: allowed.get(wanted) || wanted, channelId: wanted, count: messages.length, messages },
    };
  } catch (error: any) {
    logger.warn('[channel-read] failed:', error?.message || error);
    return { status: 502, body: { success: false, error: 'Discord read failed' } };
  }
}

/** One search page, waiting out "index not ready" (202, code 110000); null if it never warms. */
async function fetchSearchPage(discordClient: Client, guildId: string, q: URLSearchParams): Promise<any | null> {
  for (let attempt = 0; attempt <= MAX_INDEX_RETRIES; attempt += 1) {
    const body: any = await discordClient.rest.get(`/guilds/${guildId}/messages/search`, { query: q });
    if (body?.code !== 110000) {
      return body;
    }
    if (attempt < MAX_INDEX_RETRIES) {
      const waitMs = Math.min(Math.max(Number(body.retry_after || 0) * 1000, 500), MAX_RETRY_WAIT_MS);
      await sleep(waitMs);
    }
  }
  return null;
}

export async function searchGuildMessages(
  discordClient: Client,
  guildId: string | null,
  askerId: string | null,
  opts: SearchOptions
): Promise<{ status: number; body: any }> {
  if (!guildId) {
    return { status: 400, body: { success: false, error: 'search only works inside a server' } };
  }
  const query = String(opts.query || '').trim();
  if (!query && !opts.authorId) {
    return { status: 400, body: { success: false, error: 'give a query (words to find) or an author' } };
  }
  // Searching an opted-out or banned author must not even reveal whether they matched.
  if (opts.authorId && (isBlockedUser(opts.authorId) || isOptedOut(opts.authorId))) {
    return { status: 200, body: { success: true, total: 0, results: [] } };
  }
  try {
    const guild: any = discordClient.guilds.cache.get(guildId);
    if (!guild) {
      return { status: 404, body: { success: false, error: 'not in that server' } };
    }
    if (beforeDiscord(opts.before)) {
      return { status: 200, body: { success: true, total: 0, more: false, results: [] } };
    }
    const { allowed, filterIds, skipped } = await readableChannels(guild, askerId, opts.fromChannelId);
    let channelIds = filterIds;
    if (opts.channelId) {
      // One channel, forum or thread, and only if the asker and audience can read it.
      channelIds = [];
      const wanted = await resolveWantedChannel(discordClient, guildId, allowed, String(opts.channelId));
      if (wanted) {
        channelIds = [wanted];
      }
    }
    if (channelIds.length === 0) {
      return { status: 200, body: { success: true, total: 0, results: [], note: 'no channels you can search here' } };
    }
    // Fetch full pages and trim after filtering, so a hidden match (opted-out author, private
    // thread) can't displace a visible one and reveal itself through a small limit. Keep reading
    // pages until there's one visible hit past the limit, which is also what `more` means (Codex).
    const displayName = (userId: string, fallback: string) => {
      const member = guild.members.cache.get(userId);
      return member?.displayName || fallback;
    };
    const limit = clampLimit(opts.limit);
    const visible: SearchHit[] = [];
    // No "stopped early" note when the page cap ends the loop: it would fire only when many
    // hidden matches exist, which lets someone probe private text by keyword (Codex).
    for (let page = 0; page < MAX_PAGES && visible.length <= limit; page += 1) {
      const q = buildSearchQuery({ ...opts, limit: SEARCH_MAX_LIMIT }, channelIds);
      if (page > 0) {
        q.set('offset', String(page * SEARCH_MAX_LIMIT));
      }
      const body = await fetchSearchPage(discordClient, guildId, q);
      if (!body && page === 0) {
        return {
          status: 200,
          body: { success: true, total: 0, results: [], note: 'Discord is still indexing this server; try again in a minute' },
        };
      }
      if (!body) {
        break;
      }
      const threads = new Map<string, any>();
      for (const t of Array.isArray(body.threads) ? body.threads : []) {
        if (t?.id) {
          threads.set(String(t.id), t);
        }
      }
      const rawHits = pickHits(body.messages);
      visible.push(...shapeHits(rawHits, guildId, allowed, displayName, threads));
      if (rawHits.length < SEARCH_MAX_LIMIT) {
        break;
      }
    }
    const results = visible.slice(0, limit);
    const more = visible.length > limit;
    const notes: string[] = [];
    if (more) {
      notes.push('more matches exist than shown: narrow with after/before, a channel or an author');
    }
    if (filterIds.length > MAX_CHANNEL_FILTERS) {
      notes.push(`searched ${MAX_CHANNEL_FILTERS} of ${filterIds.length} channels`);
    }
    if (skipped) {
      notes.push(
        'channels this person cannot read were not searched, so no result means nobody said it where they can see, not nowhere'
      );
    }
    let note: string | undefined;
    if (notes.length > 0) {
      note = notes.join('; ');
    }
    logger.info(`[message-search] guild ${guildId}: ${results.length} hits`);
    // Only the filtered count: Discord's total_results includes opted-out/banned authors and
    // channels the asker can't read, so it would leak that they matched (Codex).
    // `searched` counts only channels the asker and audience can see, so it reveals nothing; it
    // lets a zero read as "looked everywhere you can see" instead of just quiet (Artie).
    const searched = Math.min(channelIds.length, MAX_CHANNEL_FILTERS);
    return { status: 200, body: { success: true, total: results.length, more, searched, results, note } };
  } catch (error: any) {
    logger.warn('[message-search] failed:', error?.message || error);
    return { status: 502, body: { success: false, error: 'Discord search failed' } };
  }
}
