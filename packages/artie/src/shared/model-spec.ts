/**
 * Model specs: any *_MODEL setting may name a concrete OpenRouter model
 * ("anthropic/claude-opus-5.5") or hand the choice to OpenRouter's auto-router:
 *
 *   auto:<tier>              e.g. auto:low        tier = low | medium | high | xhigh | max
 *   auto:<tier>:<allowed>    e.g. auto:medium:anthropic/*,google/*
 *
 * The auto form becomes model "openrouter/auto" plus the auto-router plugin, so a role
 * tracks the current best model for its tier without anyone editing model ids
 * (EJ, 2026-09-29: lean into auto-routing, keeping our standards via tier + allowed models).
 * Docs: https://openrouter.ai/docs/guides/routing/routers/auto-router
 */
export interface ResolvedModel {
  model: string;
  plugins?: unknown[];
}

const TIERS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function resolveModelSpec(spec: string): ResolvedModel {
  const match = /^auto(?::([a-z]+))?(?::(.+))?$/.exec(spec.trim());
  if (!match) return { model: spec };
  const tier = match[1] && TIERS.has(match[1]) ? match[1] : 'low';
  const allowed = (match[2] || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return {
    model: 'openrouter/auto',
    plugins: [{ id: 'auto-router', cost_tier: tier, ...(allowed.length ? { allowed_models: allowed } : {}) }],
  };
}

/**
 * Reasoning setting for an auto-routed request. At low/medium tiers the auto-router can pick a
 * reasoning model that spends the whole max_tokens budget thinking and returns no text — paid
 * and useless (seen 2026-09-29 on a background summary). `effort: "none"` stops reasoning being
 * generated or billed; `exclude: true` would only hide it. High+ tiers keep reasoning (planning).
 */
export function autoReasoningFor(plugins?: unknown[]): { effort: 'none' } | undefined {
  const tier = (plugins?.[0] as { cost_tier?: string } | undefined)?.cost_tier ?? 'low';
  return tier === 'low' || tier === 'medium' ? { effort: 'none' } : undefined;
}

/** True when a request went to the auto-router, so billing must use the served model. */
export function isAutoRouted(model: string): boolean {
  return model === 'openrouter/auto';
}
