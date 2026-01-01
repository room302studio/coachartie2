import { logger } from '@coachartie/shared';
import { openRouterService } from './openrouter.js';
import { promptManager } from './prompt-manager.js';
import { contextAlchemy } from './context-alchemy.js';
import { robustExecutor } from '../utils/robust-capability-executor.js';
import { capabilityParser } from './capability-parser.js';
import { capabilityExecutor } from './capability-executor.js';
import { llmResponseCoordinator } from './llm-response-coordinator.js';
import { getErrorMessage } from '../utils/error-utils.js';
import { OrchestrationContext, CapabilityResult } from '../types/orchestration-types.js';

// =====================================================
// LLM LOOP SERVICE
// Handles autonomous LLM-driven exploration and execution
// =====================================================

export class LLMLoopService {
  private static instance: LLMLoopService;

  static getInstance(): LLMLoopService {
    if (!LLMLoopService.instance) {
      LLMLoopService.instance = new LLMLoopService();
    }
    return LLMLoopService.instance;
  }

  /**
   * LLM-driven execution loop - let the LLM decide what to do next
   * The LLM examines results, decides next actions, and executes capabilities autonomously
   */
  async executeLLMDrivenLoop(
    context: OrchestrationContext,
    initialResponse: string,
    onPartialResponse?: (partial: string) => void
  ): Promise<string> {
    // Always use LLM-driven execution - streaming is optional bonus

    logger.info(`🤖 STARTING LLM-DRIVEN EXECUTION LOOP - This confirms new system is active!`);

    // CRITICAL: Global timeout to prevent hung jobs
    const GLOBAL_TIMEOUT_MS = 120000; // 2 minutes
    const startTime = Date.now();

    const checkTimeout = () => {
      const elapsed = Date.now() - startTime;
      if (elapsed > GLOBAL_TIMEOUT_MS) {
        const elapsedSeconds = (elapsed / 1000).toFixed(1);
        logger.warn(
          `⏱️ Orchestration timeout after ${elapsedSeconds}s (limit: ${GLOBAL_TIMEOUT_MS / 1000}s)`
        );
        throw new Error(
          `Orchestration timeout after ${elapsedSeconds}s - this prevents infinite loops and resource exhaustion`
        );
      }
    };

    // Build the conversation history for the loop
    const conversationHistory = [
      `User: ${context.originalMessage}`,
      `Assistant: ${initialResponse}`,
    ];

    // CRITICAL: Extract and execute capabilities from the INITIAL response first
    // This ensures <read>, <recall>, etc. tags in the first response actually get executed
    const initialCapabilities = capabilityParser.extractCapabilities(initialResponse);
    if (initialCapabilities.length > 0) {
      logger.info(
        `📦 Found ${initialCapabilities.length} capabilities in initial response - executing first`
      );

      let systemFeedback = '';
      for (const capability of initialCapabilities) {
        const capabilityKey = `${capability.name}:${capability.action}`;
        try {
          logger.info(`🔧 Executing initial capability: ${capabilityKey}`);

          const processedCapability = await capabilityExecutor.substituteTemplateVariables(
            capability,
            context.results
          );
          const capabilityForExecution = {
            name: processedCapability.name,
            action: processedCapability.action,
            content: processedCapability.content || '',
            params: processedCapability.params,
          };

          const robustResult = await robustExecutor.executeWithRetry(
            capabilityForExecution,
            { userId: context.userId, messageId: context.messageId },
            3
          );

          const result: CapabilityResult = {
            capability: processedCapability,
            success: robustResult.success,
            data: robustResult.data,
            error: robustResult.error,
            timestamp: robustResult.timestamp,
          };

          context.results.push(result);
          context.currentStep++;

          if (result.success) {
            systemFeedback += `[SYSTEM: ${capabilityKey} succeeded → ${result.data}]\n`;
            logger.info(`✅ Initial capability ${capabilityKey} succeeded`);
          } else {
            context.capabilityFailureCount.set(capabilityKey, 1);
            systemFeedback += `[SYSTEM: ${capabilityKey} failed → ${result.error}]\n`;
            logger.error(`❌ Initial capability ${capabilityKey} failed: ${result.error}`);
          }
        } catch (_error) {
          context.capabilityFailureCount.set(capabilityKey, 1);
          logger.error(`❌ Failed to execute initial capability ${capability.name}:`, _error);
          systemFeedback += `[SYSTEM: ${capabilityKey} threw error → ${_error}]\n`;

          context.results.push({
            capability,
            success: false,
            error: getErrorMessage(_error),
            timestamp: new Date().toISOString(),
          });
          context.currentStep++;
        }
      }

      // Add initial capability results to conversation history
      if (systemFeedback) {
        conversationHistory.push(systemFeedback.trim());
        logger.info(
          `🔄 Added initial capability results to conversation: ${systemFeedback.length} chars`
        );
      }
    }

    let iterationCount = 0;
    const maxIterations = parseInt(process.env.EXPLORATION_MAX_ITERATIONS || '8'); // Reduced from 24 to save costs
    const minIterations = parseInt(process.env.EXPLORATION_MIN_ITERATIONS || '1'); // Reduced from 3 - simple messages don't need iteration

    while (iterationCount < maxIterations) {
      checkTimeout(); // Check timeout before each iteration
      iterationCount++;
      logger.info(
        `🔄 LLM LOOP ITERATION ${iterationCount}/${maxIterations} - RECURSIVE EXECUTION IN PROGRESS`
      );

      // Ask LLM what to do next
      const nextAction = await this.getLLMNextAction(context, conversationHistory);

      if (!nextAction || !nextAction.trim()) {
        logger.info(`🏁 LLM provided empty response - ending loop`);
        break;
      }

      // Extract capabilities from the LLM's next action
      const capabilities = capabilityParser.extractCapabilities(nextAction);

      if (capabilities.length === 0) {
        // LLM wants to stop - check if minimum depth reached
        if (iterationCount < minIterations) {
          logger.warn(
            `⚠️ LLM tried to stop at iteration ${iterationCount} but minimum is ${minIterations} - forcing continuation`
          );
          conversationHistory.push(`Assistant: ${nextAction}`);
          conversationHistory.push(
            `[SYSTEM: Minimum exploration depth not reached. Continue analysis with suggested actions.]`
          );
          continue; // Force loop to continue
        }

        // EXPERIMENTAL: Random auto-loop continuation (~50% chance)
        // This encourages more exploration even when LLM wants to stop
        const randomContinueChance = 0.5; // 50% probability
        const shouldRandomlyContinue = Math.random() < randomContinueChance;

        if (shouldRandomlyContinue && iterationCount < 6) {
          // Only randomly continue if we haven't already done too many iterations
          logger.info(
            `🎲 RANDOM LOOP ACTIVATION: LLM wanted to stop at iteration ${iterationCount}, but random dice favors more exploration!`
          );
          conversationHistory.push(`Assistant: ${nextAction}`);
          conversationHistory.push(
            `[SYSTEM: Random exploration boost activated! You're on a roll - dig deeper. What else could you explore? Any edge cases, patterns, or anomalies worth investigating?]`
          );
          continue; // Force loop to continue
        }

        // Minimum depth reached and no random boost, allow stopping
        logger.info(
          `🏁 LLM provided final response without capabilities after ${iterationCount} iterations: "${nextAction.substring(0, 100)}..."`
        );
        if (onPartialResponse) {
          const cleanResponse = llmResponseCoordinator.stripThinkingTags(
            nextAction,
            context.userId,
            context.messageId
          );
          if (cleanResponse.trim()) {
            onPartialResponse(cleanResponse);
          }
        }

        conversationHistory.push(`Assistant: ${nextAction}`);
        return nextAction;
      }

      // Stream the LLM's response (shows user what's about to happen)
      logger.info(
        `📡 LLM action: "${nextAction.substring(0, 100)}..." with ${capabilities.length} capabilities`
      );
      if (onPartialResponse) {
        const cleanResponse = llmResponseCoordinator.stripThinkingTags(
          nextAction,
          context.userId,
          context.messageId
        );
        if (cleanResponse.trim()) {
          onPartialResponse(cleanResponse);
        }
      }
      conversationHistory.push(`Assistant: ${nextAction}`);

      // Execute the capabilities the LLM requested
      let systemFeedback = '';
      for (const capability of capabilities) {
        // CIRCUIT BREAKER: Check if this capability has failed too many times
        const capabilityKey = `${capability.name}:${capability.action}`;
        const failureCount = context.capabilityFailureCount.get(capabilityKey) || 0;
        const MAX_FAILURES_PER_CAPABILITY = 5;

        if (failureCount >= MAX_FAILURES_PER_CAPABILITY) {
          logger.warn(
            `🚫 CIRCUIT BREAKER: ${capabilityKey} has failed ${failureCount} times - skipping further attempts`
          );
          systemFeedback += `[SYSTEM: ${capabilityKey} circuit breaker open - failed ${failureCount} times. Try a different approach.]\n`;
          continue; // Skip this capability
        }

        try {
          logger.info(
            `🔧 Executing LLM-requested capability: ${capability.name}:${capability.action} (failure count: ${failureCount}/${MAX_FAILURES_PER_CAPABILITY})`
          );

          const processedCapability = await capabilityExecutor.substituteTemplateVariables(
            capability,
            context.results
          );
          const capabilityForExecution = {
            name: processedCapability.name,
            action: processedCapability.action,
            content: processedCapability.content || '',
            params: processedCapability.params,
          };

          const robustResult = await robustExecutor.executeWithRetry(
            capabilityForExecution,
            { userId: context.userId, messageId: context.messageId },
            3
          );

          const result: CapabilityResult = {
            capability: processedCapability,
            success: robustResult.success,
            data: robustResult.data,
            error: robustResult.error,
            timestamp: robustResult.timestamp,
          };

          context.results.push(result);
          context.currentStep++;

          // Auto-store result to global variable if 'output' param is specified
          const outputVar = processedCapability.params.output;
          if (outputVar && result.success && result.data) {
            const { GlobalVariableStore } = await import('../capabilities/variable-store.js');
            const globalStore = GlobalVariableStore.getInstance();
            await globalStore.set(
              String(outputVar),
              result.data,
              `Auto-stored from ${capability.name}:${capability.action}`
            );
            logger.info(`📦 Auto-stored result to global variable: ${outputVar}`);
          }

          // Add system feedback about the capability execution
          if (result.success) {
            // Reset failure count on success
            context.capabilityFailureCount.set(capabilityKey, 0);
            systemFeedback += `[SYSTEM: ${capability.name}:${capability.action} succeeded → ${result.data}]\n`;
            logger.info(`✅ Capability ${capability.name}:${capability.action} succeeded`);
          } else {
            // Increment failure count
            context.capabilityFailureCount.set(capabilityKey, failureCount + 1);
            systemFeedback += `[SYSTEM: ${capability.name}:${capability.action} failed (attempt ${failureCount + 1}/${MAX_FAILURES_PER_CAPABILITY}) → ${result.error}]\n`;
            logger.error(
              `❌ Capability ${capability.name}:${capability.action} failed: ${result.error}`
            );
          }
        } catch (_error) {
          // Increment failure count on exception
          context.capabilityFailureCount.set(capabilityKey, failureCount + 1);
          logger.error(`❌ Failed to execute capability ${capability.name}:`, _error);
          systemFeedback += `[SYSTEM: ${capability.name}:${capability.action} threw error (attempt ${failureCount + 1}/${MAX_FAILURES_PER_CAPABILITY}) → ${_error}]\n`;

          context.results.push({
            capability,
            success: false,
            error: getErrorMessage(_error),
            timestamp: new Date().toISOString(),
          });
          context.currentStep++;
        }
      }

      // Add self-reflection context so LLM can see its own execution
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const recentOps = context.results
        .slice(-6)
        .map((r) => `${r.capability.name}:${r.capability.action}`)
        .join(', ');
      const selfReflection = `\n[SELF-REFLECTION]\nIteration: ${iterationCount}/${maxIterations}, Time: ${elapsed}s/${GLOBAL_TIMEOUT_MS / 1000}s\nRecent actions: ${recentOps || 'none yet'}\nUser asked: "${context.originalMessage}"\nTake a moment: Are you making progress toward the user's goal? Are you repeating yourself?\n`;
      systemFeedback += selfReflection;

      // Add system feedback to conversation history
      if (systemFeedback) {
        conversationHistory.push(systemFeedback.trim());
        logger.info(`🔄 Added system feedback to conversation: ${systemFeedback.length} chars`);
      }
    }

    logger.warn(`⚠️ LLM-driven loop reached maximum iterations (${maxIterations}) - ending`);
    return "I've completed the available steps for your request.";
  }

  /**
   * Ask LLM what it should do next given the current context
   * Provides autonomous decision-making with error recovery guidance
   */
  private async getLLMNextAction(
    context: OrchestrationContext,
    conversationHistory: string[]
  ): Promise<string> {
    try {
      // CRITICAL: Truncate conversation history to prevent context overflow
      const truncatedHistory = llmResponseCoordinator.truncateConversationHistory(
        conversationHistory,
        3000 // Max tokens for history (leaves room for prompt + response)
      );
      const contextSummary = truncatedHistory.join('\n');

      // SYSTEM: Extract suggested next actions from previous capability results
      const suggestedActions = llmResponseCoordinator.extractSuggestedNextActions(context.results);
      const actionGuidance =
        suggestedActions.length > 0
          ? `\n\nSUGGESTED NEXT ACTIONS (from previous capability results):\n${suggestedActions.join('\n')}\n`
          : '';

      // Calculate exploration depth requirements
      const iterationCount = context.currentStep;
      const minDepth = 3;
      const canStop = iterationCount >= minDepth;
      const progressIndicator = `[Step ${iterationCount + 1}/24]`;

      // Check if previous iteration had errors
      const hasErrors = contextSummary.includes('failed') || contextSummary.includes('error');
      const errorRecoveryPrompt = hasErrors
        ? `

🚨 ERROR RECOVERY PROTOCOL:
Previous capability FAILED. To fix this:
1. READ the error message carefully for exact example syntax
2. EXTRACT the example capability tag shown in the error
3. USE THAT EXACT SYNTAX with corrected parameters
4. DO NOT retry with the same missing/incorrect parameters
5. If same capability fails 2+ times, try a DIFFERENT approach

⚠️ CRITICAL: If you see "Missing required parameters", the error message shows you EXACTLY how to fix it. Copy that syntax.
`
        : '';

      // Fetch autonomous mode base prompt from DB (with fallback)
      const autonomousModeBase =
        (await promptManager.getPrompt('PROMPT_AUTONOMOUS_MODE'))?.content ||
        "You are Coach Artie in AUTONOMOUS DEEP EXPLORATION MODE.\n\nYour goal is to thoroughly explore and research the user's request using available capabilities.\n\nIMPORTANT RULES:\n- Think step-by-step about what information you need\n- Use capabilities to gather information systematically\n- If you encounter errors, learn from them and adjust your approach\n- Build on what you've learned in previous steps\n- When you have enough information, synthesize it into a comprehensive response\n\nBe thorough, curious, and persistent in your research.";

      const nextActionPrompt = `${progressIndicator} ${autonomousModeBase}

CONVERSATION HISTORY:
${contextSummary}
${actionGuidance}${errorRecoveryPrompt}
SYSTEM REQUIREMENTS:
${!canStop ? `❗ MINIMUM DEPTH NOT REACHED: You MUST continue exploring. Cannot provide final answer until step ${minDepth}.` : `✓ Sufficient depth reached. May continue OR provide final synthesis.`}

EXPLORATION STRATEGY:
- When you see a list/index → pick 3-5 interesting items and examine each one individually
- Got suggested next actions? → Execute the first 2-3 automatically
- After examining items → look for patterns, dig into anomalies, examine edge cases
- Think: "What would a thorough analyst do?" then do that

CONTINUE BY:
${suggestedActions.length > 0 ? `Using these exact capability tags:\n${suggestedActions.slice(0, 3).join('\n')}` : 'Identifying what data you need next and calling the appropriate capability'}

${!canStop ? 'Execute the next capability now.' : 'Execute next capability OR provide final synthesis if exploration is truly complete.'}`;

      // Get base capability instructions for available tools
      const baseInstructions = await promptManager.getCapabilityInstructions(
        'Continue the conversation'
      );

      // Use Context Alchemy to build the message chain
      const { messages } = await contextAlchemy.buildMessageChain(
        nextActionPrompt,
        context.userId,
        baseInstructions
      );

      const nextAction = await openRouterService.generateFromMessageChain(
        messages,
        context.userId,
        `${context.messageId}_next_action_${context.currentStep}`
      );

      // SECURITY: Apply sanitization to prevent information disclosure
      const sanitizedAction = llmResponseCoordinator.stripThinkingTags(
        nextAction,
        context.userId,
        context.messageId
      );

      return sanitizedAction;
    } catch (_error) {
      logger.error('❌ Failed to get LLM next action:', _error);
      return ''; // Empty response will end the loop
    }
  }
}

export const llmLoopService = LLMLoopService.getInstance();
