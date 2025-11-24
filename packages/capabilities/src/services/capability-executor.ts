import { logger } from '@coachartie/shared';
import { capabilityRegistry } from './capability-registry.js';
import { wolframService } from './wolfram.js';
import { schedulerService } from './scheduler.js';
import { robustExecutor } from '../utils/robust-capability-executor.js';
import { getErrorMessage } from '../utils/error-utils.js';
import { openRouterService } from './openrouter.js';
import { contextAlchemy } from './context-alchemy.js';
import { capabilityParser } from './capability-parser.js';
import { GlobalVariableStore } from '../capabilities/variable-store.js';
import {
  ExtractedCapability,
  CapabilityResult,
  OrchestrationContext,
} from '../types/orchestration-types.js';

// =====================================================
// CAPABILITY EXECUTION ENGINE (THE CHAIN/LOOP)
// =====================================================

// Callback types for dependencies the executor needs from orchestrator
export type ExtractCapabilitiesCallback = (response: string, modelName?: string) => ExtractedCapability[];
export type GetIntermediateResponseCallback = (
  context: OrchestrationContext,
  capability: ExtractedCapability,
  result: CapabilityResult,
  currentStep: number,
  totalSteps: number
) => Promise<string>;
export type GenerateHelpfulErrorCallback = (capability: ExtractedCapability, errorMessage: string) => string;
export type AttemptErrorRecoveryCallback = (context: OrchestrationContext, originalMessage: string) => Promise<void>;
export type GenerateFinalSummaryCallback = (context: OrchestrationContext) => Promise<string>;

/**
 * Capability Execution Engine
 * Handles the execution chain/loop for capabilities
 */
export class CapabilityExecutor {
  private static instance: CapabilityExecutor;

  static getInstance(): CapabilityExecutor {
    if (!CapabilityExecutor.instance) {
      CapabilityExecutor.instance = new CapabilityExecutor();
    }
    return CapabilityExecutor.instance;
  }

  /**
   * Execute capability chain with streaming support
   * This is "the loop" - processes capabilities one at a time with LLM interaction
   */
  async executeCapabilityChainWithStreaming(
    context: OrchestrationContext,
    onPartialResponse: ((partial: string) => void) | undefined,
    extractCapabilities: ExtractCapabilitiesCallback,
    getIntermediateResponse: GetIntermediateResponseCallback,
    attemptErrorRecovery: AttemptErrorRecoveryCallback,
    generateFinalSummary: GenerateFinalSummaryCallback
  ): Promise<string | null> {
    if (!onPartialResponse || context.capabilities.length === 0) {
      return null; // Fall back to old method
    }

    logger.info(
      `🔄 Starting streaming capability chain with ${context.capabilities.length} initial capabilities`
    );

    // Process capabilities one at a time with LLM interaction
    let capabilityIndex = 0;
    while (capabilityIndex < context.capabilities.length) {
      const capability = context.capabilities[capabilityIndex];

      try {
        // Execute this capability
        logger.info(
          `🔧 Executing capability ${capabilityIndex + 1}/${context.capabilities.length}: ${capability.name}:${capability.action}`
        );

        const processedCapability = await this.substituteTemplateVariables(capability, context.results);
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
          const globalStore = GlobalVariableStore.getInstance();
          await globalStore.set(String(outputVar), result.data, `Auto-stored from ${capability.name}:${capability.action}`);
          logger.info(`📦 Auto-stored result to global variable: ${outputVar}`);
        }

        // SMART COST CONTROL: Intermediate responses enable natural chaining but cost 1 LLM call per capability
        // Skip intermediate responses when they won't add value:
        const isLastCapability = capabilityIndex + 1 === context.capabilities.length;
        const capabilityType = capability.name.split(':')[0];
        const isWriteOperation = ['memory', 'variable', 'goal', 'todo'].includes(capabilityType);
        const isSingleCapability = context.capabilities.length === 1;

        // Skip when: last in chain, write operation, or single capability (no chaining opportunity)
        const skipIntermediate = isLastCapability || isWriteOperation || isSingleCapability;

        const enableIntermediateResponses =
          process.env.ENABLE_INTERMEDIATE_RESPONSES === 'true' && !skipIntermediate;

        if (skipIntermediate && process.env.ENABLE_INTERMEDIATE_RESPONSES === 'true') {
          logger.info(
            `⚡ Skipping intermediate response for ${capability.name} (${isLastCapability ? 'last' : isWriteOperation ? 'write-op' : 'single'}) - cost savings`
          );
        }

        if (enableIntermediateResponses) {
          // Ask LLM to respond to this specific capability result
          const intermediateResponse = await getIntermediateResponse(
            context,
            capability,
            result,
            capabilityIndex + 1,
            context.capabilities.length
          );

          // Stream this intermediate response
          if (intermediateResponse && intermediateResponse.trim()) {
            logger.info(
              `📡 Streaming intermediate response for ${capability.name}: "${intermediateResponse.substring(0, 100)}..."`
            );
            onPartialResponse(intermediateResponse);

            // Check if this intermediate response contains NEW capabilities
            const newCapabilities = extractCapabilities(intermediateResponse);
            if (newCapabilities.length > 0) {
              logger.info(
                `🔍 Found ${newCapabilities.length} capabilities from intermediate response - validating...`
              );

              // CRITICAL FIX: Only add capabilities that are complete and valid
              // Don't add capabilities extracted from streaming/partial responses
              const validCapabilities = newCapabilities.filter((cap) => {
                // Check if capability looks complete (has required params or content)
                const registeredCap = capabilityRegistry.list().find((c) => c.name === cap.name);
                if (!registeredCap) {
                  logger.warn(`⚠️ Skipping unknown capability from intermediate: ${cap.name}`);
                  return false;
                }

                // Check if required params are present
                const hasRequiredParams =
                  !registeredCap.requiredParams ||
                  registeredCap.requiredParams.length === 0 ||
                  registeredCap.requiredParams.every(
                    (param) => cap.params[param] || (cap.content && cap.content.trim())
                  );

                if (!hasRequiredParams) {
                  logger.warn(
                    `⚠️ Skipping incomplete capability from intermediate: ${cap.name}:${cap.action} (missing required params or content)`
                  );
                  return false;
                }

                return true;
              });

              if (validCapabilities.length > 0) {
                logger.info(
                  `✅ Adding ${validCapabilities.length} VALID capabilities from intermediate response`
                );
                validCapabilities.forEach((cap, index) => {
                  cap.priority = context.capabilities.length + index;
                  context.capabilities.push(cap);
                });
              } else {
                logger.warn(
                  `⚠️ No valid capabilities found in intermediate response (all were incomplete/invalid)`
                );
              }
            }
          }
        } else {
          // Just stream the capability result directly without LLM processing
          const resultSummary = result.success
            ? `✅ ${capability.name}:${capability.action} completed`
            : `❌ ${capability.name}:${capability.action} failed: ${result.error}`;
          onPartialResponse(resultSummary);
        }
      } catch (_error) {
        logger.error(`❌ Capability ${capability.name}:${capability.action} failed:`, _error);

        context.results.push({
          capability,
          success: false,
          error: getErrorMessage(_error),
          timestamp: new Date().toISOString(),
        });
        context.currentStep++;
      }

      capabilityIndex++;
    }

    // NEW: Error Recovery Loop for streaming - Ask LLM to self-correct failed capabilities
    const failedCount = context.results.filter((r) => !r.success).length;
    if (failedCount > 0) {
      logger.info(
        `🔄 ${failedCount} capabilities failed in streaming, attempting error recovery...`
      );
      await attemptErrorRecovery(context, context.originalMessage);
    }

    // Generate final summary response
    logger.info(
      `🎯 All ${context.capabilities.length} capabilities executed, generating final summary`
    );
    const finalSummary = await generateFinalSummary(context);

    return finalSummary;
  }

  /**
   * Execute capability chain without streaming (batch mode)
   * Classic "execute all capabilities and return results"
   */
  async executeCapabilityChain(context: OrchestrationContext): Promise<void> {
    for (const capability of context.capabilities) {
      // Apply template variable substitution using previous results
      const processedCapability = await this.substituteTemplateVariables(capability, context.results);

      try {
        logger.info(`🔧 Executing capability ${capability.name}:${capability.action}`);

        logger.info(
          `🔄 Template substitution: ${JSON.stringify(capability.content)} -> ${JSON.stringify(processedCapability.content)}`
        );

        // Use robust executor with retry logic for bulletproof capability execution
        const capabilityForRobustExecution = {
          name: processedCapability.name,
          action: processedCapability.action,
          content: processedCapability.content || '',
          params: processedCapability.params,
        };

        const robustResult = await robustExecutor.executeWithRetry(
          capabilityForRobustExecution,
          { userId: context.userId, messageId: context.messageId },
          3 // max retries
        );

        // Convert robust result to orchestrator format
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
          const globalStore = GlobalVariableStore.getInstance();
          await globalStore.set(String(outputVar), result.data, `Auto-stored from ${capability.name}:${capability.action}`);
          logger.info(`📦 Auto-stored result to global variable: ${outputVar}`);
        }

        logger.info(
          `✅ Capability ${capability.name}:${capability.action} ${
            result.success ? 'succeeded' : 'failed'
          }`
        );
      } catch (_error) {
        logger.error(`❌ Capability ${capability.name}:${capability.action} failed:`, _error);

        context.results.push({
          capability: processedCapability,
          success: false,
          error: getErrorMessage(_error),
          timestamp: new Date().toISOString(),
        });
        context.currentStep++;
      }
    }
  }

  /**
   * Perform template variable substitution on capability content and params
   * Enables capability chaining via {{result}}, {{result_1}}, etc.
   * ALSO substitutes global variables from the database
   */
  async substituteTemplateVariables(
    capability: ExtractedCapability,
    previousResults: CapabilityResult[]
  ): Promise<ExtractedCapability> {
    const globalStore = GlobalVariableStore.getInstance();

    // Create substitution map from previous results
    const substitutions = new Map<string, string>();

    // Add common template variables from previous results
    if (previousResults.length > 0) {
      const lastResult = previousResults[previousResults.length - 1];
      substitutions.set('result', String(lastResult.data || ''));
      substitutions.set('content', String(lastResult.data || ''));

      // Add indexed results (result_1, result_2, etc.)
      previousResults.forEach((result, index) => {
        substitutions.set(`result_${index + 1}`, String(result.data || ''));
      });

      // Special handling for memory results
      const memoryResults = previousResults.filter((r) => r.capability.name === 'memory');
      if (memoryResults.length > 0) {
        substitutions.set('memories', String(memoryResults[memoryResults.length - 1].data || ''));
      }
    }

    // Substitute in content (both local results AND global variables)
    let processedContent = capability.content;
    if (processedContent) {
      // First substitute local results
      for (const [key, value] of substitutions) {
        const pattern = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
        processedContent = processedContent.replace(pattern, value);
      }
      // Then substitute global variables from database
      processedContent = await globalStore.substitute(processedContent);
    }

    // Substitute in params (deep copy to avoid mutation)
    const processedParams = JSON.parse(JSON.stringify(capability.params));
    for (const [paramKey, paramValue] of Object.entries(processedParams)) {
      if (typeof paramValue === 'string') {
        // First substitute local results
        let processed = paramValue;
        for (const [key, value] of substitutions) {
          const pattern = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
          processed = processed.replace(pattern, value);
        }
        // Then substitute global variables
        processedParams[paramKey] = await globalStore.substitute(processed);
      }
    }

    return {
      ...capability,
      content: processedContent,
      params: processedParams,
    };
  }

  /**
   * Execute a single capability using the capability registry
   * This is the core execution primitive
   */
  async executeCapability(
    capability: ExtractedCapability,
    context: OrchestrationContext | undefined,
    generateHelpfulError: GenerateHelpfulErrorCallback
  ): Promise<CapabilityResult> {
    const result: CapabilityResult = {
      capability,
      success: false,
      timestamp: new Date().toISOString(),
    };

    // Get userId for use in both registry and legacy handlers
    const userId = context ? context.userId : 'unknown-user';

    try {
      // Inject userId and messageId into params for capabilities that need context
      const paramsWithContext = ['scheduler', 'memory'].includes(capability.name)
        ? {
            ...capability.params,
            userId,
            messageId: context?.messageId,
          }
        : capability.name === 'meeting-scheduler'
          ? {
              ...capability.params,
              discord_context: context?.discord_context,
            }
          : capability.params;

      // Debug: log what we're passing to the registry
      logger.info(
        `🔍 Executor executing: name=${capability.name}, action=${capability.action}, params=${JSON.stringify(paramsWithContext)}, content="${capability.content}"`
      );

      // Use the capability registry to execute the capability
      result.data = await capabilityRegistry.execute(
        capability.name,
        capability.action,
        paramsWithContext,
        capability.content
      );
      result.success = true;
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      // Generate helpful error message with suggestions
      const helpfulError = generateHelpfulError(capability, errorMessage);
      result.error = helpfulError;
      result.success = false;

    }

    return result;
  }

  /**
   * CRITICAL FIX: Error Recovery Loop - Ask LLM to self-correct failed capabilities
   * This implements the architecture improvement the user requested:
   * "send better errors back to the LLM so it could have fixed it itself"
   */
  async attemptErrorRecovery(
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
          const result = await this.executeCapability(
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

}

export const capabilityExecutor = CapabilityExecutor.getInstance();
