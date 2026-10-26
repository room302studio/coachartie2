/**
 * STT pricing (per-minute, Oct 2026 — openrouter.ai/openai/whisper-large-v3-turbo). Mirrors
 * usage-ledger.ts's MODEL_PRICING shape (per-unit, not per-token) so scribe spend can be
 * recorded through the same ledger and daily budget cap as everything else.
 */

export function scribeSttModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.SCRIBE_STT_MODEL || 'openai/whisper-large-v3-turbo';
}

/** $/minute. OpenRouter routes whisper-large-v3-turbo to Groq at ~$0.00066/min (verified
 *  2026-10-26 against openrouter.ai's provider pricing table). Unrecognized/overridden
 *  models are billed at the same safe-high default usage-ledger.ts uses for unknown LLMs:
 *  better to over-report spend than hide it. */
const STT_PER_MINUTE_USD: Record<string, number> = {
  'openai/whisper-large-v3-turbo': 0.00066,
  'openai/whisper-large-v3': 0.00186,
  'openai/gpt-4o-mini-transcribe': 0.003,
  'openai/gpt-4o-transcribe': 0.006,
};

const UNKNOWN_STT_PER_MINUTE_USD = 0.006;

export function sttPerMinuteUsd(model: string): number {
  return STT_PER_MINUTE_USD[model] ?? UNKNOWN_STT_PER_MINUTE_USD;
}

export function computeSttCostUsd(seconds: number, model: string): number {
  return (seconds / 60) * sttPerMinuteUsd(model);
}
