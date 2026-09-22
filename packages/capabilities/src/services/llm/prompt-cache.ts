/**
 * Anthropic prompt caching, applied at the OpenRouter boundary.
 *
 * Every reply ships a system prefix that is byte-identical call to call: PROMPT_SYSTEM, the
 * capability intro, the capability manifest and the message-format protocol. Measured
 * 2026-09-22 it is ~12,400 chars — about 4,600 real tokens for Opus/Sonnet, whose observed
 * ratio is ~2.7 chars/token, NOT the ~3,100 that estimateTokens' chars/4 heuristic reports.
 * Cache reads bill at ~0.1x, so marking it is the biggest lever on spend that changes
 * nothing about what the model sees.
 *
 * It does NOT contain the guild persona. `📚 COMMUNITY KNOWLEDGE` (subwaybuilder.md, 8.5KB)
 * is a `user_state` context source and lands in the SECOND system message, below the
 * breakpoint, re-billed in full on every Subway Builder call. That is the single largest
 * remaining win — and moving it up here would reorder where the persona sits in the prompt,
 * so it is a deliberate behavioural decision, not a free optimisation. The upside of the
 * status quo: messages[0] is guild-independent, so every guild shares one cache entry.
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
 * Note that a cache WRITE and a silent no-op both report cached_tokens = 0 — they are told
 * apart by cache_write_tokens, which readCachedTokens also returns.
 */

import { estimateTokens } from '@coachartie/shared';

/**
 * Minimum cacheable prefix, in tokens, keyed by OpenRouter model id.
 *
 * These come from Anthropic's own prompt-caching docs, which state the minimums apply on
 * every platform the model is served from. OpenRouter's table disagrees (it lists Opus 4.8
 * as 4096 and omits Sonnet 5 entirely) but Anthropic is the one enforcing it, so Anthropic
 * governs and OpenRouter's page is stale. Do not "correct" these against OpenRouter's docs.
 */
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

/**
 * Cache TTL — 1 hour by default, on measured evidence.
 *
 * An earlier version defaulted to 5 minutes citing "96% of July requests came <5min apart".
 * That number was real but came from claude-opus-4.6, which was retired on 2026-07-15 and
 * is no longer in the rotation. Recomputed per-model over live traffic since that date, the
 * consecutive-request gap is:
 *
 *   sonnet-5    73.9% within 5min, 92.4% within 60min
 *   opus-4.8    78.7% / 94.3%
 *   haiku-4.5   73.2% / 93.6%
 *
 * Expected cost of the prefix is 0.1h + W(1-h), with W = 1.25 at 5m and 2.0 at 1h. For
 * opus-4.8 that is 0.345 at 5m against 0.208 at 1h; for sonnet-5, 0.400 against 0.244.
 * The 1-hour entry is ~40% cheaper on every model actually in rotation, because a quarter
 * of requests miss the 5-minute window and pay a full write.
 *
 * Set PROMPT_CACHE_TTL=5m to go back if traffic ever becomes dense enough that nearly every
 * request lands inside 5 minutes, where the cheaper write wins.
 */
function cacheTtl(): { type: 'ephemeral'; ttl?: '1h' } {
  return process.env.PROMPT_CACHE_TTL === '5m'
    ? { type: 'ephemeral' }
    : { type: 'ephemeral', ttl: '1h' };
}

export type WireContent =
  | string
  | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral'; ttl?: '1h' } }>;
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
          content: [{ type: 'text' as const, text: prefix, cache_control: cacheTtl() }],
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
  return readCacheUsage(usage).read;
}

/**
 * Cache reads AND writes.
 *
 * Both matter for diagnosis, because `read === 0` is ambiguous on its own: it means either
 * "we just wrote the entry" (working, first call) or "nothing cached at all" (broken). Only
 * a non-zero write distinguishes them. OpenRouter reports writes as
 * prompt_tokens_details.cache_write_tokens; Anthropic-native names are accepted too.
 */
export function readCacheUsage(usage: unknown): { read: number; write: number } {
  if (!usage || typeof usage !== 'object') return { read: 0, write: 0 };
  const u = usage as Record<string, unknown>;
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;

  const num = (...candidates: unknown[]): number => {
    for (const c of candidates) if (typeof c === 'number') return c;
    return 0;
  };

  return {
    read: num(details.cached_tokens, u.cache_read_input_tokens),
    write: num(details.cache_write_tokens, u.cache_creation_input_tokens),
  };
}

/** Character length of a wire message, for input_length accounting. */
export function wireContentLength(content: WireContent): number {
  return typeof content === 'string'
    ? content.length
    : content.reduce((total, part) => total + part.text.length, 0);
}
