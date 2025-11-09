import { logger, IncomingMessage, getDatabase } from '@coachartie/shared';
import { openRouterService } from './openrouter.js';
import { promptManager } from './prompt-manager.js';
import { capabilityRegistry } from './capability-registry.js';
import { mcpClientService } from '../capabilities/mcp-client.js';
import { capabilityXMLParser } from '../utils/xml-parser.js';
import { robustExecutor } from '../utils/robust-capability-executor.js';
import { contextAlchemy } from './context-alchemy.js';
import { securityMonitor } from './security-monitor.js';
import { getErrorMessage, getErrorStack } from '../utils/error-utils.js';

// Import new modular services
import { emailDraftingService } from './email-drafting-service.js';
import { capabilityExecutor } from './capability-executor.js';
import { llmResponseCoordinator } from './llm-response-coordinator.js';
import { capabilityParser } from './capability-parser.js';
import { capabilityBootstrap } from './capability-bootstrap.js';
import { memoryOrchestration } from './memory-orchestration.js';

// Import shared types
import {
  ExtractedCapability,
  CapabilityResult,
  OrchestrationContext,
} from '../types/orchestration-types.js';

export class CapabilityOrchestrator {
  private contexts = new Map<string, OrchestrationContext>();

  constructor() {
    // Initialize the capability registry with all capabilities
    capabilityBootstrap.initializeCapabilityRegistry();
  }

  /**
   * Main orchestration entry point - Gospel Methodology Implementation
   * Takes an incoming message and orchestrates the full capability pipeline
   */
  async orchestrateMessage(
    message: IncomingMessage,
    onPartialResponse?: (partial: string) => void
  ): Promise<string> {
    logger.info('🎯 ORCHESTRATOR START - This should always appear');
    logger.info(
      '🔥 ORCHESTRATOR ENTRY - About to create context and call assembleMessageOrchestration'
    );

    // Check if user has an active draft and is responding to it
    const activeDraft = emailDraftingService.getDraft(message.userId);
    if (activeDraft && activeDraft.status === 'draft') {
      const draftResponse = emailDraftingService.detectDraftResponse(message.message);
      if (draftResponse) {
        logger.info(`📧 DRAFT RESPONSE DETECTED: ${draftResponse.action}`);
        return await emailDraftingService.handleDraftResponse(
          message,
          activeDraft,
          draftResponse,
          onPartialResponse
        );
      }
    }

    // Check if this is an email request
    const emailIntent = await emailDraftingService.detectEmailIntent(message.message, message.userId);
    if (emailIntent) {
      logger.info('📧 EMAIL INTENT DETECTED - Routing to email writing mode');
      return await emailDraftingService.handleEmailWritingMode(message, emailIntent, onPartialResponse);
    }

    const context = this.createOrchestrationContext(message);
    this.contexts.set(message.id, context);

    try {
      logger.info(`🎬 Starting orchestration for message ${message.id}`);
      logger.info(`🔥 ABOUT TO CALL assembleMessageOrchestration for ${message.id}`);
      const result = await this.assembleMessageOrchestration(context, message, onPartialResponse);
      logger.info(`🔥 assembleMessageOrchestration COMPLETED for ${message.id}`);
      return result;
    } catch (error) {
      logger.error(`❌ Orchestration failed for message ${message.id}:`, error);
      this.contexts.delete(message.id);
      return this.generateOrchestrationFailureResponse(error, context, message);
    }
  }

  /**
   * Gospel Method: Assemble message orchestration pipeline
   * Crystal clear what each step does, easy to debug by commenting out steps
   */
  private async assembleMessageOrchestration(
    context: OrchestrationContext,
    message: IncomingMessage,
    onPartialResponse?: (partial: string) => void
  ): Promise<string> {
    logger.info(`⚡ ASSEMBLING MESSAGE ORCHESTRATION - ENTRY POINT REACHED!`);
    logger.info(`⚡ Assembling message orchestration for <${message.userId}> message`);

    // No pre-extraction - let the LLM decide what capabilities to use
    // Capability learnings will be loaded later if/when capabilities are actually executed
    const llmResponse = await llmResponseCoordinator.getLLMResponseWithCapabilities(
      message,
      onPartialResponse
    );
    await capabilityParser.extractCapabilitiesFromUserAndLLM(context, message, llmResponse);
    await capabilityParser.reviewCapabilitiesWithConscience(context, message);

    // Stream the initial LLM response
    if (onPartialResponse) {
      const cleanResponse = llmResponseCoordinator.stripThinkingTags(llmResponse, context.userId, context.messageId);
      if (cleanResponse.trim()) {
        onPartialResponse(cleanResponse);
      }
    }

    // EXECUTE CAPABILITIES WITH STREAMING - natural loop via LLM seeing results
    if (context.capabilities.length > 0 && onPartialResponse) {
      logger.info(
        `🔄 STARTING STREAMING CAPABILITY CHAIN - LLM will naturally continue based on results`
      );
      const finalResponse = await capabilityExecutor.executeCapabilityChainWithStreaming(
        context,
        onPartialResponse,
        (response: string, modelName?: string) => capabilityParser.extractCapabilities(response, modelName),
        (ctx, cap, result, currentStep, totalSteps) => llmResponseCoordinator.getLLMIntermediateResponse(ctx, cap, result, currentStep, totalSteps),
        async (ctx, originalMsg) => { await this.attemptErrorRecovery(ctx, originalMsg); },
        (ctx) => llmResponseCoordinator.generateFinalSummaryResponse(ctx)
      );
      if (finalResponse) {
        await this.storeReflectionMemory(context, message, finalResponse);
        this.contexts.delete(message.id);
        return finalResponse;
      }
    }

    // Fallback: execute capabilities without streaming (old path)
    if (context.capabilities.length > 0) {
      logger.info(`🔧 Executing ${context.capabilities.length} capabilities (non-streaming)`);
      await capabilityExecutor.executeCapabilityChain(context);

      // NEW: Error Recovery Loop - Ask LLM to self-correct failed capabilities
      // This implements the user's feedback: "send better errors back to the LLM so it could have fixed it itself"
      const failedCount = context.results.filter((r) => !r.success).length;
      if (failedCount > 0) {
        logger.info(`🔄 ${failedCount} capabilities failed, attempting error recovery...`);
        await this.attemptErrorRecovery(context, message.message);
      }
    }

    // Generate final response from capability results
    const finalResponse = await llmResponseCoordinator.generateFinalResponse(context, llmResponse);
    await this.storeReflectionMemory(context, message, finalResponse);

    this.contexts.delete(message.id);
    return finalResponse;
  }

  /**
   * Gospel Method: Create orchestration context
   */
  private createOrchestrationContext(message: IncomingMessage): OrchestrationContext {
    return {
      messageId: message.id,
      userId: message.userId,
      originalMessage: message.message,
      source: message.source,
      capabilities: [],
      results: [],
      currentStep: 0,
      respondTo: message.respondTo,
      capabilityFailureCount: new Map(), // Circuit breaker
      discord_context: message.context, // Pass through Discord context for mention resolution
    };
  }

  /**
   * Gospel Method: Store reflection memory about successful patterns
   */
  private async storeReflectionMemory(
    context: OrchestrationContext,
    message: IncomingMessage,
    finalResponse: string
  ): Promise<void> {
    // COST CONTROL: Automatic reflection is expensive (2 LLM calls per message)
    // Only enable if explicitly requested via environment variable
    const enableAutoReflection = process.env.ENABLE_AUTO_REFLECTION === 'true';

    if (!enableAutoReflection) {
      logger.info('⏭️  Skipping automatic reflection (disabled for cost control)');
      return;
    }

    try {
      await memoryOrchestration.autoStoreReflectionMemory(context, message, finalResponse);
    } catch (error) {
      logger.error('❌ Failed to store reflection memory (non-critical):', error);
      // Don't throw - reflection failure shouldn't break the main flow
    }
  }

  /**
   * Gospel Method: Generate orchestration failure response with full context
   */
  private generateOrchestrationFailureResponse(
    error: unknown,
    context: OrchestrationContext,
    message: IncomingMessage
  ): string {
    const errorMessage = getErrorMessage(error);

    // Check if this is a credit exhaustion error
    if (
      errorMessage.includes('credit') ||
      errorMessage.includes('OpenRouter credits exhausted')
    ) {
      return `💳 **OpenRouter Credits Exhausted**

I'm unable to respond right now because the API credits have run out.

**To fix this:**
Add more credits at https://openrouter.ai/settings/credits

*Message ID: ${message.id}*`;
    }

    // For other errors, provide debug information
    return `🚨 ORCHESTRATION FAILURE DEBUG 🚨
Message ID: ${message.id}
User ID: ${message.userId}
Original Message: "${message.message}"
Source: ${message.source}
Orchestration Error: ${errorMessage}
Stack: ${getErrorStack(error)}
Capabilities Found: ${context.capabilities.length}
Capability Details: ${context.capabilities.map((c) => `${c.name}:${c.action}`).join(', ')}
Results Generated: ${context.results.length}
Result Details: ${context.results.map((r) => `${r.capability.name}:${r.success ? 'SUCCESS' : 'FAILED'}`).join(', ')}
Current Step: ${context.currentStep}
Registry Stats: ${capabilityRegistry.getStats().totalCapabilities} capabilities, ${capabilityRegistry.getStats().totalActions} actions
Timestamp: ${new Date().toISOString()}`;
  }

  /**
   * Get available MCP tools from all connected servers
   */
  private getAvailableMCPTools(): Array<{ name: string; description?: string }> {
    try {
      // Get MCP client capability to access connected servers
      const mcpClient = capabilityRegistry.list().find((cap) => cap.name === 'mcp_client');
      if (!mcpClient) {
        return [];
      }

      const tools: Array<{ name: string; description?: string }> = [];

      // Get all connections (this is accessing private state, but needed for context)
      const connections = Array.from(
        (
          mcpClientService as unknown as { connections?: Map<string, unknown> }
        ).connections?.values() || []
      );

      for (const connection of connections) {
        const conn = connection as {
          connected?: boolean;
          tools?: Array<{ name: string; description?: string }>;
        };
        if (conn.connected && conn.tools) {
          for (const tool of conn.tools) {
            tools.push({
              name: tool.name,
              description: tool.description,
            });
          }
        }
      }

      return tools;
    } catch (_error) {
      logger.warn('Failed to get MCP tools for context:', _error);
      return [];
    }
  }

  /**
   * Extract search query for memory recall
   */
  private extractMemorySearchQuery(lowerMessage: string): string {
    // Extract key terms from the message for memory search
    const words = lowerMessage.split(/\s+/).filter((word) => word.length > 2);

    // Return the main content words for FTS search
    return words.join(' OR ');
  }

  /**
   * Detect web search queries (current events, lookups, etc.)
   */
  private isWebSearchQuery(lowerMessage: string): boolean {
    const webIndicators = [
      'latest news',
      'current',
      'recent',
      'search for',
      'look up',
      'find information about',
      'what happened',
      'tell me about',
      'news about',
    ];

    return webIndicators.some((indicator) => lowerMessage.includes(indicator));
  }

  /**
   * Extract search query for web search
   */

  /**
   * Extract mathematical expression from user message
   */

  /**
   * LLM-driven execution loop - let the LLM decide what to do next
   */
  private async executeLLMDrivenLoop(
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

        // Minimum depth reached, allow stopping
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
        const cleanResponse = llmResponseCoordinator.stripThinkingTags(nextAction, context.userId, context.messageId);
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

          const processedCapability = capabilityExecutor.substituteTemplateVariables(capability, context.results);
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

      const nextActionPrompt = `${progressIndicator} You are Coach Artie in AUTONOMOUS DEEP EXPLORATION MODE.

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
      const sanitizedAction = llmResponseCoordinator.stripThinkingTags(nextAction, context.userId, context.messageId);

      return sanitizedAction;
    } catch (_error) {
      logger.error('❌ Failed to get LLM next action:', _error);
      return ''; // Empty response will end the loop
    }
  }

  /**
   * Execute capability chain with streaming intermediate responses (LEGACY - replaced by LLM-driven loop)
   */

  /**
   * Execute capability chain in order (legacy method for non-streaming)
   */

  /**
   * CRITICAL FIX: Error Recovery Loop - Ask LLM to self-correct failed capabilities
   * This implements the architecture improvement the user requested:
   * "send better errors back to the LLM so it could have fixed it itself"
   */
  private async attemptErrorRecovery(
    context: OrchestrationContext,
    originalMessage: string,
    maxRetries: number = 2
  ): Promise<boolean> {
    // Check if there are any failed capabilities
    const failedResults = context.results.filter((r) => !r.success);
    if (failedResults.length === 0) {
      logger.info(`✅ No failed capabilities - error recovery not needed`);
      return true;
    }

    // Check retry count to prevent infinite loops
    if (!context.capabilityFailureCount.has('error_recovery_attempts')) {
      context.capabilityFailureCount.set('error_recovery_attempts', 0);
    }
    const recoveryAttempts = context.capabilityFailureCount.get('error_recovery_attempts') || 0;
    if (recoveryAttempts >= maxRetries) {
      logger.warn(
        `⚠️ Error recovery max retries (${maxRetries}) reached, giving up on error recovery`
      );
      return false;
    }

    logger.info(
      `🔄 ATTEMPTING ERROR RECOVERY (Attempt ${recoveryAttempts + 1}/${maxRetries}) for ${failedResults.length} failed capabilities`
    );

    // Build error summary for LLM
    const errorSummary = failedResults
      .map(
        (result) =>
          `❌ ${result.capability.name}:${result.capability.action}\n` +
          `   Parameters: ${JSON.stringify(result.capability.params)}\n` +
          `   Error: ${result.error}`
      )
      .join('\n\n');

    const recoveryPrompt = `🔧 ERROR RECOVERY MODE

You attempted to execute capabilities but ${failedResults.length} failed:

${errorSummary}

ORIGINAL USER REQUEST: "${originalMessage}"

WHAT TO DO:
1. Analyze why each capability failed (likely parameter issues, missing context, or format errors)
2. Consider what the user actually wanted to accomplish
3. Either:
   a) RETRY with corrected parameters (if you see how to fix it)
   b) ASK FOR CLARIFICATION (if you need more info from the user)

If you retry, use the exact XML capability format with corrected parameters:
<capability name="..." action="..." data='...' />

If asking for clarification, respond naturally without capability tags.

Remember: Parameter names might be camelCase or snake_case. Try both if unsure.`;

    try {
      // Use FAST_MODEL for quick error analysis
      const fastModel = openRouterService.selectFastModel();
      logger.info(`🧠 Using FAST_MODEL for error recovery: ${fastModel}`);

      // Build message chain for error recovery
      const { messages } = await contextAlchemy.buildMessageChain(
        recoveryPrompt,
        context.userId,
        'You are an intelligent error recovery system. Analyze capability failures and attempt to fix them or request clarification.'
      );

      // Get LLM's attempt to fix the errors
      const recoveryAttempt = await openRouterService.generateFromMessageChain(
        messages,
        context.userId,
        `${context.messageId}_recovery_${recoveryAttempts + 1}`,
        fastModel
      );

      logger.info(`🔍 LLM Recovery Attempt:\n${recoveryAttempt.substring(0, 500)}...`);

      // Check if LLM found corrected capabilities
      const recoveredCapabilities = capabilityParser.extractCapabilities(recoveryAttempt, fastModel);
      if (recoveredCapabilities.length > 0) {
        logger.info(
          `✅ LLM identified ${recoveredCapabilities.length} corrected capabilities to retry`
        );

        // Clear the failed capabilities and try again with corrected ones
        const newResults: CapabilityResult[] = [];
        for (const capability of recoveredCapabilities) {
          logger.info(`🔄 Retrying: ${capability.name}:${capability.action}`);
          const result = await capabilityExecutor.executeCapability(
            capability,
            context,
            (cap, error) => capabilityParser.generateHelpfulErrorMessage(cap, error)
          );
          newResults.push(result);

          if (!result.success) {
            logger.warn(`⚠️ Retry still failed: ${capability.name}:${capability.action}`);
          } else {
            logger.info(`✅ Retry succeeded: ${capability.name}:${capability.action}`);
          }
        }

        // Replace failed results with retry results
        context.results = context.results.filter((r) => r.success).concat(newResults);

        // Track recovery attempt
        context.capabilityFailureCount.set('error_recovery_attempts', recoveryAttempts + 1);

        // Check if all issues are now resolved
        const stillFailed = context.results.filter((r) => !r.success);
        if (stillFailed.length === 0) {
          logger.info(`🎉 ERROR RECOVERY SUCCESSFUL - All capabilities now working!`);
          return true;
        } else if (stillFailed.length < failedResults.length) {
          logger.info(
            `⚠️ Partial recovery: ${failedResults.length - stillFailed.length} fixed, ${stillFailed.length} still failing`
          );
          // Recursively attempt recovery again for remaining failures
          return await this.attemptErrorRecovery(context, originalMessage, maxRetries);
        } else {
          logger.warn(`❌ Error recovery did not improve the situation, attempting one more time`);
          // Try one more time with fresh perspective
          return await this.attemptErrorRecovery(context, originalMessage, maxRetries);
        }
      } else {
        logger.info(`ℹ️ LLM did not attempt to retry capabilities`);
        logger.info(
          `Response was likely a clarification request:\n${recoveryAttempt.substring(0, 300)}`
        );

        // If LLM asked for clarification instead, we should return that to the user
        // This will be included in the final response generation
        return false;
      }
    } catch (error) {
      logger.error('❌ Error recovery attempt failed:', error);
      context.capabilityFailureCount.set('error_recovery_attempts', recoveryAttempts + 1);
      return false;
    }
  }

  /**
   * Get orchestration context for a message (for debugging)
   */
  getContext(messageId: string): OrchestrationContext | undefined {
    return this.contexts.get(messageId);
  }

  /**
   * List active orchestrations (for monitoring)
   */
  getActiveOrchestrations(): string[] {
    return Array.from(this.contexts.keys());
  }
}

// Export singleton instance
export const capabilityOrchestrator = new CapabilityOrchestrator();
