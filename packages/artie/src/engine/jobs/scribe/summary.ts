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

// Proposal call only (the summary itself is windowed). 16k cut a 37-min meeting to its last 15 min.
const MAX_TRANSCRIPT_CHARS = 120_000;

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

// ---------------------------------------------------------------------------------------------
// Fact summary: chunk → cheap model → concat (EJ, 2026-10-29). The single Opus call saw only the
// last 16k chars (a 37-min meeting lost its first 22 minutes) and squeezed it into three headings.
// Each ~5-minute window now goes to the cheap routed BACKGROUND_MODEL for factual bullets, and
// the windows are concatenated in time order. No pass over the whole meeting, so length is free.
// ---------------------------------------------------------------------------------------------
const WINDOW_MS = 5 * 60_000;
const WINDOW_MAX_CHARS = 12_000;
const WINDOW_CONCURRENCY = 3;

export interface WindowFacts {
  discussed: string[];
  decisions: string[];
  actions: string[];
  questions: string[];
}

const WINDOW_FACTS_OUTPUT: JsonOutputSpec = {
  name: 'scribe_window_facts',
  schema: {
    type: 'object',
    properties: {
      discussed: { type: 'array', items: { type: 'string' } },
      decisions: { type: 'array', items: { type: 'string' } },
      actions: { type: 'array', items: { type: 'string' } },
      questions: { type: 'array', items: { type: 'string' } },
    },
    required: ['discussed', 'decisions', 'actions', 'questions'],
    additionalProperties: false,
  },
};

export function factsModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.SCRIBE_FACTS_MODEL || env.BACKGROUND_MODEL || env.FAST_MODEL || undefined;
}

/** Consecutive utterances grouped into ~5-minute windows, split further if one gets huge. */
export function windowUtterances(utterances: ScribeUtterance[]): ScribeUtterance[][] {
  const windows: ScribeUtterance[][] = [];
  let current: ScribeUtterance[] = [];
  let start = 0;
  let chars = 0;
  for (const u of utterances) {
    const t = Date.parse(u.ts) || 0;
    const len = u.displayName.length + u.text.length + 3;
    if (current.length && (t - start >= WINDOW_MS || chars + len > WINDOW_MAX_CHARS)) {
      windows.push(current);
      current = [];
      chars = 0;
    }
    if (!current.length) start = t;
    current.push(u);
    chars += len;
  }
  if (current.length) windows.push(current);
  return windows;
}

function windowPrompt(lines: string): string {
  return `This is one ~5-minute slice of a meeting transcript (speaker: words). Extract what actually happened in THIS slice as short factual bullets.

TRANSCRIPT SLICE:
${lines}

Return JSON only: {"discussed": [...], "decisions": [...], "actions": [...], "questions": [...]}
- discussed: one bullet per distinct topic or point, with who said what ("Alex: the save bug needs another day"). Capture specifics: names, numbers, dates, places, products. Usually 2-6 bullets; more if the slice is dense.
- decisions: only things the group actually settled.
- actions: "Owner: task (when)". The owner is a speaker name exactly as written in the transcript; never invent one.
- questions: things left open or unresolved.
Use [] for anything empty. No commentary, no preamble. Transcription errors are likely; don't build facts on a garbled word.`;
}

export function parseWindowFacts(raw: string): WindowFacts | null {
  const parsed = parseModelJson<Partial<WindowFacts>>(raw, 'object');
  if (!parsed) return null;
  return {
    discussed: nonEmptyStrings(parsed.discussed),
    decisions: nonEmptyStrings(parsed.decisions),
    actions: nonEmptyStrings(parsed.actions),
    questions: nonEmptyStrings(parsed.questions),
  };
}

/** The trimmed, non-blank strings of a model-supplied list; anything else is dropped. */
function nonEmptyStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim());
}

function clock(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: process.env.TZ_DISPLAY || 'America/New_York' });
}

/** Concatenate window facts: discussed grouped under time headers, the rest merged + de-duped. */
export function concatWindowFacts(
  windows: Array<{ from: string; to: string; facts: WindowFacts | null }>
): string {
  const seen = new Set<string>();
  const merged = (key: 'decisions' | 'actions' | 'questions') =>
    windows.flatMap((w) => w.facts?.[key] ?? []).filter((s) => {
      const norm = s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
      if (seen.has(key + norm)) return false;
      seen.add(key + norm);
      return true;
    });
  const out: string[] = [];
  const discussed = windows
    .map((w) => {
      if (!w.facts) return `**${clock(w.from)}–${clock(w.to)}**\n- (couldn't summarize this stretch; the transcript is saved)`;
      if (!w.facts.discussed.length) return '';
      return `**${clock(w.from)}–${clock(w.to)}**\n` + w.facts.discussed.map((b) => `- ${b}`).join('\n');
    })
    .filter(Boolean);
  if (discussed.length) out.push('**Discussed**\n' + discussed.join('\n'));
  const section = (title: string, items: string[]) => {
    if (items.length) out.push(`**${title}**\n` + items.map((b) => `- ${b}`).join('\n'));
  };
  section('Decisions', merged('decisions'));
  section('Action items', merged('actions'));
  section('Open questions', merged('questions'));
  return out.join('\n\n') || 'Nothing substantive came up.';
}

export async function generateFactSummary(args: {
  sessionId: string;
  userId: string;
  guildId: string;
  utterances: ScribeUtterance[];
}): Promise<string> {
  const windows = windowUtterances(args.utterances);
  const results: Array<{ from: string; to: string; facts: WindowFacts | null }> = new Array(windows.length);
  let next = 0;
  const worker = async () => {
    while (next < windows.length) {
      const i = next++;
      const w = windows[i];
      let facts: WindowFacts | null = null;
      try {
        const raw = await openRouterService.generateFromMessageChain(
          [{ role: 'user', content: windowPrompt(w.map((u) => `${u.displayName}: ${u.text}`).join('\n')) }],
          args.userId,
          args.sessionId,
          factsModel(),
          { guildId: args.guildId, maxTokens: 1500, stepType: 'scribe_facts', jsonOutput: WINDOW_FACTS_OUTPUT }
        );
        facts = parseWindowFacts(raw);
      } catch (error) {
        logger.warn(`📝 Scribe window ${i + 1}/${windows.length} failed for ${args.sessionId}:`, error);
      }
      results[i] = { from: w[0].ts, to: w[w.length - 1].ts, facts };
    }
  };
  await Promise.all(Array.from({ length: Math.min(WINDOW_CONCURRENCY, windows.length) }, worker));
  logger.info(
    `📝 Scribe fact summary for ${args.sessionId}: ${windows.length} window(s), ${results.filter((r) => !r.facts).length} failed`
  );
  return concatWindowFacts(results);
}

export async function generateScribeSummary(args: {
  sessionId: string;
  userId: string;
  guildId: string;
  defaultRepo: string;
  utterances: ScribeUtterance[];
  /** false = summary only (auto-scribe): skip the GitHub-proposal call entirely. */
  withProposals?: boolean;
}): Promise<ScribeSummaryResult> {
  if (args.utterances.length === 0) {
    return { summaryText: 'Nobody said anything that made it into the transcript.', proposals: [] };
  }
  const summaryText = await generateFactSummary(args);
  if (args.withProposals === false) {
    return { summaryText, proposals: [] };
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
  // The posted summary is always the windowed fact summary; this call only contributes proposals.
  return { summaryText, proposals: result.proposals };
}
