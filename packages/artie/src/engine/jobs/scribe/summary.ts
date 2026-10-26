/**
 * One summary LLM call over a scribe session's transcript (reuses the normal generation path —
 * openRouterService.generateFromMessageChain, same as channel-digest.ts). Produces a meeting
 * recap (decisions / action items / open questions) plus proposed GitHub changes as JSON. The
 * proposals are turned into gated capabilityRegistry.execute() calls by propose.ts — this file
 * only builds the prompt and tolerantly parses the reply (ledger #7, parseModelJson).
 */
import { logger } from '../../../shared/logger.js';
import { parseModelJson } from '../../../shared/model-json.js';
import type { JsonOutputSpec } from '../../../shared/structured-output.js';
import type { ScribeUtterance } from '../../../shared/db/scribe-store.js';
import { openRouterService } from '../../4-generate/openrouter.js';
import type { ScribeProposal, ScribeSummaryResult } from './types.js';

const MAX_TRANSCRIPT_CHARS = 16_000;

export function summaryModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // No per-task env override exists for this one — it rides SMART_MODEL (or the rotation,
  // if that's unset) like any other quality-sensitive one-shot call, per the build spec.
  return env.SMART_MODEL || undefined;
}

export function buildTranscriptBlock(utterances: ScribeUtterance[]): string {
  const lines = utterances.map((u) => `[${u.ts}] ${u.displayName}: ${u.text}`);
  const joined = lines.join('\n');
  if (joined.length <= MAX_TRANSCRIPT_CHARS) return joined;
  return `…(earlier lines truncated)…\n${joined.slice(-MAX_TRANSCRIPT_CHARS)}`;
}

export function buildSummaryPrompt(args: {
  defaultRepo: string;
  transcript: string;
}): string {
  return `You just listened to a meeting in Discord voice chat and have a speaker-attributed transcript. Write a summary and propose any GitHub issue changes that came out of it.

TRANSCRIPT:
${args.transcript}

Return JSON only, this exact shape:
{
  "summary": "...",
  "proposals": [
    { "kind": "create", "repo": "owner/repo", "title": "...", "body": "..." },
    { "kind": "update", "repo": "owner/repo", "issueNumber": 123, "title": "...", "body": "..." }
  ]
}

"summary": plain text, three sections in this order — Decisions, Action items (name the owner by their display name from the transcript, never invent a name), Open questions. Skip a section with nothing in it. No preamble.

"proposals": only for things someone explicitly asked to be filed or updated as a GitHub issue, or a clear bug/feature that came up as actionable work — not every topic discussed. Empty array is normal and expected for a meeting that didn't produce any. Default repo when none was named: "${args.defaultRepo}". "update" requires a real issue number mentioned in the transcript; if unsure whether something is a create or an update, use "create". Keep "body" to a few sentences: what, why, and who asked for it.`;
}

export const SCRIBE_SUMMARY_OUTPUT: JsonOutputSpec = {
  name: 'scribe_summary',
  schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      proposals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['create', 'update'] },
            repo: { type: 'string' },
            title: { type: 'string' },
            body: { type: 'string' },
            issueNumber: { type: ['number', 'null'] },
          },
          required: ['kind', 'repo', 'title', 'body'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'proposals'],
    additionalProperties: false,
  },
};

function isScribeProposal(value: unknown): value is ScribeProposal {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.kind !== 'create' && v.kind !== 'update') return false;
  if (typeof v.repo !== 'string' || !v.repo.includes('/')) return false;
  if (typeof v.title !== 'string' || v.title.trim().length === 0) return false;
  if (typeof v.body !== 'string' || v.body.trim().length === 0) return false;
  if (v.kind === 'update' && typeof v.issueNumber !== 'number') return false;
  return true;
}

/** Tolerant of junk: a missing/garbled "proposals" array just means no proposals, never a
 *  thrown error — one malformed entry doesn't sink the whole summary. */
export function parseScribeSummaryResponse(raw: string): ScribeSummaryResult {
  const parsed = parseModelJson<{ summary?: unknown; proposals?: unknown }>(raw, 'object');
  if (!parsed) {
    return { summaryText: raw.trim().slice(0, 4000), proposals: [] };
  }
  let summaryText = '';
  if (typeof parsed.summary === 'string' && parsed.summary.trim().length > 0) {
    summaryText = parsed.summary.trim();
  } else {
    summaryText = raw.trim().slice(0, 4000);
  }
  let proposals: ScribeProposal[] = [];
  if (Array.isArray(parsed.proposals)) {
    proposals = parsed.proposals.filter(isScribeProposal);
  }
  return { summaryText, proposals };
}

export async function generateScribeSummary(args: {
  sessionId: string;
  userId: string;
  guildId: string;
  defaultRepo: string;
  utterances: ScribeUtterance[];
}): Promise<ScribeSummaryResult> {
  if (args.utterances.length === 0) {
    return { summaryText: 'Nobody said anything that made it into the transcript.', proposals: [] };
  }
  const transcript = buildTranscriptBlock(args.utterances);
  const prompt = buildSummaryPrompt({ defaultRepo: args.defaultRepo, transcript });

  const raw = await openRouterService.generateFromMessageChain(
    [{ role: 'user', content: prompt }],
    args.userId,
    args.sessionId,
    summaryModel(),
    {
      guildId: args.guildId,
      maxTokens: 1200,
      stepType: 'scribe_summary',
      jsonOutput: SCRIBE_SUMMARY_OUTPUT,
    }
  );

  const result = parseScribeSummaryResponse(raw);
  logger.info(
    `📝 Scribe summary for session ${args.sessionId}: ${result.proposals.length} GitHub proposal(s)`
  );
  return result;
}
