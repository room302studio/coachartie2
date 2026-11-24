/**
 * The gateway's in-process API: the ONLY gateway module the engine may import
 * (tests/architecture.test.ts, wave 9).
 *
 * Before wave 9 the engine reached the gateway over loopback HTTP (:47321 /api/*, and :47319
 * /health for the forums tool). Each function here calls the same handler body the HTTP route
 * calls (routes/discord-proxy.ts, routes/moderation.ts, routes/mention-proxy-api.ts,
 * health.ts) and returns that route's `{ status, body }`, so a caller that used to branch on
 * `response.status` / `await response.json()` reads `.status` / `.body` instead.
 *
 * Bodies go through `wire()` (a JSON round trip), so a handler sees exactly what the HTTP
 * route would have parsed.
 *
 * The gateway registers its live Discord client here at ClientReady — the same moment the
 * :47321 server used to start listening. Calls before that (or after shutdown) reject with
 * GatewayUnavailableError, the in-process equivalent of the connection-refused error the
 * HTTP call got while the gateway wasn't up.
 *
 * Route modules are imported lazily so that importing this file (every engine tool that
 * talks to Discord does) never drags the gateway's module graph into the engine's at load.
 */
import type { Client } from 'discord.js';
import { type ApiResult, wire } from '../shared/api-result.js';
import type { TrustedGuildId, TrustedUserId, TrustedChannelId } from '../shared/trusted-ids.js';

export type { ApiResult } from '../shared/api-result.js';
export { isOk, statusText } from '../shared/api-result.js';

export class GatewayUnavailableError extends Error {
  constructor() {
    super('gateway unavailable: the Discord client is not connected');
    this.name = 'GatewayUnavailableError';
  }
}

let liveClient: Client | null = null;

/** Called by the gateway at ClientReady with its client, and with null at shutdown. */
export function registerGatewayClient(client: Client | null): void {
  liveClient = client;
}

function client(): Client {
  if (!liveClient) throw new GatewayUnavailableError();
  return liveClient;
}

/** Discord channel types that hold messages or posts: text, announcement, threads, forum, media. */
const NAMEABLE_CHANNEL_TYPES = new Set([0, 5, 10, 11, 12, 15, 16]);

/**
 * This guild's channels and cached threads as {id, name, public} for name lookup
 * (engine/tools/discord/channel-names.ts). `public` = @everyone can view it. Empty when the
 * gateway isn't up or the guild isn't cached, so a name simply doesn't resolve.
 */
export function guildChannelEntries(guildId: string): Array<{ id: string; name: string; public: boolean }> {
  if (!liveClient) {
    return [];
  }
  const guild = liveClient.guilds.cache.get(guildId);
  if (!guild) {
    return [];
  }
  const everyone = guild.roles.everyone;
  const out: Array<{ id: string; name: string; public: boolean }> = [];
  for (const ch of guild.channels.cache.values() as Iterable<any>) {
    if (!ch || !NAMEABLE_CHANNEL_TYPES.has(ch.type)) {
      continue;
    }
    // Threads are never suggested: a private thread under a public parent reads as viewable by
    // @everyone in discord.js (membership isn't a permission), so its title could leak (Codex).
    const isThread = Boolean(ch.isThread?.());
    const perms = ch.permissionsFor?.(everyone);
    out.push({ id: String(ch.id), name: String(ch.name || ''), public: !isThread && Boolean(perms?.has('ViewChannel')) });
  }
  return out;
}

const proxy = () => import('./routes/discord-proxy.js');
const moderation = () => import('./routes/moderation.js');
const mentionProxy = () => import('./routes/mention-proxy-api.js');

// --- DMs and channel posts (was POST :47321/api/dm, /api/channels/:id/messages) ---

/** POST /api/dm without the HTTP Bearer check (the caller is this process). */
export async function sendDm(body: {
  userId: string;
  message?: string;
  fileBase64?: string;
  fileName?: string;
}): Promise<ApiResult> {
  const c = client();
  return (await proxy()).sendDm(c, wire(body));
}

/** POST /api/channels/:channelId/messages: text and/or a base64 file (tts voice notes, sbat). */
export async function sendChannelMessage(
  channelId: string,
  body: { content?: string; fileBase64?: string; fileName?: string }
): Promise<ApiResult> {
  const c = client();
  return (await proxy()).sendChannelMessage(c, { channelId }, wire(body));
}

/**
 * sendChannelMessage, but splitting first (4-reply/chunks.ts — Discord's 2000-char limit,
 * code-block aware). The engine has text this long exactly once today (scribe mode's meeting
 * summary, engine/jobs/scribe/orchestrator.ts): chunking is gateway-zone code, so this is the
 * one seam function rather than the engine reaching into gateway/4-reply/ directly. Sends
 * chunks in order and stops at the first failure.
 */
export async function sendChunkedChannelMessage(channelId: string, content: string): Promise<ApiResult> {
  const { chunkMessage } = await import('./4-reply/chunks.js');
  const chunks = chunkMessage(content);
  if (!chunks) {
    return { status: 400, body: { error: 'nothing to send' } };
  }
  let last: ApiResult = { status: 200, body: {} };
  for (const chunk of chunks) {
    last = await sendChannelMessage(channelId, { content: chunk });
    if (last.status >= 400) return last;
  }
  return last;
}

// --- the discord tools' proxy actions ---

export async function createPoll(channelId: string, body: any): Promise<ApiResult> {
  const c = client();
  return (await proxy()).createPoll(c, { channelId }, wire(body));
}

export async function readPoll(channelId: string, messageId: string): Promise<ApiResult> {
  const c = client();
  return (await proxy()).readPoll(c, { channelId, messageId });
}

export async function addReaction(
  channelId: string,
  messageId: string,
  body: { emoji?: string }
): Promise<ApiResult> {
  const c = client();
  return (await proxy()).addReaction(c, { channelId, messageId }, wire(body));
}

/**
 * Live reactions on one message (message.reactions + a capped users fetch). The channel and
 * guild come from the conversation, never from the model; a channel outside that guild is
 * refused (403).
 */
export async function readMessageReactions(
  channelId: string,
  messageId: string,
  guildId: string | null
): Promise<ApiResult> {
  const c = client();
  const { fetchLiveReactions } = await import('./1-receive/reaction-log.js');
  return fetchLiveReactions(c, channelId, messageId, guildId);
}

/** Whether userId may read this channel's history (always true in a DM). Fails closed. */
export async function canReadHistory(
  channelId: string,
  guildId: string | null,
  userId: string
): Promise<boolean> {
  const c = client();
  const { requesterCanReadHistory } = await import('./1-receive/reaction-log.js');
  return requesterCanReadHistory(c, channelId, guildId, userId);
}

/**
 * Search this guild's messages (Discord's guild search), limited to channels the asker can
 * read; a non-member asker is judged as @everyone. The guild and asker come from the
 * conversation, never from the model. See routes/message-search.ts.
 */
export async function searchGuildMessages(
  guildId: TrustedGuildId | null,
  askerId: TrustedUserId | null,
  opts: import('./routes/message-search.js').SearchOptions
): Promise<ApiResult> {
  const c = client();
  const { searchGuildMessages: search } = await import('./routes/message-search.js');
  return search(c, guildId, askerId, opts);
}

// --- The scribe as a tool (rules in routes/scribe-control.ts) ---

const scribe = () => import('./routes/scribe-control.js');

export async function scribeStatus(
  guildId: TrustedGuildId | null,
  askerId: TrustedUserId | null,
  fromChannelId: TrustedChannelId | undefined
): Promise<ApiResult> {
  const c = client();
  return (await scribe()).scribeStatus(c, guildId, askerId, fromChannelId);
}

export async function scribeLastSummary(
  guildId: TrustedGuildId | null,
  askerId: TrustedUserId | null,
  fromChannelId: TrustedChannelId | undefined
): Promise<ApiResult> {
  const c = client();
  return (await scribe()).scribeLastSummary(c, guildId, askerId, fromChannelId);
}

export async function scribeStart(
  guildId: TrustedGuildId | null,
  userId: TrustedUserId | null,
  fromChannelId: TrustedChannelId | undefined,
  voiceChannelId: string | undefined
): Promise<ApiResult> {
  const c = client();
  return (await scribe()).scribeStart(c, guildId, userId, fromChannelId, voiceChannelId);
}

export async function scribeStop(
  guildId: TrustedGuildId | null,
  userId: TrustedUserId | null,
  fromChannelId: TrustedChannelId | undefined
): Promise<ApiResult> {
  const c = client();
  return (await scribe()).scribeStop(c, guildId, userId, fromChannelId);
}

// --- Artie's own writes: threads, forum posts, edits (rules in routes/discord-write.ts) ---

const writes = () => import('./routes/discord-write.js');

export async function createThread(
  guildId: TrustedGuildId | null,
  fromChannelId: TrustedChannelId | undefined,
  opts: import('./routes/discord-write.js').ThreadOptions
): Promise<ApiResult> {
  const c = client();
  return (await writes()).createThread(c, guildId, fromChannelId, opts);
}

export async function createForumPost(
  guildId: TrustedGuildId | null,
  opts: import('./routes/discord-write.js').PostOptions
): Promise<ApiResult> {
  const c = client();
  return (await writes()).createForumPost(c, guildId, opts);
}

export async function editOwnMessage(
  guildId: TrustedGuildId | null,
  who: { askerId: TrustedUserId | null; fromChannelId: TrustedChannelId | undefined; askerIsOwner: boolean },
  opts: import('./routes/discord-write.js').EditOptions
): Promise<ApiResult> {
  const c = client();
  return (await writes()).editOwnMessage(c, guildId, who, opts);
}

/** True in a server where Artie may post outside the conversation channel (Room 302). */
export async function mayPostElsewhere(guildId: string | null | undefined): Promise<boolean> {
  return (await writes()).POST_GUILD_IDS.has(String(guildId ?? ''));
}

type Asker = { askerId: TrustedUserId | null; fromChannelId: TrustedChannelId | undefined; askerIsOwner: boolean };
type MessageRef = import('./routes/discord-write.js').MessageRef;

export async function deleteOwnMessage(guildId: TrustedGuildId | null, who: Asker, ref: MessageRef): Promise<ApiResult> {
  const c = client();
  return (await writes()).deleteOwnMessage(c, guildId, who, ref);
}

export async function setPinned(guildId: TrustedGuildId | null, who: Asker, ref: MessageRef, pinned: boolean): Promise<ApiResult> {
  const c = client();
  return (await writes()).setPinned(c, guildId, who, ref, pinned);
}

export async function endOwnPoll(guildId: TrustedGuildId | null, who: Asker, ref: MessageRef): Promise<ApiResult> {
  const c = client();
  return (await writes()).endOwnPoll(c, guildId, who, ref);
}

export async function readPollInGuild(
  guildId: TrustedGuildId | null,
  ref: MessageRef,
  fromChannelId: TrustedChannelId | undefined
): Promise<ApiResult> {
  const c = client();
  return (await writes()).readPollInGuild(c, guildId, ref, fromChannelId);
}

/** The audience check (routes/message-search.ts audienceReadable) for tools with their own fetch. */
export async function audienceReadable(
  guildId: TrustedGuildId,
  askerId: TrustedUserId | null,
  fromChannelId: TrustedChannelId | undefined,
  channelId?: string
): Promise<{ allowed: Set<string>; ok: boolean }> {
  const c = client();
  const { audienceReadable: check } = await import('./routes/message-search.js');
  return check(c, guildId, askerId, fromChannelId, channelId);
}

/**
 * Recent or pinned messages in one channel (the discord-channels tool), under the same scope as
 * search: guild, asker and conversation channel come from the turn context. See
 * routes/message-search.ts readChannelMessages.
 */
export async function readChannelMessages(
  guildId: TrustedGuildId | null,
  askerId: TrustedUserId | null,
  opts: import('./routes/message-search.js').ReadOptions
): Promise<ApiResult> {
  const c = client();
  const { readChannelMessages: read } = await import('./routes/message-search.js');
  return read(c, guildId, askerId, opts);
}

export async function setNickname(guildId: string, body: { nickname?: string | null }): Promise<ApiResult> {
  const c = client();
  return (await proxy()).setNickname(c, { guildId }, wire(body));
}

export async function listGuildForums(guildId: string): Promise<ApiResult> {
  const c = client();
  return (await proxy()).listGuildForums(c, { guildId });
}

export async function listForumThreads(forumId: string): Promise<ApiResult> {
  const c = client();
  return (await proxy()).listForumThreads(c, { forumId });
}

export async function getForumThread(threadId: string): Promise<ApiResult> {
  const c = client();
  return (await proxy()).getForumThread(c, { threadId });
}

export async function getForumSummary(forumId: string): Promise<ApiResult> {
  const c = client();
  return (await proxy()).getForumSummary(c, { forumId });
}

export async function syncForumToGitHub(forumId: string, body: { repo?: string }): Promise<ApiResult> {
  const c = client();
  return (await proxy()).syncForumToGitHub(c, { forumId }, wire(body));
}

export async function timeoutMember(body: any): Promise<ApiResult> {
  const c = client();
  return (await moderation()).timeoutMember(c, wire(body));
}

export async function addRole(body: any): Promise<ApiResult> {
  const c = client();
  return (await moderation()).addRole(c, wire(body));
}

export async function removeRole(body: any): Promise<ApiResult> {
  const c = client();
  return (await moderation()).removeRole(c, wire(body));
}

/**
 * A route the engine calls but the gateway never had a handler for: the discord-channels /
 * discord-threads / discord-user-history tools' GET /api/channels/:id/messages, /pins,
 * /messages/search, POST /api/channels/:id/threads, GET .../threads/:id/messages, and the
 * discord-environment context source's GET :47321/health. Over HTTP express answered 404;
 * this answers the same, so those keep failing exactly as they always have. Giving them
 * handlers is a feature (or a prompt change) for later, not part of the one-process move.
 */
export async function unservedRoute(method: string, path: string): Promise<ApiResult> {
  client();
  return { status: 404, body: { error: `Cannot ${method} ${path}` } };
}

/** :47319 GET /health (status + body), from the gateway's health server. */
export async function gatewayHealth(): Promise<ApiResult> {
  client(); // the health server only answered once the gateway was up
  return (await import('./health.js')).healthServer.healthCheck();
}

// --- mention-proxy rules (was :47321/api/mention-proxy/*). These need no Discord client,
// but the HTTP routes only existed while the gateway was up, so they keep that gate. ---

export const mentionProxyRules = {
  async list(): Promise<ApiResult> {
    client();
    return (await mentionProxy()).listProxyRules();
  },
  async get(id: string): Promise<ApiResult> {
    client();
    return (await mentionProxy()).getProxyRule({ id });
  },
  async listForGuild(guildId: string): Promise<ApiResult> {
    client();
    return (await mentionProxy()).listProxyRulesForGuild({ guildId });
  },
  async listForUser(userId: string): Promise<ApiResult> {
    client();
    return (await mentionProxy()).listProxyRulesForUser({ userId });
  },
  async create(body: any): Promise<ApiResult> {
    client();
    return (await mentionProxy()).createProxyRule(wire(body));
  },
  async update(id: string, body: any): Promise<ApiResult> {
    client();
    return (await mentionProxy()).updateProxyRule({ id }, wire(body));
  },
  async remove(id: string): Promise<ApiResult> {
    client();
    return (await mentionProxy()).deleteProxyRule({ id });
  },
};
