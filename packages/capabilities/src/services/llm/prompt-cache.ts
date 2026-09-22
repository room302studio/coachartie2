/**
 * Anthropic prompt caching, applied at the OpenRouter boundary.
 *
 * Every reply ships a large system prefix that is byte-identical call to call: PROMPT_SYSTEM,
 * the guild persona file, the capability manifest, the message-format protocol. Measured
 * 2026-09-22 that prefix was roughly 8.8K of a ~20K prompt, re-billed at full price on all
 * 15,122 calls in the table. Cache reads bill at ~0.1x, so marking it is the single biggest
 * lever on spend that changes nothing about what the model sees.
 *
 * Three rules make or break this, all of them silent when violated:
 *
 *  1. Caching is a PREFIX match. Any byte that changes ahead of the breakpoint invalidates
 *     everything after it. The date used to be prepended to the system prompt — that alone
 *     made the whole prefix uncacheable on every request (see context-alchemy's assembly).
 *  2. Each model has a MINIMUM cacheable prefix. Below it nothing caches and no error is
 *     raised — you just pay the write premium forever. Haiku 4.5 needs 4096, four times
 *     Opus 4.8 / Sonnet 5.
 *  3. Only Anthropic models understand cache_control. OpenAI and Google models on OpenRouter
 *     must keep the plain-string message shape.
 *
 * Verify with cached_tokens in model_usage_stats, never by reading the code and assuming.
 */

import { estimateTokens } from '@coachartie/shared';

/** Minimum cacheable prefix, in tokens, keyed by OpenRouter model id. */
const CACHE_MIN_TOKENS: Record<string, number> = {
  'anthropic/claude-opus-4.8': 1024,
  'anthropic/claude-sonnet-5': 1024,
  'anthropic/claude-sonnet-4.6': 1024,
  'anthropic/claude-sonnet-4.5': 1024,
  'anthropic/claude-opus-4.7': 2048,
  'anthropic/claude-opus-4.6': 4096,
  'anthropic/claude-opus-4.5': 4096,
  'anthropic/claude-haiku-4.5': 4096,
};

/**
 * Unknown Anthropic models get the highest minimum we know of. Guessing low would mark a
 * prefix that never caches and bill the 1.25x write on every call — the expensive mistake.
 */
const UNKNOWN_ANTHROPIC_MIN = 4096;

export type WireContent = string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
export interface WireMessage {
  role: 'system' | 'user' | 'assistant';
  content: WireContent;
}

export function supportsPromptCaching(model: string): boolean {
  return model.startsWith('anthropic/');
}

export function cacheMinimumFor(model: string): number {
  return CACHE_MIN_TOKENS[model] ?? UNKNOWN_ANTHROPIC_MIN;
}

export interface CacheDecision {
  messages: WireMessage[];
  /** Whether a breakpoint was actually placed — logged so a silent no-op is visible. */
  applied: boolean;
  reason: string;
  prefixTokens: number;
}

/**
 * Put a single cache breakpoint on the leading system message.
 *
 * One breakpoint, not four. The static system block is the only real stability boundary:
 * the "Relevant context" block and the channel transcript change every message, so marking
 * them would pay a write premium on bytes that are never read back.
 */
export function applyCacheControl(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  model: string
): CacheDecision {
  if (!supportsPromptCaching(model)) {
    return { messages, applied: false, reason: 'non-anthropic model', prefixTokens: 0 };
  }

  const firstSystemIndex = messages.findIndex((m) => m.role === 'system');
  if (firstSystemIndex === -1) {
    return { messages, applied: false, reason: 'no system message', prefixTokens: 0 };
  }

  const prefix = messages[firstSystemIndex].content;
  const prefixTokens = estimateTokens(prefix);
  const minimum = cacheMinimumFor(model);

  if (prefixTokens < minimum) {
    return {
      messages,
      applied: false,
      reason: `prefix ${prefixTokens}tok below ${model} minimum ${minimum}tok`,
      prefixTokens,
    };
  }

  const wire: WireMessage[] = messages.map((m, i) =>
    i === firstSystemIndex
      ? {
          role: m.role,
          content: [{ type: 'text' as const, text: prefix, cache_control: { type: 'ephemeral' as const } }],
        }
      : { role: m.role, content: m.content }
  );

  return { messages: wire, applied: true, reason: 'ok', prefixTokens };
}

/**
 * Pull cached-prompt-token count out of an OpenRouter usage object.
 *
 * OpenRouter reports Anthropic cache hits on the OpenAI shape, under
 * prompt_tokens_details.cached_tokens, and it is a SUBSET of prompt_tokens. Some providers
 * spell it cache_read_input_tokens, so accept both rather than silently reading zero.
 */
export function readCachedTokens(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 0;
  const u = usage as Record<string, unknown>;

  const details = u.prompt_tokens_details;
  if (details && typeof details === 'object') {
    const cached = (details as Record<string, unknown>).cached_tokens;
    if (typeof cached === 'number') return cached;
  }

  const direct = u.cache_read_input_tokens;
  if (typeof direct === 'number') return direct;

  return 0;
}

/** Character length of a wire message, for input_length accounting. */
export function wireContentLength(content: WireContent): number {
  return typeof content === 'string'
    ? content.length
    : content.reduce((total, part) => total + part.text.length, 0);
}
