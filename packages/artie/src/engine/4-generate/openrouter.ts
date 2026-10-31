import OpenAI from 'openai';
import { estimateTokens } from '../../shared/async.js';
import { logger } from '../../shared/logger.js';
import { assertGenerationAllowed } from '../../shared/kill-switch.js';
import { assertGuildBudget } from '../../shared/guild-budget.js';
import { resolveModelSpec, isAutoRouted, autoReasoningFor } from '../../shared/model-spec.js';
import { responseFormatFor, type JsonOutputSpec } from '../../shared/structured-output.js';
import { getErrorMessage } from '../../shared/errors.js';

// No dotenv config() here, deliberately. The old code called
// resolve(__dirname, '../../../../.env') / resolve(__dirname, '../../.env') from
// src|dist/services/llm — on prod those resolve to <repo>/packages/.env and
// packages/capabilities/{src,dist}/.env, neither of which exists (only
// /data2/apps/coachartie2/.env does, which `pnpm`/PM2 never reaches by that math). So on prod
// this was always a no-op: `openRouterService`'s constructor below (and anything else this
// module's eval order pulls in) has only ever read whatever PM2 already put in `process.env`
// directly, never a dotenv-loaded root `.env`. Wiring up `getEnvFiles()` here would load the
// REAL root `.env` while this module is being imported — which, because ESM import evaluation
// happens before `C/index.ts`'s own top-level `config()` calls run, is EARLIER than today's
// actual env-loading point, and would hand prod values (e.g. OPENROUTER_MODELS, the micro-LLM
// slug) from the dev `.env` that `.env.production`/PM2 doesn't set. That is the invariant this
// wave was told to protect. Loading .env is `C/index.ts` / `D/index.ts`'s job; this module just
// reads `process.env` same as before.
import { UsageTracker, TokenUsage } from '../budget/usage-ledger.js';
import {
  applyCacheControl,
  readCacheUsage,
  wireContentLength,
  type ChatMessage,
} from '../3-context/prompt-cache.js';
import { openRouterModelsService } from './model-catalog.js';
import type { ToolDefinition } from '../5-tool-loop/tool-schema.js';
import type { ToolCall } from '../5-tool-loop/native-loop.js';
import { creditMonitor } from '../budget/openrouter-balance.js';
import { recordLlmHiccup } from '../budget/self-meter.js';
import { costMonitor } from '../budget/usage-ledger.js';

// Context Alchemy observability
import { traceManager } from '../2-turn/trace.js';
import { experimentManager } from '../3-context/experiments.js';

// Hard ceiling on ONE model attempt. Lives in config/timeouts.ts with the rest of the reply
// budget and the invariant tying them together — see that file before changing it.
import { PER_REQUEST_TIMEOUT_MS } from '../5-tool-loop/timeouts.js';

export { PER_REQUEST_TIMEOUT_MS };

/**
 * Determine step type for usage tracking
 */
/** The model OpenRouter says it ran (auto and ~latest aliases resolve server-side), else the request. */
export function servedModelName(served: string | undefined | null, requested: string): string {
  if (served) return served;
  return requested;
}

export function finiteOrUndefined(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return value;
}

/** OpenRouter's reported USD cost when it sent one; the price table only as a fallback. */
export function billedCost(reported: number | undefined, billedModel: string, usage: TokenUsage): number {
  const exact = finiteOrUndefined(reported);
  if (exact !== undefined) return exact;
  return UsageTracker.calculateCost(billedModel, usage);
}

function getStepType(userId: string, messageId: string | undefined, explicit?: string): string {
  if (explicit) {
    return explicit;
  }
  if (userId === 'observational-system') {
    return 'observational_learning';
  }
  if (messageId) {
    return 'response';
  }
  return 'background';
}

/**
 * Sticky rotation (EJ, 2026-09-29: "rotate it per-convo so we're still rotating but not losing
 * our cache"). Prompt caches are per model, so the global round-robin — which advances after
 * every call — meant consecutive calls in one conversation alternated models and missed the
 * cache every time. A rotationKey (e.g. the conversation's channel) always maps to the same
 * starting model; different conversations still spread across the rotation. FNV-1a, so the
 * mapping is stable across restarts and processes.
 */
export function stickyRotationIndex(key: string, size: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  if (size > 0) {
    return hash % size;
  }
  return 0;
}

/**
 * Cost attribution for a model_usage_stats row.
 *
 * Usage used to be recorded ONLY when the caller passed a messageId, so every background call
 * (observation summaries, memory tagging, reflection, briefings, social behaviour...) spent
 * money that never reached the table — invisible to cost reports and to the daily budget cap,
 * which sums this table. Every call is recorded now; calls with no message behind them are
 * labelled 'background' so they don't inflate the 'response' numbers.
 */
function stepTypeFor(userId: string, messageId: string | undefined, explicit?: string): string {
  return getStepType(userId, messageId, explicit);
}

/** Options shared by every generate call (streaming, plain and tool turns). */
export interface GenerateOptions {
  traceId?: string | null;
  guildId?: string;
  maxTokens?: number; // Dynamic token limit from preflight analysis
  plugins?: unknown[]; // OpenRouter plugins, e.g. [{ id: 'auto-router', cost_tier: 'low' }]
  rotationKey?: string; // sticky rotation per conversation (see stickyRotationIndex)
  stepType?: string; // Cost attribution: 'response' | 'observational_learning' | 'capability' | 'planning'
  /**
   * The JSON this call wants back (wave 10). Sent as `response_format` only to a model the
   * catalog says takes it (never on a tool turn, never to openrouter/auto, whose pick is
   * unknown); the caller parses the reply with parseModelJson either way.
   */
  jsonOutput?: JsonOutputSpec;
}

/** One generate turn's result. `toolCalls` is always [] unless the turn offered tools. */
export interface GenerateTurnResult {
  content: string;
  toolCalls: ToolCall[];
  /** The model the request went to (after any tool-capable pin). */
  model: string;
}

/**
 * Normalize a completion's tool_calls to {id, name, arguments}. `arguments` is always a
 * string (some providers hand back an object); a call with no id gets a positional one so
 * its tool result can still be matched to it.
 */
export function normalizeToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  raw.forEach((tc, i) => {
    const fn = (tc as { function?: { name?: unknown; arguments?: unknown } } | null)?.function;
    if (!fn || typeof fn.name !== 'string' || !fn.name) return;
    let args: string;
    if (typeof fn.arguments === 'string') {
      args = fn.arguments;
    } else if (fn.arguments === undefined || fn.arguments === null) {
      args = '{}';
    } else {
      args = JSON.stringify(fn.arguments);
    }
    const id = (tc as { id?: unknown }).id;
    let callId: string;
    if (typeof id === 'string' && id) {
      callId = id;
    } else {
      callId = `call_${i}`;
    }
    calls.push({ id: callId, name: fn.name, arguments: args });
  });
  return calls;
}

/**
 * `response_format` for this model, or undefined (wave 10). Only when the caller asked for
 * JSON and the catalog positively lists structured output for this exact model: openrouter/auto
 * may route to a model without it, and a catalog miss (fetch failed, unknown id) sends nothing.
 * The one rule for every caller (generateTurn here, the gateway's ambient judgment via
 * engine/api.ts).
 */
export async function responseFormatForModel(
  model: string,
  spec: JsonOutputSpec | undefined
): Promise<Record<string, unknown> | undefined> {
  if (!spec || isAutoRouted(model)) return undefined;
  try {
    const mode = await openRouterModelsService.structuredOutputMode(model);
    if (mode) {
      return responseFormatFor(spec, mode);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

class OpenRouterService {
  private client: OpenAI;
  private models: string[];
  private currentModelIndex: number = 0;

  /**
   * Low/medium auto-routed calls ask for reasoning effort "none", but the router sometimes
   * picks a model that can't turn it off and 400s ("Reasoning is mandatory…", 31× on
   * 2026-10-23). Retry that one case at low effort, hidden, instead of burning a fallback.
   */
  private async createCompletion(params: Record<string, any>): Promise<any> {
    try {
      return await this.client.chat.completions.create(params as never);
    } catch (error) {
      const msg = getErrorMessage(error);
      if (params.reasoning?.effort !== 'none' || !/reasoning is mandatory/i.test(msg)) throw error;
      logger.info(`🧠 ${params.model}: routed to a reasoning-only model, retrying at low effort`);
      recordLlmHiccup('reasoning-retry');
      return this.client.chat.completions.create({
        ...params,
        reasoning: { effort: 'low', exclude: true },
      } as never);
    }
  }

  constructor() {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const baseURL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

    // Primary configuration: comma-separated OPENROUTER_MODELS env var
    if (process.env.OPENROUTER_MODELS) {
      const rawModels = process.env.OPENROUTER_MODELS.split(',')
        .map((m) => m.trim())
        .filter((m) => m.length > 0); // Remove empty strings

      // Validate model format (should be provider/model or provider/model:variant)
      const validModels: string[] = [];
      const invalidModels: string[] = [];

      rawModels.forEach((model) => {
        // Basic validation: should contain a slash and reasonable format
        if (model.includes('/') && model.length > 3 && !model.includes(' ')) {
          validModels.push(model);
        } else {
          invalidModels.push(model);
        }
      });

      if (invalidModels.length > 0) {
        logger.error(`❌ Invalid model names detected in OPENROUTER_MODELS:`, invalidModels);
        logger.error(
          '💡 Model format should be: provider/model-name or provider/model-name:variant'
        );
        logger.error('🔗 Find valid models at: https://openrouter.ai/models');

        if (validModels.length === 0) {
          logger.error('🚨 No valid models found! Using fallback models to prevent crash');
        } else {
          logger.warn(
            `⚠️ Continuing with ${validModels.length} valid models, ignoring ${invalidModels.length} invalid ones`
          );
        }
      }

      if (validModels.length > 0) {
        this.models = validModels;
      } else {
        // Emergency fallback if all models are invalid (no openai/gpt-oss-20b:free - outputs internal reasoning)
        this.models = [
          'z-ai/glm-4.5-air:free',
          'qwen/qwen3-coder:free',
          'mistralai/mistral-7b-instruct:free',
        ];
      }

      logger.info(`🎯 Using ${this.models.length} models:`, this.models);

      if (validModels.length !== rawModels.length) {
        logger.warn(`⚠️ ${rawModels.length - validModels.length} invalid models were ignored`);
      }
    } else {
      // Fallback to current free models for development (removed openai/gpt-oss-20b:free - outputs internal reasoning)
      this.models = [
        'z-ai/glm-4.5-air:free',
        'qwen/qwen3-coder:free',
        'mistralai/mistral-7b-instruct:free',
        'microsoft/phi-3-mini-128k-instruct:free',
        'meta-llama/llama-3.2-3b-instruct:free',
        'google/gemma-2-9b-it:free',
      ];

      logger.warn('⚠️ OPENROUTER_MODELS not set, using fallback free models');
      logger.info('💡 Set OPENROUTER_MODELS="model1,model2,model3" for full control');
    }

    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY environment variable is required');
    }

    this.client = new OpenAI({
      apiKey,
      baseURL,
      // A wedged provider must never eat the whole job budget. The SDK defaults to a 600s
      // timeout with 2 internal retries — worst case 30 minutes against a 120s job budget —
      // so when opus-4.8 started hanging without ever returning, EVERY reply died on the
      // global timeout and Artie went silent for hours while looking perfectly healthy.
      // Bound each attempt well under the budget; the model-fallback loop below IS the retry,
      // so SDK-level retries would only multiply the latency that caused the outage.
      timeout: PER_REQUEST_TIMEOUT_MS,
      maxRetries: 0,
      defaultHeaders: {
        'HTTP-Referer': 'https://coach-artie.local',
        'X-Title': 'Coach Artie',
        // Pin us to one provider endpoint so the prompt cache can actually be hit.
        // Anthropic's cache is per provider endpoint, and OpenRouter fronts 10-11 of them
        // for sonnet-5/opus-4.8 (Anthropic, Bedrock, Google, Azure, ...). Its own sticky
        // routing keys on the first system message plus the first NON-system message —
        // ours is the final user turn, which is unique every request — and without a
        // session id stickiness only engages AFTER a hit is detected, which can't happen
        // if we keep landing on different endpoints. This breaks that circle.
        // Preferred over provider.order + allow_fallbacks:false, which would re-create the
        // opus-4.8 hang that PER_REQUEST_TIMEOUT_MS exists to contain.
        'x-session-id': process.env.OPENROUTER_SESSION_ID || 'coachartie',
      },
    });

    logger.info(`OpenRouter client initialized with models: ${this.models.join(', ')}`);

    // Validate models against API on startup (async, non-blocking)
    this.validateModelsOnStartup().catch((err) => {
      logger.error('❌ Failed to validate models on startup:', err);
    });

    // Check credit balance on startup, then poll every 30 min so the operator gets a
    // low-balance DM warning BEFORE credits run dry (not just on a live 402).
    import('../budget/openrouter-balance.js').then(({ creditMonitor }) => {
      creditMonitor.startPeriodicBalanceCheck();
    });
  }

  /**
   * Validate configured models exist on the API
   * Warns loudly if models don't exist to prevent silent fallback
   */
  private async validateModelsOnStartup(): Promise<void> {
    try {
      const baseURL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
      const response = await fetch(`${baseURL}/models`, {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        },
      });

      if (!response.ok) {
        logger.warn(
          `⚠️ Could not fetch models from API (${response.status}) - skipping validation`
        );
        return;
      }

      const data = (await response.json()) as { data?: Array<{ id: string }> };
      const availableModels = new Set((data.data || []).map((m) => m.id));

      const missingModels: string[] = [];
      const validModels: string[] = [];

      for (const model of this.models) {
        if (availableModels.has(model)) {
          validModels.push(model);
        } else {
          missingModels.push(model);
        }
      }

      if (missingModels.length > 0) {
        logger.error(`\n${'='.repeat(70)}`);
        logger.error(
          `🚨 MODEL VALIDATION FAILED: ${missingModels.length} configured models don't exist on API!`
        );
        logger.error(`   Missing: ${missingModels.join(', ')}`);
        logger.error(`   API has ${availableModels.size} models available.`);
        logger.error(`   Similar models that DO exist:`);

        // Suggest similar models
        for (const missing of missingModels) {
          const prefix = missing.split('/')[0];
          const similar = Array.from(availableModels)
            .filter((m) => (m as string).startsWith(prefix + '/'))
            .slice(0, 3);
          if (similar.length > 0) {
            logger.error(`     ${missing} → try: ${similar.join(', ')}`);
          }
        }

        logger.error(`${'='.repeat(70)}\n`);

        // Update models list to only include valid ones
        if (validModels.length > 0) {
          this.models = validModels;
          logger.warn(
            `⚠️ Continuing with ${validModels.length} valid models: ${validModels.join(', ')}`
          );
        } else {
          logger.error(`🚨 NO VALID MODELS! Requests will likely fail or use fallback.`);
        }
      } else {
        logger.info(`✅ All ${this.models.length} configured models validated against API`);
      }
    } catch (error) {
      logger.warn(`⚠️ Model validation failed (non-critical):`, error);
    }
  }

  getCurrentModel(): string {
    return this.models[this.currentModelIndex];
  }

  getAvailableModels(): string[] {
    return [...this.models];
  }

  // THREE-TIER MODEL STRATEGY: Speed + Cost Optimization
  // Fast model extracts capabilities → Smart model responds → Manager plans complex tasks

  /**
   * Select FAST_MODEL for capability extraction (fast, cheap, simple pattern matching)
   */
  selectFastModel(): string {
    const fastModel = process.env.FAST_MODEL;
    if (fastModel && fastModel.trim().length > 0) {
      logger.info(`🚀 FAST MODEL SELECTED: ${fastModel} (capability extraction)`);
      return fastModel;
    }
    // Fallback to rotation if not configured
    logger.warn('⚠️ FAST_MODEL not configured, using rotation');
    return this.getCurrentModel();
  }

  /**
   * Select SMART_MODEL for response synthesis (balanced, high quality)
   */
  selectSmartModel(): string {
    const smartModel = process.env.SMART_MODEL;
    if (smartModel && smartModel.trim().length > 0) {
      logger.info(`🧠 SMART MODEL SELECTED: ${smartModel} (response synthesis)`);
      return smartModel;
    }
    // Fallback to rotation if not configured
    logger.warn('⚠️ SMART_MODEL not configured, using rotation');
    return this.getCurrentModel();
  }

  /**
   * Select MANAGER_MODEL for complex planning and reasoning (strongest model)
   */
  selectManagerModel(): string {
    const managerModel = process.env.MANAGER_MODEL;
    if (managerModel && managerModel.trim().length > 0) {
      logger.info(`🎯 MANAGER MODEL SELECTED: ${managerModel} (complex planning)`);
      return managerModel;
    }
    // Fallback to SMART_MODEL if not configured
    const smartModel = process.env.SMART_MODEL;
    if (smartModel && smartModel.trim().length > 0) {
      logger.info(`🧠 MANAGER fallback to SMART_MODEL: ${smartModel}`);
      return smartModel;
    }
    // Fallback to rotation if neither configured
    logger.warn('⚠️ MANAGER_MODEL not configured, using rotation');
    return this.getCurrentModel();
  }

  /**
   * Task-aware model selection (convenience method)
   */
  selectModelForTask(taskType: 'extraction' | 'response' | 'planning'): string {
    switch (taskType) {
      case 'extraction':
        return this.selectFastModel();
      case 'response':
        return this.selectSmartModel();
      case 'planning':
        return this.selectManagerModel();
      default:
        return this.getCurrentModel();
    }
  }

  /**
   * Determine model tier for observability tracking
   * Returns 'fast', 'smart', or 'manager' based on model configuration
   */
  getModelTier(model: string): string {
    const fastModel = process.env.FAST_MODEL;
    const smartModel = process.env.SMART_MODEL;
    const managerModel = process.env.MANAGER_MODEL;

    if (fastModel && model === fastModel) return 'fast';
    if (smartModel && model === smartModel) return 'smart';
    if (managerModel && model === managerModel) return 'manager';

    // Infer from model name patterns
    if (model.includes('mini') || model.includes('flash') || model.includes('fast')) return 'fast';
    if (model.includes('opus') || model.includes('4o') || model.includes('large')) return 'manager';

    return 'smart'; // Default tier
  }

  async generateFromMessageChain(
    messages: ChatMessage[],
    userId: string,
    messageId?: string,
    selectedModel?: string,
    options?: GenerateOptions
  ): Promise<string> {
    const { content } = await this.generateTurn(messages, userId, messageId, selectedModel, options);
    return content.trim();
  }

  /**
   * One NATIVE tool turn (wave 8): the same request path as generateFromMessageChain — kill
   * switch, guild/daily budget, credit short-circuit, usage ledger, affordability retry, the
   * reasoning-mandatory retry, the model fallback ladder — plus `tools` and `tool_choice`.
   * Non-streaming by design. The model is pinned to a tool-capable one (toolModelsToTry).
   *
   * `toolChoice: 'none'` keeps the tool list on the wire (Anthropic rejects tool_use/
   * tool_result history without tool definitions, and an identical list keeps the cached
   * prefix) while forbidding new calls: runToolLoop's forced final answer uses it.
   */
  async generateWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    userId: string,
    messageId?: string,
    selectedModel?: string,
    options?: GenerateOptions & { toolChoice?: 'auto' | 'none' }
  ): Promise<GenerateTurnResult> {
    return this.generateTurn(messages, userId, messageId, selectedModel, options, {
      tools,
      toolChoice: options?.toolChoice ?? 'auto',
    });
  }

  /**
   * The models a tool turn may use, in order.
   *
   * openrouter/auto can route to a model with no tool support, so a tool turn never goes
   * there; neither does a model the catalog says lacks `tools` in supported_parameters. Those
   * get replaced by the first tool-capable OPENROUTER_MODELS entry (logged). A concrete model
   * the catalog has no data on (catalog fetch failed, or a new id) is trusted rather than
   * blocked: failing closed would silence Artie whenever openrouter.ai/models is down.
   * Brownout's final-third route is openrouter/auto, so its downgrade lands here too and stays
   * inside the tool-capable set; brownout's max_tokens cap and brevity note still apply.
   */
  async toolModelsToTry(requested: string | undefined): Promise<string[]> {
    const verdict = async (spec: string): Promise<{ model: string; ok: boolean; why: string }> => {
      const model = resolveModelSpec(spec).model;
      if (isAutoRouted(model)) return { model, ok: false, why: 'auto-routed' };
      const tools = await openRouterModelsService.supportsTools(model);
      if (tools === false) {
        return { model, ok: false, why: 'no tools in supported_parameters' };
      }
      let toolWhy: string;
      if (tools === undefined) {
        toolWhy = 'not in catalog, trusted';
      } else {
        toolWhy = 'tool-capable';
      }
      return { model, ok: true, why: toolWhy };
    };

    const capable: string[] = [];
    for (const spec of this.models) {
      const v = await verdict(spec);
      if (v.ok && !capable.includes(v.model)) capable.push(v.model);
    }

    if (requested && requested.trim()) {
      const v = await verdict(requested);
      if (v.ok) return [v.model, ...capable.filter((m) => m !== v.model)];
      if (capable.length > 0) {
        logger.warn(`🔧 Tool turn: ${requested} is ${v.why} → pinned to ${capable[0]}`);
        return capable;
      }
      logger.error(
        `🔧 Tool turn: ${requested} is ${v.why} and no OPENROUTER_MODELS entry is tool-capable; sending it anyway`
      );
      return [requested];
    }
    if (capable.length === 0) {
      logger.error('🔧 Tool turn: no OPENROUTER_MODELS entry is tool-capable; using the rotation as is');
      return [...this.models];
    }
    return capable;
  }

  private async generateTurn(
    messages: ChatMessage[],
    userId: string,
    messageId?: string,
    selectedModel?: string,
    options?: GenerateOptions,
    toolSpec?: { tools: ToolDefinition[]; toolChoice: 'auto' | 'none' }
  ): Promise<GenerateTurnResult> {
    // KILL SWITCH (manual or daily-budget mute): nothing generates, whoever is asking.
    assertGenerationAllowed(`generation for ${userId}`);
    // Per-guild share of the daily budget (guild-budget.ts) — silent in that guild once spent.
    assertGuildBudget(options?.guildId, `generation for ${userId}`);

    // SHORT-CIRCUIT: If credits are exhausted, don't even try the API
    if (creditMonitor.areCreditsExhausted()) {
      logger.info('💳 Skipping API call - credits exhausted (in cooldown period)');
      throw new Error(
        '💳 OUT OF CREDITS: OpenRouter account needs more credits. Visit https://openrouter.ai/settings/credits to add funds.'
      );
    }

    const startTime = Date.now();
    const traceId = options?.traceId;
    const guildId = options?.guildId;

    // Context Alchemy: Check for experiment variant assignment
    let experimentId: string | null = null;
    let variantId: string | null = null;
    let variantModelOverride: string | undefined;
    let variantTemperature: number | undefined;

    if (traceId) {
      try {
        const variant = await experimentManager.getVariantForUser(userId, guildId);
        experimentId = variant.experimentId;
        variantId = variant.variantId;

        // Apply model override if experiment specifies one
        if (variant.config.smartModel && !selectedModel) {
          variantModelOverride = variant.config.smartModel;
          logger.info(
            `🧪 Experiment ${experimentId}: Using model override ${variantModelOverride}`
          );
        }

        // Apply temperature override if experiment specifies one
        if (variant.config.temperature !== undefined) {
          variantTemperature = variant.config.temperature;
          logger.info(`🧪 Experiment ${experimentId}: Using temperature ${variantTemperature}`);
        }
      } catch (error) {
        // Experiment lookup failed, continue without experiment
        logger.debug('[experiment] Variant lookup failed, continuing normally');
      }
    }

    // If a specific model was selected (three-tier strategy), use it
    // Otherwise check for experiment override, then rotate through models
    const effectiveModel = selectedModel || variantModelOverride;
    const useSpecificModel = effectiveModel && effectiveModel.trim().length > 0;
    let startIndex: number;
    if (options?.rotationKey) {
      startIndex = stickyRotationIndex(options.rotationKey, this.models.length);
    } else {
      startIndex = this.currentModelIndex;
    }

    // Try each model starting from current rotation position. A specifically-requested
    // model (three-tier strategy) is tried FIRST but still falls back to the rotation:
    // with a bare [effectiveModel] a single transient provider error on SMART_MODEL left
    // nothing to retry with, the orchestration failed, and Artie silently said nothing.
    // A tool turn always runs an explicit, tool-capable list (toolModelsToTry): the requested
    // model first when it can take tools, otherwise the pin, then the other capable models.
    let toolModels: string[] | undefined;
    if (toolSpec) {
      toolModels = await this.toolModelsToTry(effectiveModel);
    } else {
      toolModels = undefined;
    }
    let modelsToTry: string[];
    if (toolModels) {
      modelsToTry = toolModels;
    } else if (useSpecificModel) {
      modelsToTry = [effectiveModel, ...this.models.filter((m) => m !== effectiveModel)];
    } else {
      modelsToTry = this.models;
    }
    const explicitList = !!toolModels || !!useSpecificModel;
    let sendTools: typeof toolSpec | undefined;
    if (toolSpec && toolSpec.tools.length > 0) {
      sendTools = toolSpec;
    } else {
      sendTools = undefined;
    }

    // When OpenRouter returns a 402 of the form "you requested up to X tokens,
    // but can only afford Y", it means there IS still balance — just not enough
    // for this request's max_tokens. We cap max_tokens to what's affordable and
    // retry the SAME model once, instead of freezing all calls for 5 minutes.
    let affordabilityCap: number | undefined;
    let affordabilityRetried = false;

    for (let i = 0; i < modelsToTry.length; i++) {
      let modelSpec: string;
      if (explicitList) {
        modelSpec = modelsToTry[i];
      } else {
        modelSpec = this.models[(startIndex + i) % this.models.length];
      }
      // "auto:<tier>[:allowed]" specs → openrouter/auto + the auto-router plugin (model-spec.ts);
      // plugins passed in by the caller (brownout's final-third route) take precedence.
      const resolved = resolveModelSpec(modelSpec);
      const model = resolved.model;
      // The auto-router plugin belongs to openrouter/auto. A tool turn pinned off auto (the
      // brownout route) must not carry it to the concrete model it was pinned to.
      let plugins: unknown[] | undefined;
      if (toolSpec && !isAutoRouted(model)) {
        plugins = undefined;
      } else {
        plugins = options?.plugins ?? resolved.plugins;
      }
      let attemptUsage: { billed: string; usage: TokenUsage; cost: number } | undefined;

      try {
        let responseFormat: Record<string, unknown> | undefined;
        if (!sendTools) {
          responseFormat = await responseFormatForModel(model, options?.jsonOutput);
        } else {
          responseFormat = undefined;
        }
        let modelLabel: string;
        if (useSpecificModel && i === 0) {
          modelLabel = '(SPECIFIC)';
        } else {
          modelLabel = `(${i + 1}/${modelsToTry.length})`;
        }
        let toolInfo: string;
        if (toolSpec) {
          toolInfo = ` (tool turn, ${toolSpec.tools.length} tools, tool_choice ${toolSpec.toolChoice})`;
        } else {
          toolInfo = '';
        }
        logger.info(
          `🤖 MODEL SELECTION: Using ${model} ${modelLabel} for ${messages.length} messages${toolInfo}`
        );

        // Use dynamic maxTokens from preflight analysis, or fall back to env default
        let maxTokens = options?.maxTokens || parseInt(process.env.LLM_MAX_TOKENS || '400', 10);
        if (affordabilityCap !== undefined && affordabilityCap < maxTokens) {
          logger.warn(`📏 Capping max_tokens ${maxTokens} → ${affordabilityCap} (affordability)`);
          maxTokens = affordabilityCap;
        }
        let maxTokensSource: string;
        if (options?.maxTokens) {
          maxTokensSource = ' (preflight)';
        } else {
          maxTokensSource = ' (default)';
        }
        logger.debug(
          `📏 Using max_tokens: ${maxTokens}${maxTokensSource}`
        );

        // Use experiment temperature if set, otherwise default
        const temperature = variantTemperature ?? 0.7;

        // Mark the static system prefix cacheable. No-op for non-Anthropic models and for
        // prefixes under the model's minimum — see prompt-cache.ts for why both matter.
        // On a tool turn the tool list sits ahead of the system prompt in that prefix.
        let toolTokens: number;
        if (sendTools) {
          toolTokens = estimateTokens(JSON.stringify(sendTools.tools));
        } else {
          toolTokens = 0;
        }
        const cache = applyCacheControl(
          messages,
          model,
          toolTokens
        );
        let toolsLabel: string;
        if (sendTools) {
          toolsLabel = 'tools + ';
        } else {
          toolsLabel = '';
        }
        let cacheMessage: string;
        if (cache.applied) {
          cacheMessage = `🗄️ Prompt cache: breakpoint on ${cache.prefixTokens}tok ${toolsLabel}system prefix (${model})`;
        } else {
          cacheMessage = `🗄️ Prompt cache: not applied — ${cache.reason}`;
        }
        logger.info(cacheMessage);

        // OpenRouter-only extras (auto-router plugins) aren't in the OpenAI SDK's types.
        const extraBody: Record<string, unknown> = {};
        if (plugins) {
          extraBody.plugins = plugins;
        }
        // OpenRouter's usage accounting reports the exact USD cost of every call, so new
        // models and ~latest aliases bill correctly without a price-table entry (EJ,
        // 2026-10-31: models change too fast to hardcode). The table is only a fallback.
        extraBody.usage = { include: true };
        if (isAutoRouted(model) && autoReasoningFor(plugins)) {
          extraBody.reasoning = autoReasoningFor(plugins);
        }
        const completionParams: Record<string, unknown> = {
          model,
          messages: cache.messages,
          max_tokens: maxTokens,
          temperature,
          // Native tools (wave 8). The list is pre-sorted and byte-stable (tool-schema.ts), so
          // it stays inside the provider's cached prefix (Anthropic orders tools before system).
        };
        if (sendTools) {
          completionParams.tools = sendTools.tools;
          completionParams.tool_choice = sendTools.toolChoice;
        }
        if (responseFormat) {
          completionParams.response_format = responseFormat;
        }
        Object.assign(completionParams, extraBody);
        const completion: OpenAI.Chat.Completions.ChatCompletion = await this.createCompletion(
          completionParams as never
        );
        // Bill what OpenRouter actually served: openrouter/auto and ~latest aliases resolve
        // server-side, and the requested name would hit the unknown-model fallback ($15/$75).
        const billedModel = servedModelName(completion.model, model);

        const choice = completion.choices?.[0];
        const response = choice?.message?.content ?? '';
        // Only a turn that offered tools can come back with calls; a plain turn ignores them.
        let toolCalls: ToolCall[];
        if (sendTools) {
          toolCalls = normalizeToolCalls(choice?.message?.tool_calls);
        } else {
          toolCalls = [];
        }

        if (!response && toolCalls.length === 0) {
          // Still billed (e.g. reasoning tokens that hit max_tokens) — keep the real usage and
          // cost for the failure row below instead of booking the attempt at $0.
          const failedUsage: TokenUsage = {
            prompt_tokens: completion.usage?.prompt_tokens || 0,
            completion_tokens: completion.usage?.completion_tokens || 0,
            total_tokens: completion.usage?.total_tokens || 0,
            cached_tokens: readCacheUsage(completion.usage).read,
            cache_write_tokens: readCacheUsage(completion.usage).write,
          };
          const failedReported = Number((completion.usage as { cost?: unknown } | undefined)?.cost);
          const attemptCost = billedCost(failedReported, billedModel, failedUsage);
          attemptUsage = {
            billed: billedModel,
            usage: failedUsage,
            cost: attemptCost,
          };
          // OpenRouter can return HTTP 200 with an embedded error body, a
          // reasoning/thinking-only turn (content: null), or a length-truncated
          // completion. Surface the REAL reason instead of a bare
          // "No response generated" so the catch-block classifier (402/429/etc.)
          // and the logs can act on it. Logged at warn so it reaches the PM2 log
          // file (CONSOLE_LOG_LEVEL=warn suppresses info).
          const finishReason = choice?.finish_reason;
          const embeddedError =
            (completion as any)?.error?.message ||
            (choice as any)?.error?.message ||
            (completion as any)?.error;
          let reasoningOnly = '';
          if ((choice?.message as any)?.reasoning) {
            reasoningOnly = ' (reasoning-only, no text block)';
          }
          logger.warn(`⚠️ Empty completion from ${model}`, {
            finishReason,
            embeddedError,
            hasChoices: (completion.choices?.length ?? 0) > 0,
            id: completion.id,
          });
          if (embeddedError) {
            // Re-throw the upstream error so 402/429/etc. get classified below.
            throw new Error(String(embeddedError));
          }
          const finalReason = finishReason ?? 'unknown';
          throw new Error(
            `Empty completion (finish_reason=${finalReason})${reasoningOnly}`
          );
        }

        let responseToolInfo = '';
        if (toolCalls.length) {
          responseToolInfo = ` + ${toolCalls.length} tool call(s): ${toolCalls.map((t) => t.name).join(', ')}`;
        }
        logger.info(
          `✅ MODEL RESPONSE: ${model} generated ${response.length} chars${responseToolInfo} successfully`
        );

        const responseTime = Date.now() - startTime;

        // Extract token usage from API response
        const usage: TokenUsage = {
          prompt_tokens: completion.usage?.prompt_tokens || 0,
          completion_tokens: completion.usage?.completion_tokens || 0,
          total_tokens: completion.usage?.total_tokens || 0,
          cached_tokens: readCacheUsage(completion.usage).read,
          cache_write_tokens: readCacheUsage(completion.usage).write,
        };
        const cacheUsage = readCacheUsage(completion.usage);
        // read AND write, because read=0 alone can't tell "just warmed it" from "broken".
        logger.info(
          `🗄️ Cache usage: read ${cacheUsage.read}, write ${cacheUsage.write} of ${usage.prompt_tokens} prompt tokens (${model})`
        );

        // Check for credit/billing info in OpenRouter response
        const creditInfo = {
          usage: completion.usage,
          model: completion.model,
          id: completion.id,
          system_fingerprint: completion.system_fingerprint,
          // OpenRouter sometimes includes these fields
          cost: (completion as any).cost,
          credits_used: (completion as any).credits_used,
          credits_remaining: (completion as any).credits_remaining,
          generation_time: (completion as any).generation_time,
          provider: (completion as any).provider,
        };

        logger.info('💳 OpenRouter Credit Info:', creditInfo);

        // Record credit info if available
        if (creditInfo.credits_remaining !== undefined || creditInfo.credits_used !== undefined) {
          await creditMonitor.recordCreditInfo(creditInfo);
        }

        // Calculate cost and record usage
        const reportedCost = Number((completion.usage as { cost?: unknown } | undefined)?.cost);
        const estimatedCost = billedCost(reportedCost, billedModel, usage);

        // Track costs in real-time cost monitor
        const costForMonitor = finiteOrUndefined(reportedCost);
        const { warnings } = costMonitor.trackCall(
          usage.prompt_tokens,
          usage.completion_tokens,
          billedModel,
          usage.cached_tokens ?? 0,
          costForMonitor
        );

        // Log warnings if any
        if (warnings.length > 0) {
          logger.warn(`💸 Cost warnings for this call:`, warnings);
        }

        // Record usage statistics (don't await to avoid blocking)
        {
          UsageTracker.recordUsage({
            model_name: billedModel,
            guild_id: options?.guildId ?? null,
            user_id: userId,
            message_id: messageId ?? '',
            input_length: cache.messages.reduce(
              (total, msg) => total + wireContentLength(msg.content),
              0
            ),
            output_length:
              response.length + toolCalls.reduce((n, t) => n + t.name.length + t.arguments.length, 0),
            response_time_ms: responseTime,
            capabilities_detected: 0, // Will be updated by orchestrator
            capabilities_executed: 0, // Will be updated by orchestrator
            capability_types: '', // Will be updated by orchestrator
            success: true,
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            cached_tokens: usage.cached_tokens ?? 0,
            cache_write_tokens: usage.cache_write_tokens ?? 0,
            estimated_cost: estimatedCost,
            step_type: stepTypeFor(userId, messageId, options?.stepType),
          }).catch((error) => {
            logger.error('Failed to record usage stats:', error);
          });
        }

        // Rotate to next model for testing different models' tool usage
        this.currentModelIndex = (this.currentModelIndex + 1) % this.models.length;

        // Context Alchemy: Update trace with model and cost info
        if (traceId) {
          await traceManager.updateTrace(traceId, {
            modelUsed: model,
            modelTier: this.getModelTier(model),
            responseTokens: usage.completion_tokens,
            estimatedCost,
            experimentId: experimentId || undefined,
            variantId: variantId || undefined,
          });
        }

        logger.info(
          `✅ Generated response for user ${userId} using ${model} (${usage.total_tokens} tokens, $${estimatedCost.toFixed(4)})`
        );
        logger.info(`🔄 Rotated to next model: ${this.getCurrentModel()}`);
        return { content: response, toolCalls, model };
      } catch (error: unknown) {
        const errorMessage = getErrorMessage(error);
        const errorStatus = (error as { status?: number }).status;

        logger.warn(`❌ Model ${model} failed:`, {
          error: errorMessage,
          status: errorStatus,
          modelIndex: i + 1,
          totalModels: modelsToTry.length,
        });
        let hiccupType: 'failed' | 'fallback';
        if (i === modelsToTry.length - 1) {
          hiccupType = 'failed';
        } else {
          hiccupType = 'fallback';
        }
        recordLlmHiccup(hiccupType);

        // Record the FAILED attempt. Every one of the 15,122 historical rows has
        // success = 1, because recordUsage was only ever reached on the success path —
        // so the fallback ladder's retries were invisible and any error rate computed
        // from this table was a fake 0%. A failed attempt still consumed billed input
        // tokens in most cases; prompt_tokens is an estimate here since the API returned
        // no usage object, which is why it is flagged via error_type rather than trusted.
        {
          let recordErrorType: string;
          if (errorStatus) {
            recordErrorType = `http_${errorStatus}`;
          } else {
            recordErrorType = errorMessage.slice(0, 80);
          }
          UsageTracker.recordUsage({
            model_name: attemptUsage?.billed ?? model,
            guild_id: options?.guildId ?? null,
            user_id: userId,
            message_id: messageId ?? '',
            input_length: messages.reduce((total, msg) => total + msg.content.length, 0),
            output_length: 0,
            response_time_ms: Date.now() - startTime,
            capabilities_detected: 0,
            capabilities_executed: 0,
            capability_types: '',
            success: false,
            error_type: recordErrorType,
            prompt_tokens: attemptUsage?.usage.prompt_tokens ?? 0,
            completion_tokens: attemptUsage?.usage.completion_tokens ?? 0,
            total_tokens: attemptUsage?.usage.total_tokens ?? 0,
            cached_tokens: attemptUsage?.usage.cached_tokens ?? 0,
            estimated_cost: attemptUsage?.cost ?? 0,
            step_type: stepTypeFor(userId, messageId, options?.stepType),
          }).catch(() => {
            // Never let telemetry failure mask the real error we're handling.
          });
        }

        // Track if this is a credit/billing error
        const isCreditError =
          errorMessage.includes('credit') ||
          errorMessage.includes('billing') ||
          errorMessage.includes('quota') ||
          errorStatus === 402;

        // A 402 that mentions "afford" / "fewer max_tokens" means there IS still
        // balance — the request just asked for more tokens than it can cover.
        // Parse the affordable token count so we can retry with a smaller cap.
        const affordMatch = errorMessage.match(/can only afford (\d+)/i);
        const isAffordabilityError =
          errorStatus === 402 && (affordMatch !== null || /fewer max_tokens/i.test(errorMessage));

        const isLastModel = i === modelsToTry.length - 1;

        // Detect specific error types and throw clear errors on last model
        if (
          errorStatus === 404 ||
          errorMessage.includes('not found') ||
          errorMessage.includes('does not exist')
        ) {
          logger.error(
            `🚨 Model "${model}" does not exist on OpenRouter! Check https://openrouter.ai/models`
          );
          if (isLastModel) {
            throw new Error(
              `🚨 MODEL NOT FOUND: "${model}" does not exist. Check https://openrouter.ai/models`
            );
          }
        } else if (isAffordabilityError && !affordabilityRetried) {
          // Retry the SAME model once with max_tokens capped to what's affordable.
          // Leave a 10% safety margin so token-estimation drift doesn't re-trip it.
          let affordableTokens: number;
          if (affordMatch) {
            affordableTokens = parseInt(affordMatch[1], 10);
          } else {
            affordableTokens = 256;
          }
          affordabilityCap = Math.max(64, Math.floor(affordableTokens * 0.9));
          affordabilityRetried = true;
          logger.warn(
            `💳 402 affordability limit — retrying ${model} with max_tokens=${affordabilityCap} ` +
              `(balance is low but not exhausted)`
          );
          i--; // retry the same model
          continue;
        } else if (isCreditError) {
          let nextModelMsg: string;
          if (isLastModel) {
            nextModelMsg = '';
          } else {
            nextModelMsg = ', trying next model...';
          }
          logger.info(
            `💳 Billing/credit error detected${nextModelMsg}`
          );
          // Only freeze all API calls if the REAL balance confirms we're actually
          // out — a near-threshold 402 shouldn't lock Artie out while funds remain.
          const froze = await creditMonitor.markCreditsExhaustedIfConfirmed();
          if (isLastModel) {
            if (froze) {
              throw new Error(
                '💳 OUT OF CREDITS: OpenRouter account needs more credits. Visit https://openrouter.ai/settings/credits to add funds.'
              );
            }
            throw new Error(
              `❌ LLM billing error (balance still positive): ${errorMessage.substring(0, 160)}`
            );
          }
        } else if (errorStatus === 429) {
          let nextModelMsg: string;
          if (isLastModel) {
            nextModelMsg = '';
          } else {
            nextModelMsg = ', trying next model...';
          }
          logger.warn(`🚦 Rate limit hit${nextModelMsg}`);
          if (isLastModel) {
            throw new Error(
              '⏱️ RATE LIMITED: Too many requests to OpenRouter. Please wait and try again.'
            );
          }
        } else if (errorStatus === 500 || errorStatus === 502 || errorStatus === 503) {
          let nextModelMsg: string;
          if (isLastModel) {
            nextModelMsg = '';
          } else {
            nextModelMsg = ', trying next model...';
          }
          logger.warn(`🔧 Server error${nextModelMsg}`);
          if (isLastModel) {
            throw new Error(
              `🔧 SERVER ERROR: OpenRouter returned ${errorStatus}. The service may be temporarily unavailable.`
            );
          }
        } else {
          let nextModelMsg: string;
          if (isLastModel) {
            nextModelMsg = '';
          } else {
            nextModelMsg = ', trying next model...';
          }
          logger.warn(`🔄 Unknown error${nextModelMsg}`);
          if (isLastModel) {
            throw new Error(`❌ LLM ERROR: ${errorMessage.substring(0, 200)}`);
          }
        }

        // Try next model
        if (!isLastModel) {
          continue;
        }

        // Last model failed - should have thrown above, but fallback just in case
        logger.error('💥 All models failed. Last error:', error);
        throw error;
      }
    }

    // All models failed
    logger.error('🚨 All OpenRouter models failed');
    throw new Error(
      'All OpenRouter models failed. This may be due to service issues or configuration problems.'
    );
  }

  /**
   * Generate streaming response with partial updates on double linebreaks
   */
  async generateFromMessageChainStreaming(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    userId: string,
    onPartialResponse?: (partial: string) => void,
    messageId?: string,
    selectedModel?: string,
    options?: {
      traceId?: string | null;
      guildId?: string;
      maxTokens?: number; // Dynamic token limit from preflight analysis
      plugins?: unknown[]; // OpenRouter plugins, e.g. [{ id: 'auto-router', cost_tier: 'low' }]
      rotationKey?: string; // sticky rotation per conversation (see stickyRotationIndex)
      stepType?: string; // Cost attribution: 'response' | 'observational_learning' | 'capability' | 'planning'
    }
  ): Promise<string> {
    if (messages.length === 0) {
      throw new Error('No messages provided');
    }
    // KILL SWITCH (manual or daily-budget mute): nothing generates, whoever is asking.
    assertGenerationAllowed(`streaming generation for ${userId}`);
    assertGuildBudget(options?.guildId, `streaming generation for ${userId}`);

    const startTime = Date.now();
    const traceId = options?.traceId;
    const guildId = options?.guildId;
    const requestedMaxTokens = options?.maxTokens;

    // Context Alchemy: Check for experiment variant assignment
    let experimentId: string | null = null;
    let variantId: string | null = null;
    let variantModelOverride: string | undefined;
    let variantTemperature: number | undefined;

    if (traceId) {
      try {
        const variant = await experimentManager.getVariantForUser(userId, guildId);
        experimentId = variant.experimentId;
        variantId = variant.variantId;

        if (variant.config.smartModel && !selectedModel) {
          variantModelOverride = variant.config.smartModel;
          logger.info(
            `🧪 Experiment ${experimentId}: Using model override ${variantModelOverride}`
          );
        }

        if (variant.config.temperature !== undefined) {
          variantTemperature = variant.config.temperature;
          logger.info(`🧪 Experiment ${experimentId}: Using temperature ${variantTemperature}`);
        }
      } catch (error) {
        logger.debug('[experiment] Variant lookup failed, continuing normally');
      }
    }

    // If a specific model was selected (three-tier strategy), use it
    // Otherwise check for experiment override, then rotate through models
    const effectiveModel = selectedModel || variantModelOverride;
    const useSpecificModel = effectiveModel && effectiveModel.trim().length > 0;
    let startIndex: number;
    if (options?.rotationKey) {
      startIndex = stickyRotationIndex(options.rotationKey, this.models.length);
    } else {
      startIndex = this.currentModelIndex;
    }

    // Specifically-requested model first, then the rotation as fallback (see the
    // non-streaming path — a bare [effectiveModel] turns one transient error into silence).
    let modelsToTry: string[];
    if (useSpecificModel) {
      modelsToTry = [effectiveModel, ...this.models.filter((m) => m !== effectiveModel)];
    } else {
      modelsToTry = this.models;
    }

    let generationMode: string;
    if (useSpecificModel) {
      generationMode = `using SPECIFIC model ${effectiveModel}`;
    } else {
      generationMode = `using model rotation`;
    }
    logger.info(
      `🤖 Starting streaming generation for user ${userId} ${generationMode}`
    );

    for (let i = 0; i < modelsToTry.length; i++) {
      let modelSpec: string;
      if (useSpecificModel) {
        modelSpec = modelsToTry[i];
      } else {
        modelSpec = this.models[(startIndex + i) % this.models.length];
      }
      // "auto:<tier>[:allowed]" specs → openrouter/auto + the auto-router plugin (model-spec.ts);
      // plugins passed in by the caller (brownout's final-third route) take precedence.
      const resolved = resolveModelSpec(modelSpec);
      const model = resolved.model;
      const plugins = options?.plugins ?? resolved.plugins;

      try {
        let modelLabel: string;
        if (useSpecificModel) {
          modelLabel = '(SPECIFIC)';
        } else {
          modelLabel = `(${i + 1}/${modelsToTry.length})`;
        }
        logger.info(
          `📡 Attempting streaming with model ${model} ${modelLabel}`
        );

        // Use preflight-analyzed maxTokens if provided, otherwise fall back to env default
        const maxTokens = requestedMaxTokens || parseInt(process.env.LLM_MAX_TOKENS || '400', 10);
        const temperature = variantTemperature ?? 0.7;

        // Same breakpoint as the non-streaming path — this is the one Discord actually uses.
        const cache = applyCacheControl(messages, model);
        let cacheMessage: string;
        if (cache.applied) {
          cacheMessage = `🗄️ Prompt cache: breakpoint on ${cache.prefixTokens}tok system prefix (${model}, streaming)`;
        } else {
          cacheMessage = `🗄️ Prompt cache: not applied — ${cache.reason}`;
        }
        logger.info(cacheMessage);

        const extraBody: Record<string, unknown> = {};
        if (plugins) {
          extraBody.plugins = plugins;
        }
        // OpenRouter's usage accounting reports the exact USD cost of every call, so new
        // models and ~latest aliases bill correctly without a price-table entry (EJ,
        // 2026-10-31: models change too fast to hardcode). The table is only a fallback.
        extraBody.usage = { include: true };
        if (isAutoRouted(model) && autoReasoningFor(plugins)) {
          extraBody.reasoning = autoReasoningFor(plugins);
        }
        const completion: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> = await this.createCompletion({
          model,
          messages: cache.messages,
          max_tokens: maxTokens,
          temperature,
          stream: true, // Enable streaming
          stream_options: { include_usage: true }, // Request usage data in stream
          ...extraBody,
        });
        let servedModel: string | undefined; // the concrete model, reported on each chunk
        let reportedCost: number | undefined; // usage accounting, final chunk

        let fullResponse = '';
        let lastSentLength = 0;
        let usage: TokenUsage | undefined;

        // Process streaming chunks - send new paragraphs as they complete
        for await (const chunk of completion) {
          if (chunk.model) servedModel = chunk.model;
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) {
            fullResponse += delta;

            // Check for completed paragraphs (double newline indicates paragraph end)
            if (delta.includes('\n\n') && onPartialResponse) {
              // Find the new content since last sent
              if (fullResponse.length > lastSentLength) {
                // Look for complete paragraphs in the new content
                const newContent = fullResponse.slice(lastSentLength);
                const paragraphEndIndex = newContent.indexOf('\n\n');

                if (paragraphEndIndex !== -1) {
                  // We have at least one complete paragraph
                  const completeParagraph = newContent.slice(0, paragraphEndIndex).trim();
                  if (completeParagraph) {
                    onPartialResponse(completeParagraph);
                    lastSentLength = lastSentLength + paragraphEndIndex + 2; // +2 for '\n\n'
                  }
                }
              }
            }
          }

          // Capture usage data from final chunk (OpenRouter sends it at the end)
          if (chunk.usage) {
            const c = Number((chunk.usage as { cost?: unknown }).cost);
            if (Number.isFinite(c)) reportedCost = c;
            usage = {
              prompt_tokens: chunk.usage.prompt_tokens || 0,
              completion_tokens: chunk.usage.completion_tokens || 0,
              total_tokens: chunk.usage.total_tokens || 0,
              cached_tokens: readCacheUsage(chunk.usage).read,
              cache_write_tokens: readCacheUsage(chunk.usage).write,
            };
            const cu = readCacheUsage(chunk.usage);
            logger.info(
              `🗄️ Cache usage: read ${cu.read}, write ${cu.write} of ${usage.prompt_tokens} prompt tokens (${model}, streaming)`
            );
          }
        }

        const responseTime = Date.now() - startTime;

        // If we didn't get usage data from stream, estimate it
        if (!usage) {
          logger.warn('⚠️ No usage data received from streaming API, estimating tokens');
          const estimatedPromptTokens = Math.ceil(
            cache.messages.reduce((total, msg) => total + wireContentLength(msg.content), 0) / 4
          );
          const estimatedCompletionTokens = estimateTokens(fullResponse);
          usage = {
            prompt_tokens: estimatedPromptTokens,
            completion_tokens: estimatedCompletionTokens,
            total_tokens: estimatedPromptTokens + estimatedCompletionTokens,
            // Estimated, so cache activity is unknown — 0 here means "unmeasured", not "no
            // cache hit". Only trust cached_tokens on rows where the API reported usage.
            cached_tokens: 0,
          };
        }

        // Calculate cost and track usage
        const billedModel = servedModelName(servedModel, model);
        const estimatedCost = billedCost(reportedCost, billedModel, usage);

        // Track costs in real-time cost monitor
        const streamingCost = finiteOrUndefined(reportedCost);
        const { warnings: streamWarnings } = costMonitor.trackCall(
          usage.prompt_tokens,
          usage.completion_tokens,
          billedModel,
          usage.cached_tokens ?? 0,
          streamingCost
        );

        // Log warnings if any
        if (streamWarnings.length > 0) {
          logger.warn(`💸 Cost warnings for streaming call:`, streamWarnings);
        }

        // Record usage statistics (don't await to avoid blocking)
        {
          UsageTracker.recordUsage({
            model_name: billedModel,
            guild_id: options?.guildId ?? null,
            user_id: userId,
            message_id: messageId ?? '',
            input_length: cache.messages.reduce(
              (total, msg) => total + wireContentLength(msg.content),
              0
            ),
            output_length: fullResponse.length,
            response_time_ms: responseTime,
            capabilities_detected: 0,
            capabilities_executed: 0,
            capability_types: '',
            success: true,
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            cached_tokens: usage.cached_tokens ?? 0,
            cache_write_tokens: usage.cache_write_tokens ?? 0,
            estimated_cost: estimatedCost,
            step_type: stepTypeFor(userId, messageId, options?.stepType),
          }).catch((error) => {
            logger.error('Failed to record streaming usage stats:', error);
          });
        }

        // Rotate to next model for testing different models' tool usage
        this.currentModelIndex = (this.currentModelIndex + 1) % this.models.length;

        // Context Alchemy: Update trace with model and cost info
        if (traceId) {
          await traceManager.updateTrace(traceId, {
            modelUsed: model,
            modelTier: this.getModelTier(model),
            responseTokens: usage.completion_tokens,
            estimatedCost,
            experimentId: experimentId || undefined,
            variantId: variantId || undefined,
          });
        }

        logger.info(
          `✅ Streaming completed for user ${userId} using ${model} (${usage.total_tokens} tokens, $${estimatedCost.toFixed(4)})`
        );
        logger.info(`🔄 Rotated to next model: ${this.getCurrentModel()}`);
        return fullResponse.trim();
      } catch (error: unknown) {
        const errorMessage = getErrorMessage(error);
        const errorStatus = (error as { status?: number }).status;

        logger.warn(`❌ Streaming with model ${model} failed:`, {
          error: errorMessage,
          status: errorStatus,
          modelIndex: i + 1,
          totalModels: modelsToTry.length,
        });

        // Track if this is a credit/billing error
        const isCreditError =
          errorMessage.includes('credit') ||
          errorMessage.includes('billing') ||
          errorMessage.includes('quota') ||
          errorStatus === 402;

        const isLastModel = i === modelsToTry.length - 1;

        // Throw clear errors on last model failure
        if (isLastModel) {
          if (isCreditError) {
            throw new Error(
              '💳 OUT OF CREDITS: OpenRouter account needs more credits. Visit https://openrouter.ai/settings/credits to add funds.'
            );
          } else if (errorStatus === 429) {
            throw new Error(
              '⏱️ RATE LIMITED: Too many requests to OpenRouter. Please wait and try again.'
            );
          } else if (errorStatus === 500 || errorStatus === 502 || errorStatus === 503) {
            throw new Error(
              `🔧 SERVER ERROR: OpenRouter returned ${errorStatus}. The service may be temporarily unavailable.`
            );
          } else {
            throw new Error(`❌ LLM ERROR: ${errorMessage.substring(0, 200)}`);
          }
        }

        // Try next model on failure
        continue;
      }
    }

    // Fallback response - should not reach here
    logger.error('🚨 All streaming attempts failed');
    throw new Error('❌ All LLM models failed. Check OpenRouter status and credits.');
  }
}

// Export singleton instance
export const openRouterService = new OpenRouterService();
