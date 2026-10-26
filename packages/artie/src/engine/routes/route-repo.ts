/**
 * Repo → Discord channel routing, decided by Artie (a cheap model) when a GitHub org grows a
 * repo nobody mapped. The discord org watcher sends the repo and the guild's text channels;
 * this picks one and says why. Explicit mappings in github-org-watcher.ts always win, and
 * any failure here falls back to the watcher's name matching and default channel.
 *
 * One call per newly discovered repo, so cost is noise. Goes through openRouterService,
 * which means the kill switch, the daily budget and usage tracking all apply.
 */

import { Router } from 'express';
import { logger } from '../../shared/logger.js';
import { type ApiResult, sendResult } from '../../shared/api-result.js';

// Wave 9: the handler body is an exported function returning the status + JSON it used to
// send; the route sends it and engine/api.ts calls it in-process for the gateway.
const reply = (status: number, body: any): ApiResult => ({ status, body });
import { parseModelJson } from '../../shared/model-json.js';
import type { JsonOutputSpec } from '../../shared/structured-output.js';
import { openRouterService } from '../4-generate/openrouter.js';

export interface ChannelOption {
  id: string;
  name: string;
  topic?: string | null;
  category?: string | null;
}

export interface RepoInfo {
  fullName: string;
  description?: string | null;
  language?: string | null;
}

export interface RoutePick {
  channelId: string;
  reason: string;
}

/**
 * Format category for display
 */
function formatCategory(category: string | null | undefined): string {
  if (category) {
    return ` (category: ${category})`;
  }
  return '';
}

/**
 * Format topic for display
 */
function formatTopic(topic: string | null | undefined): string {
  if (topic) {
    return ` — ${topic.slice(0, 120)}`;
  }
  return '';
}

export function buildRoutePrompt(repo: RepoInfo, channels: ChannelOption[], existing: Array<{ repo: string; channel: string }>): string {
  const list = channels
    .map((c) => `- ${c.id} #${c.name}${formatCategory(c.category)}${formatTopic(c.topic)}`)
    .join('\n');
  const prior = existing.map((e) => `- ${e.repo} → #${e.channel}`).join('\n') || '(none yet)';
  return `You route GitHub activity into a team's Discord. A new repository appeared and needs a channel for its pull requests, reviews and CI.

NEW REPO: ${repo.fullName}
Description: ${repo.description || '(none)'}
Language: ${repo.language || '(unknown)'}

HOW EXISTING REPOS ARE ROUTED (a hint about which project owns which channels, not a rule):
${prior}

CHANNELS:
${list}

Pick the single channel where the people who work on this repo would want its updates. Match the repo's PURPOSE to a channel's purpose first: art, store pages or trailers go to marketing; design files to design; a channel named after this exact project beats everything. Among a project's channels, prefer engineering or robot channels for ordinary code. Never pick leadership, private or personal channels unless the repo is clearly about that. If nothing fits better than the studio-wide feed, pick that.

Return JSON only: {"channelId": "<one id from the list>", "reason": "<under 15 words>"}`;
}

/** The reply's shape, sent as response_format to models that take it (wave 10). */
export const ROUTE_OUTPUT: JsonOutputSpec = {
  name: 'repo_route',
  schema: {
    type: 'object',
    properties: { channelId: { type: 'string' }, reason: { type: 'string' } },
    required: ['channelId', 'reason'],
    additionalProperties: false,
  },
};

// The digit-strip below stays even with structured output: models still answer "<#111>".
export function parseRoutePick(raw: string, channels: ChannelOption[]): RoutePick | null {
  const j = parseModelJson<{ channelId?: unknown; reason?: unknown }>(raw, 'object');
  if (!j) return null;
  try {
    const id = String(j.channelId ?? '').replace(/[^0-9]/g, '');
    if (!channels.some((c) => c.id === id)) return null; // never trust an id we didn't offer
    let reason: string;
    if (typeof j.reason === 'string') {
      reason = j.reason.trim().slice(0, 140);
    } else {
      reason = '';
    }
    return { channelId: id, reason };
  } catch {
    return null;
  }
}

export async function pickRepoChannel(
  repo: RepoInfo,
  channels: ChannelOption[],
  existing: Array<{ repo: string; channel: string }>,
  guildId?: string
): Promise<RoutePick | null> {
  if (channels.length === 0) return null;
  const raw = await openRouterService.generateFromMessageChain(
    [{ role: 'user', content: buildRoutePrompt(repo, channels, existing) }],
    'repo-router',
    undefined,
    process.env.BACKGROUND_MODEL || process.env.FAST_MODEL,
    { guildId, maxTokens: 120, stepType: 'repo_routing', jsonOutput: ROUTE_OUTPUT }
  );
  return parseRoutePick(raw, channels);
}

/**
 * POST /api/route-repo: Artie picks the Discord channel for a newly discovered GitHub repo.
 * Moved verbatim out of engine/main.ts (wave 6); path and response shape are unchanged.
 * Mounted at /api by http.ts.
 */
export const routeRepoRouter: Router = Router();

routeRepoRouter.post('/route-repo', async (req, res) => sendResult(res, await routeRepo(req.body)));

/** POST /api/route-repo's body: Artie picks the channel for a new repo ({channelId, reason}). */
export async function routeRepo(body: any): Promise<ApiResult> {
  try {
    const { repo, channels, existing, guildId } = body || {};
    if (!repo?.fullName || !Array.isArray(channels)) {
      return reply(400, { error: 'repo.fullName and channels[] required' });
    }
    let existingRoutes: Array<{ repo: string; channel: string }>;
    if (Array.isArray(existing)) {
      existingRoutes = existing;
    } else {
      existingRoutes = [];
    }
    const pick = await pickRepoChannel(repo, channels, existingRoutes, guildId);
    let statusCode: number;
    let responseBody: RoutePick | { error: string };
    if (pick) {
      statusCode = 200;
      responseBody = pick;
    } else {
      statusCode = 422;
      responseBody = { error: 'no valid pick' };
    }
    return reply(statusCode, responseBody);
  } catch (error) {
    logger.warn('Repo routing endpoint error:', error);
    return reply(500, { error: 'routing failed' });
  }
}
