import { logger, IncomingMessage } from '@coachartie/shared';
import { capabilityRegistry } from './capability-registry.js';
import { getErrorMessage, getErrorStack } from '../../utils/error-utils.js';

// Import new modular services
import { emailDraftingService } from '../external/email-drafting-service.js';
import { llmResponseCoordinator } from '../llm/llm-response-coordinator.js';
import { capabilityBootstrap } from './capability-bootstrap.js';
import { memoryOrchestration } from '../memory/memory-orchestration.js';
import { llmLoopService } from '../llm/llm-loop-service.js';

// Import shared types
import { OrchestrationContext } from '../../types/orchestration-types.js';

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
    const emailIntent = await emailDraftingService.detectEmailIntent(
      message.message,
      message.userId
    );
    if (emailIntent) {
      logger.info('📧 EMAIL INTENT DETECTED - Routing to email writing mode');
      return await emailDraftingService.handleEmailWritingMode(
        message,
        emailIntent,
        onPartialResponse
      );
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

    // Get initial LLM response
    logger.info(`🤖 Getting initial LLM response for loop decision`);

    const initialLLMResponse = await llmResponseCoordinator.getLLMResponseWithCapabilities(
      message,
      undefined // Don't stream initial response - we'll stream from the loop
    );

    // Extract the bot's loop decision from the response
    const { response: llmResponse, wantsLoop } =
      llmResponseCoordinator.extractLoopDecision(initialLLMResponse);

    logger.info(`🎯 Bot loop decision: ${wantsLoop ? '✅ WANTS LOOP' : '❌ NO LOOP NEEDED'}`);

    // If the bot doesn't want to loop, return the response directly
    if (!wantsLoop) {
      logger.info(`🏁 Returning response directly - bot decided loop not needed`);
      if (onPartialResponse) {
        onPartialResponse(llmResponse);
      }
      await this.storeReflectionMemory(context, message, llmResponse);
      this.contexts.delete(message.id);
      return llmResponse;
    }

    // Bot wants to iterate - enter the ReAct loop
    logger.info(`🎯 Entering ReAct execution loop - bot requested iteration`);

    // The llmLoopService.executeLLMDrivenLoop will:
    // 1. Let the LLM see the initial response
    // 2. Let the LLM decide what tools to use next
    // 3. Execute tools autonomously
    // 4. Re-reason about results
    // 5. Continue until LLM decides it's done
    try {
      const finalResponse = await llmLoopService.executeLLMDrivenLoop(
        context,
        llmResponse,
        onPartialResponse
      );

      logger.info(`✅ ReAct loop completed successfully`);
      await this.storeReflectionMemory(context, message, finalResponse);
      this.contexts.delete(message.id);
      return finalResponse;
    } catch (loopError) {
      logger.warn(
        `⚠️ ReAct loop encountered error, falling back to direct LLM response: ${getErrorMessage(loopError)}`
      );
      // Fallback: Return the LLM response if loop fails
      await this.storeReflectionMemory(context, message, llmResponse);
      this.contexts.delete(message.id);
      return llmResponse;
    }
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

    // Check for credit/billing errors
    if (
      errorMessage.includes('OUT OF CREDITS') ||
      errorMessage.includes('credit') ||
      errorMessage.includes('402')
    ) {
      return `💳 **OpenRouter Credits Exhausted**

I'm unable to respond right now because the API credits have run out.

**To fix this:**
Add more credits at https://openrouter.ai/settings/credits

*Message ID: ${message.id}*`;
    }

    // Check for rate limiting
    if (errorMessage.includes('RATE LIMITED') || errorMessage.includes('429')) {
      return `⏱️ **Rate Limited**

Too many requests - please wait a moment and try again.

*Message ID: ${message.id}*`;
    }

    // Check for server errors
    if (errorMessage.includes('SERVER ERROR') || errorMessage.includes('50')) {
      return `🔧 **Service Temporarily Unavailable**

The AI service is experiencing issues. Please try again in a few minutes.

*Message ID: ${message.id}*`;
    }

    // Check for auth errors
    if (
      errorMessage.includes('AUTH ERROR') ||
      errorMessage.includes('401') ||
      errorMessage.includes('403')
    ) {
      return `🔑 **Authentication Error**

There's an issue with the API configuration. Please check the API keys.

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
   * MCP client was removed - this now returns empty array
   */
  private getAvailableMCPTools(): Array<{ name: string; description?: string }> {
    return [];
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
