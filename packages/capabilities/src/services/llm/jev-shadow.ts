/**
 * Jev shadow mode for the micro LLM — compare TypeSafe's Jev against askYesNo / pickOne and
 * the preflight analyzer, without letting it change anything.
 *
 * The generic machinery (shadowJev, the JSONL log, the on/off switch) lives in
 * @coachartie/shared so the discord process can shadow its own judges too; this file holds
 * the micro-LLM experiments. Off unless JEV_API_KEY is set (JEV_SHADOW=0 also turns it off).
 * Note: turning it on sends the micro-call context (Discord message text) to TypeSafe.
 */

import { shadowJev, compareNoul, compareChoice, bareOptions } from '@coachartie/shared';

export { jevShadowEnabled, shadowJev } from '@coachartie/shared';

/** Fire-and-forget: compare a finished askYesNo with Jev's answer */
export function shadowYesNo(
  question: string,
  context: string,
  micro: { result: boolean; fallback: boolean },
  microMs: number
) {
  shadowJev(
    'micro-yesno',
    context,
    { q: { type: 'noul', instructions: question, criteria: { true: 'Yes', false: 'No' } } },
    { helper: 'askYesNo', question, text: context, micro: micro.result, microFallback: micro.fallback, microMs },
    (a) => compareNoul(a.q, micro.result)
  );
}

/** Fire-and-forget: compare a finished pickOne with Jev's answer */
export function shadowPickOne<T extends string>(
  question: string,
  context: string,
  options: readonly T[],
  micro: { result: T; fallback: boolean },
  microMs: number
) {
  // Choice caps at 255 options
  if (options.length < 2 || options.length > 255) return;
  shadowJev(
    'micro-pickone',
    context,
    { q: { type: 'choice', instructions: question, criteria: bareOptions(options) } },
    { helper: 'pickOne', question, text: context, micro: micro.result, microFallback: micro.fallback, microMs },
    (a) => compareChoice(a.q, micro.result)
  );
}

export interface PreflightPick {
  question: string;
  options: readonly string[];
  result: string;
  fallback: boolean;
  ms: number;
}

/**
 * Fire-and-forget: the preflight analyzer makes one pickOne per question; ask Jev all of
 * them in ONE request and log per-question agreement plus single-request latency against
 * the micro calls (summed = sequential cost, max = the parallel wall time).
 */
export function shadowPreflightBatch(context: string, picks: Record<string, PreflightPick>) {
  const ids = Object.keys(picks);
  if (ids.length === 0) return;
  const ms = ids.map((id) => picks[id].ms);
  shadowJev(
    'preflight-batch',
    context,
    Object.fromEntries(
      ids.map((id) => [
        id,
        { type: 'choice' as const, instructions: picks[id].question, criteria: bareOptions(picks[id].options) },
      ])
    ),
    {
      text: context,
      micro: ids.map((id) => picks[id].result).join('/'),
      microFallback: ids.some((id) => picks[id].fallback),
      microMs: ms.reduce((a, b) => a + b, 0),
      microWallMs: Math.max(...ms),
      microCalls: ids.length,
    },
    (a) => {
      const parts = Object.fromEntries(
        ids.map((id) => [
          id,
          {
            micro: picks[id].result,
            microFallback: picks[id].fallback,
            microMs: picks[id].ms,
            ...compareChoice(a[id], picks[id].result),
          },
        ])
      );
      return {
        jev: ids.map((id) => parts[id].jev).join('/'),
        // Joint probability of the combined answer
        jevType: 'choice' as const,
        jevProbability: ids.reduce((p, id) => p * (parts[id].jevProbability ?? 0), 1),
        agree: ids.every((id) => parts[id].agree),
        parts,
      };
    }
  );
}
