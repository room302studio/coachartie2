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
 * The gateway registers its live Discord client here at ClientReady — the same moment the
 * :47321 server used to start listening. Calls before that (or after shutdown) reject with
 * GatewayUnavailableError, the in-process equivalent of the connection-refused error the
 * HTTP call got while the gateway wasn't up.
 *
 * Route modules are imported lazily so that importing this file (every engine tool that
 * talks to Discord does) never drags the gateway's module graph into the engine's at load.
 */
import type { Client } from 'discord.js';
import type { ApiResult } from '../shared/api-result.js';

export type { ApiResult } from '../shared/api-result.js';
export { isOk } from '../shared/api-result.js';

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
  return (await proxy()).sendDm(c, body);
}

/** POST /api/channels/:channelId/messages: text and/or a base64 file (tts voice notes, sbat). */
export async function sendChannelMessage(
  channelId: string,
  body: { content?: string; fileBase64?: string; fileName?: string }
): Promise<ApiResult> {
  const c = client();
  return (await proxy()).sendChannelMessage(c, { channelId }, body);
}

// --- the discord tools' proxy actions ---

export async function createPoll(channelId: string, body: any): Promise<ApiResult> {
  const c = client();
  return (await proxy()).createPoll(c, { channelId }, body);
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
  return (await proxy()).addReaction(c, { channelId, messageId }, body);
}

export async function setNickname(guildId: string, body: { nickname?: string | null }): Promise<ApiResult> {
  const c = client();
  return (await proxy()).setNickname(c, { guildId }, body);
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
  return (await proxy()).syncForumToGitHub(c, { forumId }, body);
}

export async function timeoutMember(body: any): Promise<ApiResult> {
  const c = client();
  return (await moderation()).timeoutMember(c, body);
}

export async function addRole(body: any): Promise<ApiResult> {
  const c = client();
  return (await moderation()).addRole(c, body);
}

export async function removeRole(body: any): Promise<ApiResult> {
  const c = client();
  return (await moderation()).removeRole(c, body);
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
    return (await mentionProxy()).createProxyRule(body);
  },
  async update(id: string, body: any): Promise<ApiResult> {
    client();
    return (await mentionProxy()).updateProxyRule({ id }, body);
  },
  async remove(id: string): Promise<ApiResult> {
    client();
    return (await mentionProxy()).deleteProxyRule({ id });
  },
};
