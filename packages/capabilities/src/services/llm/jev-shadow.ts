/**
 * Jev shadow mode — compare TypeSafe's Jev against the micro LLM, without
 * letting it change anything.
 *
 * Jev (https://docs.typesafe.ai) answers typed questions with calibrated
 * probabilities: a "noul" is askYesNo, a "choice" is pickOne. When
 * JEV_API_KEY is set, each micro decision is also sent to Jev in the
 * background and both answers are logged side by side. The micro LLM's
 * answer is always the one returned; Jev never blocks or alters a call.
 *
 * Off unless JEV_API_KEY is set (JEV_SHADOW=0 also turns it off). Respects
 * the generation kill switch. Note: turning it on sends the micro-call
 * context (Discord message text) to TypeSafe.
 */

import { appendFile } from 'node:fs/promises';
import { logger, assertGenerationAllowed } from '@coachartie/shared';

const JEV_URL = process.env.JEV_API_URL || 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = process.env.JEV_MODEL || 'jev-latest';
const JEV_TIMEOUT_MS = 5000;

export const jevShadowEnabled = () =>
  !!process.env.JEV_API_KEY && process.env.JEV_SHADOW !== '0';

interface JevAnswer {
  type: 'noul' | 'choice' | 'score';
  noul?: number;
  choice?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

type JevQuestion =
  | { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> };

async function askJev(state: string, question: JevQuestion): Promise<JevAnswer> {
  assertGenerationAllowed('jev-shadow');
  const res = await fetch(JEV_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.JEV_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ state, model: JEV_MODEL, questions: { q: question } }),
    signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Jev ${res.status}`);
  const body = (await res.json()) as { answers?: { q?: JevAnswer } };
  if (!body.answers?.q) throw new Error('Jev response missing answer');
  return body.answers.q;
}

export interface ShadowRecord {
  helper: 'askYesNo' | 'pickOne';
  question: string;
  micro: string | boolean;
  microFallback: boolean;
  microMs: number;
  jev?: string | boolean;
  /** P(yes) for askYesNo, P(chosen option) for pickOne */
  jevProbability?: number;
  jevConfidence?: number;
  jevMs?: number;
  agree?: boolean;
  error?: string;
}

async function record(rec: ShadowRecord) {
  logger.info('[jev-shadow]', rec);
  const file = process.env.JEV_SHADOW_LOG;
  if (file) await appendFile(file, `${JSON.stringify({ t: Date.now(), ...rec })}\n`).catch(() => {});
}

/** Fire-and-forget: compare a finished askYesNo with Jev's answer */
export function shadowYesNo(
  question: string,
  context: string,
  micro: { result: boolean; fallback: boolean },
  microMs: number
) {
  if (!jevShadowEnabled()) return;
  const started = Date.now();
  const base = { helper: 'askYesNo' as const, question, micro: micro.result, microFallback: micro.fallback, microMs };
  askJev(context, {
    type: 'noul',
    instructions: question,
    criteria: { true: 'Yes', false: 'No' },
  })
    .then((a) => {
      const p = a.noul ?? 0;
      const jev = p >= 0.5;
      return record({ ...base, jev, jevProbability: p, jevMs: Date.now() - started, agree: jev === micro.result });
    })
    .catch((err) => record({ ...base, error: String(err?.message || err) }));
}

/** Fire-and-forget: compare a finished pickOne with Jev's answer */
export function shadowPickOne<T extends string>(
  question: string,
  context: string,
  options: T[],
  micro: { result: T; fallback: boolean },
  microMs: number
) {
  if (!jevShadowEnabled()) return;
  // Choice caps at 255 options
  if (options.length < 2 || options.length > 255) return;
  const started = Date.now();
  const base = { helper: 'pickOne' as const, question, micro: micro.result, microFallback: micro.fallback, microMs };
  askJev(context, {
    type: 'choice',
    instructions: question,
    criteria: Object.fromEntries(options.map((o) => [o, null])),
  })
    .then((a) => {
      const jev = a.choice ?? '';
      return record({
        ...base,
        jev,
        jevProbability: a.probabilities?.[jev],
        jevConfidence: a.confidence,
        jevMs: Date.now() - started,
        agree: jev === micro.result,
      });
    })
    .catch((err) => record({ ...base, error: String(err?.message || err) }));
}
