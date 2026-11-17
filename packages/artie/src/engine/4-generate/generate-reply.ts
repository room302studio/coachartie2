import { logger } from '../../shared/logger.js';
import { IncomingMessage } from '../../shared/queue/types.js';
import { estimateTokens } from '../../shared/async.js';
import { stripChatPrefixes, stripInternalMarkup } from '../../shared/clean-llm-output.js';
import { openRouterService } from './openrouter.js';
import { promptManager } from '../3-context/system-prompt.js';
import { contextAlchemy } from '../3-context/assemble.js';
import { modelAwarePrompter } from './model-prompt-style.js';
import { preflightAnalyzer } from './preflight.js';
import { getBrownoutMode, applyBrevityNote, brownoutMaxTokens, brownoutRoute } from '../budget/brownout.js';
import { experimentManager } from '../3-context/experiments.js';
import { errorTracker, ERROR_TYPES } from './error-tracker.js';
import { CapabilityResult, OrchestrationContext } from '../2-turn/types.js';
import { runToolLoop, type ToolLoopDeps } from '../5-tool-loop/native-loop.js';
import { registryToTools } from '../5-tool-loop/tool-schema.js';
import { recordToolTurn, shadowRouters, type ToolTurnContext } from '../2-turn/tool-exposure.js';
import { capabilityRegistry } from '../5-tool-loop/registry.js';
import { getErrorMessage } from '../error-utils.js';
import { generateReflectionFacts, type ReflectionType } from '../2-turn/reflection-facts.js';

/** Per-turn options handed to every openRouterService call in this turn. */
interface TurnGenerationOptions {
  traceId?: string | null;
  guildId?: string;
  maxTokens: number;
  plugins?: unknown[];
  reasoning?: Record<string, unknown>;
}

// =====================================================
// LLM RESPONSE COORDINATOR
// Handles all LLM interactions and response generation
// =====================================================

export class LLMResponseCoordinator {
  private static instance: LLMResponseCoordinator;

  static getInstance(): LLMResponseCoordinator {
    if (!LLMResponseCoordinator.instance) {
      LLMResponseCoordinator.instance = new LLMResponseCoordinator();
    }
    return LLMResponseCoordinator.instance;
  }

  /**
   * Get LLM response with capability extraction (the XML path's first generate).
   * XML-LOOP: delete after v3 soak (TOOL_LOOP=xml)
   */
  async getLLMResponseWithCapabilities(
    message: IncomingMessage,
    onPartialResponse?: (partial: string) => void,
    capabilityNames?: string[]
  ): Promise<string> {
    try {
      logger.info(`🚀 getLLMResponseWithCapabilities called for message: "${message.message}"`);
      const turn = await this.prepareTurn(message, capabilityNames, 'xml');
      const { modelAwareMessages, smartModel, generationOptions } = turn;

      // Use streaming if callback provided, otherwise regular generation
      // Pass the fast model explicitly to ensure consistent model selection
      // Context Alchemy: Include traceId and guildId for observability
      // Preflight: Include maxTokens for dynamic response length
      let generated: string;
      if (onPartialResponse) {
        generated = await openRouterService.generateFromMessageChainStreaming(
            modelAwareMessages,
            message.userId,
            onPartialResponse,
            message.id,
            smartModel,
            generationOptions
          );
      } else {
        generated = await openRouterService.generateFromMessageChain(
            modelAwareMessages,
            message.userId,
            message.id,
            smartModel,
            generationOptions
          );
      }

      return this.disarmWarden(generated, turn);
    } catch (error: any) {
      return this.rethrowClassified(error, message);
    }
  }

  /**
   * The NATIVE tool turn (wave 8, the default): the same prepared prompt as the XML path
   * (preflight, context assembly, complexity route, brownout model/max_tokens/brevity note),
   * then runToolLoop with openrouter's generateWithTools and the given executeTool. Tool turns
   * are non-streaming; the caller hands the final text to onPartialResponse.
   *
   * If a later round fails after the model already said something (e.g. every model 5xx on
   * round 3), that text is the reply instead of an error, the way the XML path fell back to its
   * first response when the ReAct loop threw.
   */
  async getNativeToolResponse(
    message: IncomingMessage,
    deps: Pick<ToolLoopDeps, 'executeTool' | 'deadlineAt'> & {
      onStep?: ToolLoopDeps['onStep'];
    }
  ): Promise<string> {
    try {
      const turn = await this.prepareTurn(message, undefined, 'native');
      // Built per turn (skills can register after boot); same registry → same bytes.
      const tools = registryToTools(capabilityRegistry.list());
      // Tool exposure log: what he was offered, what he called, what shadow routers would
      // have offered (EJ, 2026-10-31: every live turn should be an eval sample).
      const exposure: ToolTurnContext = {
        messageId: message.id,
        traceId: message.context?.traceId,
        userId: message.userId,
        guildId: message.context?.guildId,
        channelId: message.context?.channelId,
      };
      const shadow = shadowRouters(exposure);
      const called: string[] = [];
      let round = 0;
      let lastText = '';

      const generate: ToolLoopDeps['generate'] = async (msgs, offered) => {
        round++;
        let messageId: string;
        if (round === 1) {
          messageId = message.id;
        } else {
          messageId = `${message.id}_tool_${round}`;
        }
        let toolChoice: 'auto' | 'none';
        if (offered.length > 0) {
          toolChoice = 'auto';
        } else {
          toolChoice = 'none';
        }
        const result = await openRouterService.generateWithTools(
          msgs,
          tools, // the full list every round, so the cached prefix never changes
          message.userId,
          messageId,
          turn.smartModel,
          { ...turn.generationOptions, toolChoice }
        );
        let returnToolCalls: typeof result.toolCalls;
        if (offered.length > 0) {
          returnToolCalls = result.toolCalls;
        } else {
          returnToolCalls = [];
        }
        return { content: result.content, toolCalls: returnToolCalls };
      };

      let finalText: string;
      try {
        const result = await runToolLoop(turn.modelAwareMessages, tools, {
          generate,
          executeTool: (invocation) => {
            called.push(invocation.name);
            return deps.executeTool(invocation);
          },
          deadlineAt: deps.deadlineAt,
          onStep: (step) => {
            if (step.content.trim()) lastText = step.content;
            deps.onStep?.(step);
          },
        });
        logger.info(
          `🔧 Native tool loop: ${result.stoppedReason} after ${result.iterations} round(s), ${result.toolCallsMade} tool call(s)`
        );
        finalText = result.finalText;
      } catch (loopError) {
        if (round > 1 && lastText) {
          logger.warn(
            `⚠️ Native tool loop failed on round ${round}; replying with the text it already had: ${getErrorMessage(loopError)}`
          );
          finalText = lastText;
        } else {
          throw loopError;
        }
      } finally {
        recordToolTurn({ ctx: exposure, offered: tools, called, shadow });
      }

      return this.disarmWarden(this.stripThinkingTags(finalText, message.userId, message.id), turn);
    } catch (error: any) {
      return this.rethrowClassified(error, message);
    }
  }

  /**
   * Everything before the first generate, shared by both loops: preflight, the base system
   * prompt, context assembly, the complexity route and brownout (model, max_tokens, brevity).
   */
  private async prepareTurn(
    message: IncomingMessage,
    capabilityNames: string[] | undefined,
    mode: 'native' | 'xml'
  ): Promise<{
    modelAwareMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    smartModel: string;
    generationOptions: TurnGenerationOptions;
    brownout: Awaited<ReturnType<typeof getBrownoutMode>>;
  }> {
    {
      // Use micro LLM for smart preflight analysis
      // No regex heuristics - let a cheap fast model make intelligent decisions
      const preflight = await preflightAnalyzer.analyze(message.message);

      // Get base capability instructions template
      const baseInstructions = await promptManager.getCapabilityInstructions(message.message);

      // Check for experiment feature flags (memory/rules ablation)
      let experimentFeatureFlags: { enableMemories?: boolean; enableRules?: boolean } = {};
      if (message.context?.traceId) {
        try {
          const variant = await experimentManager.getVariantForUser(
            message.userId,
            message.context?.guildId
          );
          if (variant.experimentId) {
            experimentFeatureFlags = {
              enableMemories: variant.config.enableMemories,
              enableRules: variant.config.enableRules,
            };
            if (variant.config.enableMemories === false || variant.config.enableRules === false) {
              logger.info(
                `🧪 Experiment ${variant.experimentId}: Feature flags applied`,
                experimentFeatureFlags
              );
            }
          }
        } catch (error) {
          // Experiment lookup failed, continue with defaults
        }
      }

      // Use Context Alchemy to build intelligent message chain
      logger.info('🧪 CONTEXT ALCHEMY: Building intelligent message chain');
      let discordContext: typeof message.context | undefined;
      if (message.context?.platform === 'discord' || message.context?.guildKnowledge) {
        discordContext = message.context;
      } else {
        discordContext = undefined;
      }
      const { messages } = await contextAlchemy.buildMessageChain(
        message.message,
        message.userId,
        baseInstructions,
        undefined, // existingMessages
        {
          source: message.source,
          capabilityContext: capabilityNames, // Pass capability names to enable capability learnings
          channelId: message.context?.channelId,
          // Pass Discord channel history - source of truth for DMs (includes webhook/n8n messages)
          discordChannelHistory: message.context?.channelHistory,
          // Pass full Discord context for guild knowledge, proactive answering, etc.
          discordContext,
          // Context Alchemy observability: pass trace ID for metrics capture
          traceId: message.context?.traceId,
          // Experiment feature flags for memory/rules ablation
          ...experimentFeatureFlags,
        }
      );

      // Complexity-routed model selection (Anthropic "routing" pattern): the preflight
      // micro-LLM already classifies every message, but we were sending EVERYTHING to
      // SMART_MODEL — every one-liner in a busy channel rode Opus, which is where the
      // 180s job deadline kept killing replies. Simple banter now takes a fast-but-good
      // model; anything moderate/complex (or unclassified) keeps the smart model.
      const simpleChatModel = process.env.SIMPLE_CHAT_MODEL || 'anthropic/claude-sonnet-5';
      const routeSimple = preflight.complexity === 'simple';
      let smartModel: string;
      if (routeSimple) {
        smartModel = simpleChatModel;
      } else {
        smartModel = openRouterService.selectSmartModel();
      }

      // Brownout override (see brownout.ts): when credit runway shrinks, step
      // down to cheaper models + shorter replies instead of going silent.
      // 'normal' mode leaves the complexity route above completely untouched.
      // The mode is the more conservative of credit runway and today's spend vs
      // DAILY_BUDGET_USD — see brownout.ts.
      // His persona model until the final third of either tank, then OpenRouter's auto-router
      // at a low cost tier (see brownoutRoute). Length tapering applies throughout.
      const brownout = await getBrownoutMode();
      const maxTokens = brownoutMaxTokens(brownout.mode, preflight.responseTokens);
      const route = brownoutRoute(brownout, smartModel);
      smartModel = route.model;
      if (brownout.mode !== 'normal') {
        let daily: string;
        if (typeof brownout.dailySpendFraction === 'number') {
          daily = `${Math.round(brownout.dailySpendFraction * 100)}% of daily budget`;
        } else {
          daily = 'daily n/a';
        }
        logger.warn(
          `🕯️ Brownout ${brownout.mode.toUpperCase()} (runway ${brownout.runwayHours?.toFixed(1) ?? '?'}h, ${daily}) → ${smartModel}, maxTokens ${maxTokens}`
        );
      }
      let messagesToProcess: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
      if (mode === 'native') {
        messagesToProcess = messages;
      } else {
        // XML-LOOP: delete after v3 soak (TOOL_LOOP=xml). A pass-through today.
        messagesToProcess = messages.map((msg) => {
          if (msg.role === 'system') {
            return {
              ...msg,
              content: modelAwarePrompter.generateCapabilityPrompt(smartModel, msg.content),
            };
          }
          return msg;
        });
      }
      const modelAwareMessages = applyBrevityNote(
        messagesToProcess,
        // Lean/critical cap max_tokens; ask for a complete short reply that fits rather than
        // a normal one that gets cut off. Inserted after the cache breakpoint.
        brownout.mode
      );

      let routeLabel: string;
      if (routeSimple) {
        routeLabel = 'SIMPLE';
      } else {
        routeLabel = preflight.complexity.toUpperCase();
      }
      logger.warn(
        `🎯 Model route: ${routeLabel} → ${smartModel} (${modelAwareMessages.length} messages)`
      );

      // Context Alchemy: Include traceId and guildId for observability
      // Preflight: Include maxTokens for dynamic response length
      const generationOptions: TurnGenerationOptions = {
        traceId: message.context?.traceId,
        guildId: message.context?.guildId,
        maxTokens,
        plugins: route.plugins,
      };
      if (brownout.mode !== 'normal') {
        // Reasoning tokens count against max_tokens. Under the lean 500 cap Opus thought
        // through the whole budget and wrote nothing, then the fallback was cut mid-bullet
        // (2026-11-17; 48 reasoning-only empties in the logs). A short reply doesn't need to
        // think first. "none" falls back to hidden low effort on reasoning-mandatory models.
        generationOptions.reasoning = { effort: 'none' };
      }

      return { modelAwareMessages, smartModel, generationOptions, brownout };
    }
  }

  /**
   * WARDEN DISARM: the [TIMEOUT] marker is a live moderation weapon that the
   * model wields at its own judgment. Under brownout that judgment belongs to
   * a token-capped budget model — which timed out a friendly user for asking a
   * question (rhodie3587, 2026-07-16). Degraded cognition ≠ moderation duty:
   * strip the marker before it reaches the discord side unless we're in
   * normal mode on the full model. Applies to both loops' final text.
   */
  private disarmWarden(
    generated: string,
    turn: { brownout: { mode: string }; smartModel: string }
  ): string {
    if (turn.brownout.mode !== 'normal' && generated && /\[TIMEOUT(?::\d{1,3})?\]/i.test(generated)) {
      logger.warn(
        `🕯️ Brownout ${turn.brownout.mode}: discarding [TIMEOUT] marker from ${turn.smartModel} — degraded models don't get warden powers`
      );
      return generated.replace(/\[TIMEOUT(?::\d{1,3})?\]/gi, '').trim();
    }
    return generated;
  }

  /** Classify a generate failure into the operator-facing error run-turn maps to a reply. */
  private async rethrowClassified(error: any, message: IncomingMessage): Promise<never> {
    {
      const errorMessage = error?.message || String(error);
      const traceId = message.context?.traceId;

      // Check for billing/credit errors (402)
      if (
        errorMessage.includes('402') ||
        errorMessage.includes('credits') ||
        errorMessage.includes('billing')
      ) {
        logger.error('💳 OpenRouter billing error - out of credits', error);
        await errorTracker.trackError({
          error,
          errorType: ERROR_TYPES.LLM_BILLING,
          service: 'openrouter',
          severity: 'critical',
          context: { traceId, userId: message.userId },
        });
        throw new Error(
          `💳 OUT OF CREDITS: OpenRouter account needs more credits. Visit https://openrouter.ai/settings/credits to add funds.`
        );
      }

      // Check for rate limiting (429)
      if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
        logger.error('⏱️ Rate limited by OpenRouter', error);
        await errorTracker.trackError({
          error,
          errorType: ERROR_TYPES.LLM_RATE_LIMIT,
          service: 'openrouter',
          severity: 'warning',
          context: { traceId, userId: message.userId },
        });
        throw new Error(`⏱️ RATE LIMITED: Too many requests. Please wait a moment and try again.`);
      }

      // Check for auth errors (401/403)
      if (
        errorMessage.includes('401') ||
        errorMessage.includes('403') ||
        errorMessage.includes('unauthorized') ||
        errorMessage.includes('invalid.*key')
      ) {
        logger.error('🔑 OpenRouter authentication error', error);
        await errorTracker.trackError({
          error,
          errorType: ERROR_TYPES.LLM_AUTH,
          service: 'openrouter',
          severity: 'critical',
          context: { traceId, userId: message.userId },
        });
        throw new Error(
          `🔑 AUTH ERROR: OpenRouter API key is invalid or missing. Check OPENROUTER_API_KEY environment variable.`
        );
      }

      // Check for network errors
      if (
        errorMessage.includes('ECONNREFUSED') ||
        errorMessage.includes('ETIMEDOUT') ||
        errorMessage.includes('fetch failed')
      ) {
        logger.error('🌐 Network error connecting to OpenRouter', error);
        await errorTracker.trackError({
          error,
          errorType: ERROR_TYPES.NETWORK_ERROR,
          service: 'openrouter',
          severity: 'error',
          context: { traceId, userId: message.userId },
        });
        throw new Error(
          `🌐 NETWORK ERROR: Could not connect to OpenRouter API. Check internet connection.`
        );
      }

      // Check for model errors
      if (errorMessage.includes('All OpenRouter models failed')) {
        logger.error('🤖 All LLM models failed', error);
        await errorTracker.trackError({
          error,
          errorType: ERROR_TYPES.LLM_MODEL,
          service: 'openrouter',
          severity: 'error',
          context: { traceId, userId: message.userId },
        });
        throw new Error(`🤖 ALL MODELS FAILED: ${errorMessage}`);
      }

      // Unknown error - log full details and throw with context
      logger.error('❌ LLM request failed with unknown error', {
        error: errorMessage,
        stack: error?.stack,
      });
      await errorTracker.trackError({
        error,
        errorType: ERROR_TYPES.UNKNOWN,
        service: 'openrouter',
        severity: 'error',
        context: { traceId, userId: message.userId },
      });
      throw new Error(`❌ LLM ERROR: ${errorMessage.substring(0, 200)}`);
    }
  }

  /**
   * The facts worth remembering from one turn, as {"facts": string[]} (wave 10): [] means
   * nothing to remember (or an unparseable reply, logged once). The prompt is code-owned and
   * persona-free — see 2-turn/reflection-facts.ts. PROMPT_REFLECTION_GENERAL /
   * PROMPT_REFLECTION_CAPABILITY in the prompts table are no longer read here.
   */
  async generateReflection(
    contextText: string,
    type: ReflectionType,
    userId: string,
    /** Conversation key: keeps this conversation's reflections on one model so its cache stays warm. */
    rotationKey?: string
  ): Promise<string[]> {
    return generateReflectionFacts(contextText, type, userId, rotationKey);
  }

  /**
   * Build capability context for reflection
   * Formats capability execution details for memory storage
   */
  buildCapabilityContext(context: OrchestrationContext): string {
    const capabilityDetails = context.capabilities
      .map((cap, i) => {
        const result = context.results[i];
        let status: string;
        if (result) {
          if (result.success) {
            status = 'SUCCESS';
          } else {
            status = 'FAILED';
          }
        } else {
          status = 'UNKNOWN';
        }
        let data = '';
        if (result?.data) {
          data = ` - Result: ${JSON.stringify(result.data).substring(0, 100)}`;
        }
        let error = '';
        if (result?.error) {
          error = ` - Error: ${result.error}`;
        }

        return `Capability ${i + 1}: ${cap.name}:${cap.action}
Arguments: ${JSON.stringify(cap.params)}
Content: ${cap.content || 'none'}
Status: ${status}${data}${error}`;
      })
      .join('\n\n');

    return `User Message: ${context.originalMessage}

Capabilities Used:
${capabilityDetails}`;
  }

  /**
   * Strip thinking tags and other internal artifacts from LLM responses
   * Security measure to prevent information disclosure
   */
  stripThinkingTags(content: string, _userId?: string, _messageId?: string): string {
    // Remove thinking tags, then (SECURITY) internal prompt artifacts that should never be
    // exposed: <security_reminder>, [USER_MESSAGE] and [SYSTEM: …] blocks.
    let result = stripInternalMarkup(content, ['thinking', 'security_reminder', 'USER_MESSAGE', 'SYSTEM']);

    // Remove role prefixes the LLM shouldn't use
    result = stripChatPrefixes(result, 'reply');

    // Remove <artie> wrapper tags some models add (seen in Llama/Mistral outputs)
    result = stripInternalMarkup(result, ['artie']);

    // Use trimEnd() to preserve leading spaces needed for text concatenation
    return result.trimEnd();
  }

  /**
   * XML-LOOP: delete after v3 soak (TOOL_LOOP=xml). The native loop has no <wants_loop>.
   * Extract loop decision from LLM response
   * Checks for <wants_loop>true</wants_loop> signal in the response
   * Returns both the cleaned response and the loop decision flag
   */
  extractLoopDecision(content: string): { response: string; wantsLoop: boolean } {
    const wantsLoopMatch = content.match(/<wants_loop>(true|false)<\/wants_loop>/i);
    const hasCapabilities = content.includes('<capability');

    // CRITICAL: Also detect shorthand capability tags like <read>, <recall>, <websearch> etc.
    // These are aliases defined in xml-parser.ts that expand to full capability calls
    const shorthandTags = [
      // File operations
      'read',
      'readfile',
      'write',
      'writefile',
      'append',
      'listdir',
      'ls',
      'exists',
      'mkdir',
      'rm',
      'delete',
      // Memory
      'remember',
      'store',
      'recall',
      'forget',
      // Search
      'search',
      'websearch',
      'google',
      // Vision
      'see',
      'ocr',
      'lookatimage',
      // GitHub
      'github-search_issues',
      'github-get_issue',
      'github-list_issues',
      'github-create_issue',
      'github-search_code',
      'github-get_file',
      'github-list_repo_files',
      'github-get_pr',
      // Calculator
      'calc',
      'calculate',
      'math',
    ];
    const shorthandPattern = new RegExp(`<(${shorthandTags.join('|')})[^>]*>`, 'i');
    const hasShorthandCapabilities = shorthandPattern.test(content);

    // SIMPLE LOGIC: If there are capabilities in the response, execute them.
    // Don't care about explicit tags or defaults - just execute what's there.
    const hasAnyCapabilities = hasCapabilities || hasShorthandCapabilities;
    let wantsLoop = hasAnyCapabilities;
    let decisionSource: string;
    if (hasCapabilities) {
      decisionSource = 'detected <capability> tags';
    } else if (hasShorthandCapabilities) {
      decisionSource = 'detected shorthand capability tags (e.g., <read>, <recall>)';
    } else {
      decisionSource = 'no capabilities found';
    }

    // If there's an explicit wants_loop tag, respect it
    if (wantsLoopMatch) {
      wantsLoop = wantsLoopMatch[1].toLowerCase() === 'true';
      decisionSource = 'explicit wants_loop tag';
    }

    // Remove the wants_loop tag from the response
    const cleanedResponse = stripInternalMarkup(content, ['wants_loop_bool']).trim();

    logger.info(`🎯 Loop decision: wantsLoop=${wantsLoop} (${decisionSource})`);

    return {
      response: cleanedResponse,
      wantsLoop,
    };
  }

  /**
   * XML-LOOP: delete after v3 soak (TOOL_LOOP=xml). Used only by the llm-loop ReAct loop.
   * Extract suggested next actions from capability results
   * Parses "Next Actions:" sections from capability responses
   */
  extractSuggestedNextActions(results: CapabilityResult[]): string[] {
    const suggestions: string[] = [];

    for (const result of results) {
      if (!result.success || !result.data) {
        continue;
      }

      const data = String(result.data);

      // Look for "Next Actions:" section in capability response
      const nextActionsMatch = data.match(/Next Actions?:\s*([\s\S]*?)(?=\n\n|💡|📦|$)/i);
      if (nextActionsMatch) {
        const actionsText = nextActionsMatch[1];

        // Extract capability XML tags from the next actions section
        const capabilityTags = actionsText.match(/<capability[^>]*\/>/g);
        if (capabilityTags) {
          suggestions.push(...capabilityTags);
        }
      }

      // Also look for "💡 Recommended Next Steps:" section
      const recommendedMatch = data.match(/💡 Recommended Next Steps?:\s*([\s\S]*?)(?=\n\n|📦|$)/i);
      if (recommendedMatch) {
        const recommendedText = recommendedMatch[1];
        const capabilityTags = recommendedText.match(/<capability[^>]*\/>/g);
        if (capabilityTags) {
          suggestions.push(...capabilityTags);
        }
      }
    }

    // Deduplicate suggestions
    return [...new Set(suggestions)];
  }

  /**
   * XML-LOOP: delete after v3 soak (TOOL_LOOP=xml). Used only by the llm-loop ReAct loop.
   * Intelligently truncate conversation history to prevent context overflow
   * Keeps first 2 messages (user + initial response) + recent messages within token budget
   */
  truncateConversationHistory(history: string[], maxTokens: number): string[] {
    // Strategy: Keep first 2 messages (user + initial response) + recent N messages
    const keepFirst = 2;

    // Estimate tokens via the shared heuristic
    const estimatedTokens = history.reduce((sum, msg) => sum + estimateTokens(msg), 0);

    if (estimatedTokens <= maxTokens) {
      return history; // No truncation needed
    }

    logger.info(
      `📊 Truncating conversation history: ${estimatedTokens} tokens → target ${maxTokens}`
    );

    // Keep first messages + most recent messages that fit budget
    const firstMessages = history.slice(0, keepFirst);
    const firstTokens = firstMessages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
    const remainingBudget = maxTokens - firstTokens;

    // Take messages from end until budget exhausted
    const recentMessages: string[] = [];
    let currentTokens = 0;

    for (let i = history.length - 1; i >= keepFirst; i--) {
      const msgTokens = estimateTokens(history[i]);
      if (currentTokens + msgTokens > remainingBudget) {
        break;
      }
      recentMessages.unshift(history[i]);
      currentTokens += msgTokens;
    }

    // Add separator if we truncated
    let separator: string[];
    if (recentMessages.length < history.length - keepFirst) {
      separator = ['[... earlier messages omitted for context budget ...]'];
    } else {
      separator = [];
    }

    const truncated = [...firstMessages, ...separator, ...recentMessages];
    const finalTokens = truncated.reduce((sum, msg) => sum + estimateTokens(msg), 0);
    logger.info(`✂️ Truncated to ${truncated.length} messages (${finalTokens} tokens)`);

    return truncated;
  }
}

export const llmResponseCoordinator = LLMResponseCoordinator.getInstance();
