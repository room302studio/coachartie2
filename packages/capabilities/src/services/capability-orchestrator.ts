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
import { llmLoopService } from './llm-loop-service.js';

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
        async (ctx, originalMsg) => { await capabilityExecutor.attemptErrorRecovery(ctx, originalMsg); },
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
        await capabilityExecutor.attemptErrorRecovery(context, message.message);
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
