/**
 * Jev shadow mode (core) — compare TypeSafe's Jev against whatever model makes a decision
 * today, without letting it change anything.
 *
 * Jev (https://docs.typesafe.ai/api.md) answers typed questions with calibrated
 * probabilities: a "noul" is yes/no, a "choice" picks one option, a "score" rates along
 * ordered levels. When JEV_API_KEY is set, an instrumented decision is also sent to Jev in
 * the background and both answers are logged side by side under an `experiment` name. The
 * incumbent answer is always the one used; Jev never blocks or alters a call.
 *
 * Off unless JEV_API_KEY is set (JEV_SHADOW=0 also turns it off). Respects the generation
 * kill switch. Logs `[jev-shadow]` and, with JEV_SHADOW_LOG=<path>, appends JSONL that
 * `npx tsx scripts/jev-shadow-report.ts` summarizes. Every string in a record is clipped to
 * 200 chars. Note: turning it on sends the decision's input (Discord message text, quiz
 * answers, Steam review text) to TypeSafe.
 *
 * Lives in shared so both the capabilities and discord processes can use it; the micro-LLM
 * wrappers are in packages/capabilities/src/services/llm/jev-shadow.ts.
 */

import { appendFile } from 'node:fs/promises';
import { logger } from './logger.js';
import { assertGenerationAllowed, isGenerationMuted } from './kill-switch.js';

const JEV_TIMEOUT_MS = 5000;
const FIELD_MAX = 200;

export const jevShadowEnabled = () =>
  !!process.env.JEV_API_KEY && process.env.JEV_SHADOW !== '0';

export type JevQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };

export interface JevAnswer {
  type: 'noul' | 'choice' | 'score';
  noul?: number;
  choice?: string;
  score?: number;
  legend?: Record<string, string>;
  probabilities?: Record<string, number>;
  confidence?: number;
}

/** One question's side-by-side result. */
export interface JevShadowPart {
  /** The incumbent's answer (micro LLM, Gemini judge, Steam thumbs…) */
  micro?: string | boolean;
  microFallback?: boolean;
  microMs?: number;
  jev?: string | boolean | number;
  jevType?: JevQuestion['type'];
  /** P(yes) for a noul, P(chosen option) for a choice */
  jevProbability?: number;
  jevConfidence?: number;
  agree?: boolean;
}

export interface JevShadowRecord extends JevShadowPart {
  experiment: string;
  /** Short input snippet for the report's disagreement list (clipped) */
  text?: string;
  jevMs?: number;
  /** Per-question results when one request carries several questions */
  parts?: Record<string, JevShadowPart>;
  error?: string;
  [extra: string]: unknown;
}

/** What a compare callback adds: Jev's side, and per-question parts for multi-question requests */
export type JevShadowResult = JevShadowPart & { parts?: Record<string, JevShadowPart> };

export const clipJev = (s: string, n = FIELD_MAX) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Clip every string in a record — nothing longer than 200 chars reaches a log. */
const clipStrings = (rec: JevShadowRecord): JevShadowRecord =>
  JSON.parse(JSON.stringify(rec, (_k, v) => (typeof v === 'string' ? clipJev(v) : v)));

export async function askJev(
  state: unknown,
  questions: Record<string, JevQuestion>
): Promise<Record<string, JevAnswer>> {
  assertGenerationAllowed('jev-shadow');
  const res = await fetch(process.env.JEV_API_URL || 'https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.JEV_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ state, model: process.env.JEV_MODEL || 'jev-latest', questions }),
    signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Jev ${res.status}`);
  const body = (await res.json()) as { answers?: Record<string, JevAnswer> };
  const answers = body.answers || {};
  for (const id of Object.keys(questions)) {
    if (!answers[id]) throw new Error(`Jev response missing answer "${id}"`);
  }
  return answers;
}

export async function recordJevShadow(rec: JevShadowRecord) {
  const safe = clipStrings(rec);
  logger.info('[jev-shadow]', safe);
  const file = process.env.JEV_SHADOW_LOG;
  if (file) await appendFile(file, `${JSON.stringify({ t: Date.now(), ...safe })}\n`).catch(() => {});
}

/**
 * Fire-and-forget: ask Jev `questions` about `state`, then log `legacy` (the incumbent's
 * side, already decided) merged with `compare(answers)`. Never throws, never awaited by the
 * caller, so it cannot change what Artie does.
 */
export function shadowJev(
  experiment: string,
  state: unknown,
  questions: Record<string, JevQuestion>,
  legacy: Omit<JevShadowRecord, 'experiment'>,
  compare: (answers: Record<string, JevAnswer>) => JevShadowResult
): void {
  if (!jevShadowEnabled() || isGenerationMuted()) return;
  const started = Date.now();
  const base: JevShadowRecord = { experiment, ...legacy };
  (async () => {
    try {
      const answers = await askJev(state, questions);
      await recordJevShadow({ ...base, ...compare(answers), jevMs: Date.now() - started });
    } catch (err) {
      await recordJevShadow({ ...base, error: String((err as Error)?.message || err) });
    }
  })().catch(() => {});
}

/** Noul answer → side-by-side part (agree only when the incumbent gave a boolean). */
export function compareNoul(a: JevAnswer, micro?: boolean | null): JevShadowPart {
  const p = a.noul ?? 0;
  const jev = p >= 0.5;
  return {
    jev,
    jevType: 'noul',
    jevProbability: p,
    ...(typeof micro === 'boolean' ? { agree: jev === micro } : {}),
  };
}

/** Choice answer → side-by-side part (agree only when the incumbent gave an option). */
export function compareChoice(a: JevAnswer, micro?: string | null): JevShadowPart {
  const jev = a.choice ?? '';
  return {
    jev,
    jevType: 'choice',
    jevProbability: a.probabilities?.[jev],
    jevConfidence: a.confidence,
    ...(typeof micro === 'string' ? { agree: jev === micro } : {}),
  };
}

/** Criteria map for a choice whose options need no description. */
export const bareOptions = (options: readonly string[]) =>
  Object.fromEntries(options.map((o) => [o, null])) as Record<string, null>;
