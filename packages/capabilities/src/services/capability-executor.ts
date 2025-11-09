import { logger } from '@coachartie/shared';
import { capabilityRegistry } from './capability-registry.js';
import { wolframService } from './wolfram.js';
import { schedulerService } from './scheduler.js';
import { robustExecutor } from '../utils/robust-capability-executor.js';
import { getErrorMessage } from '../utils/error-utils.js';
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

        const processedCapability = this.substituteTemplateVariables(capability, context.results);
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
      const processedCapability = this.substituteTemplateVariables(capability, context.results);

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
   */
  substituteTemplateVariables(
    capability: ExtractedCapability,
    previousResults: CapabilityResult[]
  ): ExtractedCapability {
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

    // Substitute in content
    let processedContent = capability.content;
    if (processedContent) {
      for (const [key, value] of substitutions) {
        const pattern = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
        processedContent = processedContent.replace(pattern, value);
      }
    }

    // Substitute in params (deep copy to avoid mutation)
    const processedParams = JSON.parse(JSON.stringify(capability.params));
    for (const [paramKey, paramValue] of Object.entries(processedParams)) {
      if (typeof paramValue === 'string') {
        for (const [key, value] of substitutions) {
          const pattern = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
          processedParams[paramKey] = paramValue.replace(pattern, value);
        }
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

}

export const capabilityExecutor = CapabilityExecutor.getInstance();
