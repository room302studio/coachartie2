import { logger, IncomingMessage } from '@coachartie/shared';
import { estimateTokens } from '@coachartie/shared';
import { openRouterService } from './openrouter.js';
import { promptManager } from './prompt-manager.js';
import { contextAlchemy } from './context-alchemy.js';
import { modelAwarePrompter } from '../../utils/model-aware-prompter.js';
import { preflightAnalyzer } from './preflight-analyzer.js';
import { experimentManager } from '../context-alchemy/index.js';
import { errorTracker, ERROR_TYPES } from '../observability/error-tracker.js';
import {
  ExtractedCapability,
  CapabilityResult,
  OrchestrationContext,
} from '../../types/orchestration-types.js';

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
   * Get LLM response with capability extraction
   * Uses FAST_MODEL for cost-efficient capability pattern matching
   */
  async getLLMResponseWithCapabilities(
    message: IncomingMessage,
    onPartialResponse?: (partial: string) => void,
    capabilityNames?: string[]
  ): Promise<string> {
    try {
      logger.info(`🚀 getLLMResponseWithCapabilities called for message: "${message.message}"`);

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
          discordContext:
            message.context?.platform === 'discord' || message.context?.guildKnowledge
              ? message.context
              : undefined,
          // Context Alchemy observability: pass trace ID for metrics capture
          traceId: message.context?.traceId,
          // Experiment feature flags for memory/rules ablation
          ...experimentFeatureFlags,
        }
      );

      // Use SMART_MODEL for user-facing chat responses - personality & quality matter
      const smartModel = openRouterService.selectSmartModel();
      const modelAwareMessages = messages.map((msg) => {
        if (msg.role === 'system') {
          return {
            ...msg,
            content: modelAwarePrompter.generateCapabilityPrompt(smartModel, msg.content),
          };
        }
        return msg;
      });

      logger.info(
        `🎯 Using Context Alchemy with SMART_MODEL for chat response: ${smartModel} (${modelAwareMessages.length} messages)`
      );

      // Use streaming if callback provided, otherwise regular generation
      // Pass the fast model explicitly to ensure consistent model selection
      // Context Alchemy: Include traceId and guildId for observability
      // Preflight: Include maxTokens for dynamic response length
      const generationOptions = {
        traceId: message.context?.traceId,
        guildId: message.context?.guildId,
        maxTokens: preflight.responseTokens,
      };

      return onPartialResponse
        ? await openRouterService.generateFromMessageChainStreaming(
            modelAwareMessages,
            message.userId,
            onPartialResponse,
            message.id,
            smartModel,
            generationOptions
          )
        : await openRouterService.generateFromMessageChain(
            modelAwareMessages,
            message.userId,
            message.id,
            smartModel,
            generationOptions
          );
    } catch (error: any) {
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
   * Generate reflection using existing prompts from CSV
   * Used for auto-storing learnings in memory
   */
  async generateReflection(
    contextText: string,
    type: 'general' | 'capability',
    userId: string
  ): Promise<string> {
    try {
      // Load reflection prompts from database
      const promptName =
        type === 'general' ? 'PROMPT_REFLECTION_GENERAL' : 'PROMPT_REFLECTION_CAPABILITY';
      const reflectionPrompt = await promptManager.getPrompt(promptName);

      const promptContent =
        reflectionPrompt?.content ||
        (type === 'general'
          ? `In the dialogue I just sent, identify and list the key details worth remembering for future conversations:

- Remember any hard facts – numeric values, URLs, dates, names, technical specifications
- Remember user preferences, goals, and context about their projects
- Remember important decisions or conclusions reached
- Focus on information that will be useful later

Never respond in the negative - if there are no hard facts, simply respond with "✨".

Format your response as a bullet list of memorable facts.`
          : `In the dialogue I just sent, identify and list the key learnings about capability usage:

- Remember the capability you used and the exact arguments that worked
- Note any errors encountered and how they were resolved
- Identify what worked well and what didn't
- Extract patterns for future capability usage

Format your response as lessons learned for future reference.`);

      const prompt = `${promptContent}\n\nDialogue:\n${contextText}`;

      // Use Context Alchemy for all LLM requests - SECURITY FIX: Use actual userId for reflection generation
      const baseSystemPrompt = await promptManager.getCapabilityInstructions(prompt);
      const { messages } = await contextAlchemy.buildMessageChain(prompt, userId, baseSystemPrompt);

      const reflection = await openRouterService.generateFromMessageChain(messages, userId);
      return reflection.trim();
    } catch (_error) {
      logger.error(`❌ Failed to generate ${type} reflection:`, _error);
      return '';
    }
  }

  /**
   * Build capability context for reflection
   * Formats capability execution details for memory storage
   */
  buildCapabilityContext(context: OrchestrationContext): string {
    const capabilityDetails = context.capabilities
      .map((cap, i) => {
        const result = context.results[i];
        const status = result ? (result.success ? 'SUCCESS' : 'FAILED') : 'UNKNOWN';
        const data = result?.data
          ? ` - Result: ${JSON.stringify(result.data).substring(0, 100)}`
          : '';
        const error = result?.error ? ` - Error: ${result.error}` : '';

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
    let result = content;

    // Remove thinking tags
    result = result.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');

    // SECURITY: Remove internal prompt artifacts that should never be exposed
    result = result.replace(/<security_reminder>[\s\S]*?<\/security_reminder>/gi, '');
    result = result.replace(/\[USER_MESSAGE\][\s\S]*?\[\/USER_MESSAGE\]/gi, '');
    result = result.replace(/\[SYSTEM:[\s\S]*?(?:\]|→[^\]]*)/g, '');

    // Remove role prefixes the LLM shouldn't use
    result = result.replace(/^\[artie\]:\s*/i, '');
    result = result.replace(/^\*\*Response:\*\*\s*/i, '');
    result = result.replace(/^\*\*Me:\*\*\s*/i, '');
    result = result.replace(/^\*\*Artie:\*\*\s*/i, '');
    result = result.replace(/^\*\*Coach Artie:\*\*\s*/i, '');

    // Remove <artie> wrapper tags some models add (seen in Llama/Mistral outputs)
    result = result.replace(/<\/?artie>/gi, '');

    // Use trimEnd() to preserve leading spaces needed for text concatenation
    return result.trimEnd();
  }

  /**
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
    let decisionSource = hasCapabilities
      ? 'detected <capability> tags'
      : hasShorthandCapabilities
        ? 'detected shorthand capability tags (e.g., <read>, <recall>)'
        : 'no capabilities found';

    // If there's an explicit wants_loop tag, respect it
    if (wantsLoopMatch) {
      wantsLoop = wantsLoopMatch[1].toLowerCase() === 'true';
      decisionSource = 'explicit wants_loop tag';
    }

    // Remove the wants_loop tag from the response
    const cleanedResponse = content.replace(/<wants_loop>(true|false)<\/wants_loop>/gi, '').trim();

    logger.info(`🎯 Loop decision: wantsLoop=${wantsLoop} (${decisionSource})`);

    return {
      response: cleanedResponse,
      wantsLoop,
    };
  }

  /**
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
    const separator =
      recentMessages.length < history.length - keepFirst
        ? ['[... earlier messages omitted for context budget ...]']
        : [];

    const truncated = [...firstMessages, ...separator, ...recentMessages];
    const finalTokens = truncated.reduce((sum, msg) => sum + estimateTokens(msg), 0);
    logger.info(`✂️ Truncated to ${truncated.length} messages (${finalTokens} tokens)`);

    return truncated;
  }
}

export const llmResponseCoordinator = LLMResponseCoordinator.getInstance();
