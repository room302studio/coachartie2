/**
 * Model specs: any *_MODEL setting may name a concrete OpenRouter model
 * ("anthropic/claude-opus-5.5") or hand the choice to OpenRouter's auto-router:
 *
 *   auto:<tier>              e.g. auto:low        tier = low | medium | high (xhigh/max = high)
 *   auto:<tier>:<allowed>    e.g. auto:medium:anthropic/*,google/*
 *
 * The auto form becomes model "openrouter/auto" plus the auto-router plugin, so a role
 * tracks the current best model for its tier without anyone editing model ids
 * (EJ, 2026-09-29: lean into auto-routing, keeping our standards via tier + allowed models).
 * Docs: https://openrouter.ai/docs/guides/routing/routers/auto-router
 */
import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDatabasePath } from './paths.js';

export interface ResolvedModel {
  model: string;
  plugins?: unknown[];
}

const TIERS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * The auto-router's cost_tier only takes low | medium | high (docs, 2026-11-23). Our specs still
 * accept xhigh/max for back-compat; they mean "the most capable policy", which is high.
 */
function routerCostTier(tier: string): string {
  if (tier === 'xhigh' || tier === 'max') {
    return 'high';
  }
  return tier;
}

/**
 * Models the auto-router may never pick, on every auto spec. EJ, 2026-11-23: muse-spark was the
 * low tier's favourite pick and the second-biggest cost line (177 calls, 51 failed, ~3.6k output
 * tokens a reply, most of the "reasoning used the whole budget" waste). Wildcards follow
 * OpenRouter's pattern syntax. AUTO_ROUTER_EXCLUDED_MODELS (comma list) overrides this; set it
 * to an empty string to exclude nothing.
 */
export const DEFAULT_AUTO_EXCLUDED_MODELS = ['meta/muse-spark*'];

function autoExcludedModels(): string[] {
  const fromEnv = process.env.AUTO_ROUTER_EXCLUDED_MODELS;
  if (fromEnv === undefined) {
    return DEFAULT_AUTO_EXCLUDED_MODELS;
  }
  return fromEnv
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
}

/**
 * OpenRouter provider routing for EVERY request that can carry Discord message content: only
 * providers that don't store prompts for training. Discord's Developer Policy forbids using
 * message content to train AI models, and Artie's privileged-intent application answered
 * "trained = No" (EJ 2026-11-23: "always obey discord tos"). Per request, so it holds whatever
 * the account-level privacy toggle says. Probed 2026-11-23: every model in use still has a
 * qualifying provider.
 */
export const NO_TRAINING_PROVIDER = { data_collection: 'deny' } as const;

let cachedUserSalt: string | undefined;

/**
 * Secret key for openRouterUser. Discord ids are public and enumerable, so a plain hash of one
 * could be reversed by hashing every known id (Artie's review, 2026-11-23); a keyed HMAC can't.
 * Order: OPENROUTER_USER_SALT env; else a random 32-byte file next to the database
 * (`.openrouter-user-salt`, mode 600, created once) so pseudonyms stay stable across restarts;
 * else (in-memory DB, i.e. tests, or an unwritable dir) a per-process random key. Never logged.
 */
function userSalt(): string {
  if (cachedUserSalt) {
    return cachedUserSalt;
  }
  const fromEnv = process.env.OPENROUTER_USER_SALT;
  if (fromEnv) {
    cachedUserSalt = fromEnv;
    return cachedUserSalt;
  }
  const dbPath = getDatabasePath();
  if (dbPath !== ':memory:') {
    const stored = loadOrCreateSaltFile(join(dirname(dbPath), '.openrouter-user-salt'));
    if (stored) {
      cachedUserSalt = stored;
      return cachedUserSalt;
    }
  }
  // Per-process key: pseudonyms then change on restart, nothing else breaks.
  cachedUserSalt = randomBytes(32).toString('hex');
  return cachedUserSalt;
}

/** A salt file's key, or undefined if it's missing, unreadable, empty or truncated. */
function readSaltFile(saltFile: string): string | undefined {
  try {
    const stored = readFileSync(saltFile, 'utf8').trim();
    if (stored.length >= 32) {
      return stored;
    }
  } catch {
    // Missing or unreadable.
  }
  return undefined;
}

/**
 * Publish a fully written key atomically: write a private temp file, then hard-link it into
 * place (link fails if a winner already exists, so a racing process never sees a half-written
 * file). An empty or truncated leftover (crash mid-write) is replaced by rename. The file is
 * re-locked to owner-only every time, in case something widened it.
 */
function loadOrCreateSaltFile(saltFile: string): string | undefined {
  let stored = readSaltFile(saltFile);
  if (!stored) {
    // Random name + exclusive create: never follows a planted symlink or reuses someone's file.
    const tmp = `${saltFile}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
      try {
        linkSync(tmp, saltFile);
      } catch {
        // Someone else published first, or a bad leftover sits there: replace only the latter.
        if (!readSaltFile(saltFile)) {
          renameSync(tmp, saltFile);
        }
      }
    } catch {
      // Unwritable directory: the caller falls back to a per-process key.
    }
    try {
      unlinkSync(tmp);
    } catch {
      // Already renamed into place, or never written.
    }
    stored = readSaltFile(saltFile);
  }
  if (stored) {
    try {
      chmodSync(saltFile, 0o600);
    } catch {
      // Can't make it private (e.g. owned by another user): don't trust a key others may read.
      return undefined;
    }
  }
  return stored;
}

/**
 * OpenRouter's `user` field: a stable pseudonym per person, so a provider abuse block lands on
 * that one user instead of Artie's whole key, and the Activity page can split usage by user.
 * Never the raw Discord id: an HMAC-SHA256 under a secret key (userSalt), cut to 24 hex chars.
 * Background roles (heartbeat, dreams, digests) call with their own system ids, so each gets
 * its own pseudonym and one block can't stop them all.
 */
export function openRouterUser(userId: string | undefined | null): string | undefined {
  if (!userId) {
    return undefined;
  }
  return 'ca_' + createHmac('sha256', userSalt()).update(userId).digest('hex').slice(0, 24);
}

export function resolveModelSpec(spec: string): ResolvedModel {
  const match = /^auto(?::([a-z]+))?(?::(.+))?$/.exec(spec.trim());
  if (!match) return { model: spec };
  let tier: string;
  if (match[1] && TIERS.has(match[1])) {
    tier = match[1];
  } else {
    tier = 'low';
  }
  const allowed = (match[2] || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  const routerConfig: Record<string, unknown> = { id: 'auto-router', cost_tier: routerCostTier(tier) };
  if (allowed.length) {
    routerConfig.allowed_models = allowed;
  }
  const excluded = autoExcludedModels();
  if (excluded.length) {
    routerConfig.excluded_models = excluded;
  }
  return {
    model: 'openrouter/auto',
    plugins: [routerConfig],
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
  if (tier === 'low' || tier === 'medium') {
    return { effort: 'none' };
  }
  return undefined;
}

/** True when a request went to the auto-router, so billing must use the served model. */
export function isAutoRouted(model: string): boolean {
  return model === 'openrouter/auto';
}
