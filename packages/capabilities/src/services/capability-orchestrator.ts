import { logger, IncomingMessage } from '@coachartie/shared';
import { openRouterService } from './openrouter.js';
import { schedulerService } from './scheduler.js';
import { wolframService } from './wolfram.js';
import { promptManager } from './prompt-manager.js';
import { capabilityRegistry, RegisteredCapability } from './capability-registry.js';
import { calculatorCapability } from '../capabilities/calculator.js';
import { webCapability } from '../capabilities/web.js';
import { packageManagerCapability } from '../capabilities/package-manager.js';
import { filesystemCapability } from '../capabilities/filesystem.js';
import { environmentCapability } from '../capabilities/environment.js';
import { mcpClientCapability, mcpClientService } from '../capabilities/mcp-client.js';
import { mcpInstallerCapability } from '../capabilities/mcp-installer.js';
import { mcpAutoInstallerCapability } from '../capabilities/mcp-auto-installer.js';
import { systemInstallerCapability } from '../capabilities/system-installer.js';
import { memoryCapability } from '../capabilities/memory.js';
import { githubCapability } from '../capabilities/github.js';
import { creditStatusCapability } from '../capabilities/credit-status.js';
// import { linkedInCapability } from '../capabilities/linkedin.js'; // DELETED: LinkedIn OAuth not configured
import { goalCapability } from '../capabilities/goal.js';
import { variableStoreCapability } from '../capabilities/variable-store.js';
import { todoCapability } from '../capabilities/todo.js';
import { discordUICapability } from '../capabilities/discord-ui.js';
import { discordForumsCapability } from '../capabilities/discord-forums.js';
import { mentionProxyCapability } from '../capabilities/mention-proxy.js';
// import { CapabilitySuggester } from "../utils/capability-suggester.js"; // Removed during refactoring
import { capabilityXMLParser } from '../utils/xml-parser.js';
import { conscienceLLM } from './conscience.js';
import { bulletproofExtractor } from '../utils/bulletproof-capability-extractor.js';
import { robustExecutor } from '../utils/robust-capability-executor.js';
import { modelAwarePrompter } from '../utils/model-aware-prompter.js';
import { contextAlchemy } from './context-alchemy.js';
import { securityMonitor } from './security-monitor.js';

// Define capability extraction types
interface ExtractedCapability {
  name: string;
  action: string;
  params: Record<string, unknown>;
  content?: string;
  priority: number;
}

interface CapabilityResult {
  capability: ExtractedCapability;
  success: boolean;
  data?: unknown;
  error?: string;
  timestamp: string;
}

interface OrchestrationContext {
  messageId: string;
  userId: string;
  originalMessage: string;
  source: string;
  capabilities: ExtractedCapability[];
  results: CapabilityResult[];
  currentStep: number;
  respondTo: IncomingMessage['respondTo'];
  capabilityFailureCount: Map<string, number>; // Circuit breaker: track failures per capability
}

interface EmailDraft {
  id: string;
  userId: string;
  to: string;
  subject: string;
  body: string;
  originalRequest: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  status: 'draft' | 'approved' | 'sent' | 'cancelled';
}

export class CapabilityOrchestrator {
  private contexts = new Map<string, OrchestrationContext>();
  private emailDrafts = new Map<string, EmailDraft>(); // userId -> current draft
  // private capabilitySuggester: CapabilitySuggester; // Removed during refactoring

  constructor() {
    // Initialize the capability registry with existing capabilities
    this.initializeCapabilityRegistry();

    // Initialize the capability suggester - Removed during refactoring
    // this.capabilitySuggester = new CapabilitySuggester(capabilityRegistry.list());
  }

  /**
   * Initialize the capability registry with existing capability handlers
   * This bridges the gap between legacy hardcoded capabilities and the new registry system
   */
  private initializeCapabilityRegistry(): void {
    logger.info('🔧 Initializing capability registry with existing capabilities');

    try {
      // Register calculator capability from external file
      logger.info('📦 Registering calculator...');
      capabilityRegistry.register(calculatorCapability);

      // Register web capability from external file
      capabilityRegistry.register(webCapability);

      // Register package manager capability from external file
      capabilityRegistry.register(packageManagerCapability);

      // Register filesystem capability from external file
      capabilityRegistry.register(filesystemCapability);

      // Register environment capability from external file
      capabilityRegistry.register(environmentCapability);

      // Register MCP client capability from external file
      capabilityRegistry.register(mcpClientCapability);

      // Register MCP installer capability from external file
      capabilityRegistry.register(mcpInstallerCapability);

      // Register MCP auto-installer capability from external file
      capabilityRegistry.register(mcpAutoInstallerCapability);

      // Register system installer capability for dependency management
      capabilityRegistry.register(systemInstallerCapability);

      // Register real memory capability with persistence
      capabilityRegistry.register(memoryCapability);

      // Register GitHub capability for deployment celebrations
      capabilityRegistry.register(githubCapability);

      // Register credit status capability for monitoring API usage
      capabilityRegistry.register(creditStatusCapability);

      // Register LinkedIn capability - DELETED: OAuth not configured
      // capabilityRegistry.register(linkedInCapability);

      // Register goal capability
      capabilityRegistry.register(goalCapability);

      // Register variable store capability
      capabilityRegistry.register(variableStoreCapability);

      // Register todo capability
      capabilityRegistry.register(todoCapability);

      // Register Discord UI capability for interactive components
      logger.info('📦 Registering discord-ui...');
      capabilityRegistry.register(discordUICapability);

      // Register Discord Forums capability for forum traversal and GitHub sync
      logger.info('📦 Registering discord-forums...');
      capabilityRegistry.register(discordForumsCapability);
      logger.info('✅ discord-forums registered successfully');

      // Register Mention Proxy capability for user representation
      logger.info('📦 Registering mention-proxy...');
      capabilityRegistry.register(mentionProxyCapability);
      logger.info('✅ mention-proxy registered successfully');

      // Register wolfram capability
      capabilityRegistry.register({
        name: 'wolfram',
        supportedActions: ['query', 'search'],
        description: 'Queries Wolfram Alpha for computational knowledge',
        requiredParams: ['input'],
        handler: async (params, content) => {
          const input = params.input || params.query || content;
          if (!input) {
            throw new Error('No input provided for Wolfram Alpha query');
          }

          try {
            const result = await wolframService.query(input);
            return result;
          } catch (error) {
            logger.error('Wolfram Alpha capability failed:', error);
            throw error;
          }
        },
      });

      // Register scheduler capability
      capabilityRegistry.register({
        name: 'scheduler',
        supportedActions: ['remind', 'schedule', 'list', 'cancel'],
        description: 'Set one-time reminders (e.g., "remind me in 5 minutes"), schedule recurring tasks with cron expressions, view scheduled tasks, or cancel scheduled reminders. Perfect for time-based automation and remembering things.',
        handler: async (params, _content) => {
          const { action } = params;

          switch (action) {
            case 'remind': {
              const { message, delay, userId } = params;
              if (!message) {
                throw new Error('Reminder message is required');
              }

              const delayMs = parseInt(String(delay)) || 60000; // Default 1 minute
              const reminderName = `reminder-${Date.now()}`;

              await schedulerService.scheduleOnce(
                reminderName,
                {
                  type: 'user-reminder',
                  message,
                  userId: userId || 'unknown-user',
                  reminderType: 'one-time',
                },
                delayMs
              );

              const delayMinutes = Math.round(delayMs / 60000);
              return `✅ Reminder set: "${message}" in ${delayMinutes} minute${delayMinutes !== 1 ? 's' : ''}`;
            }

            case 'schedule': {
              const { name, cron, message, userId } = params;
              if (!name || !cron) {
                throw new Error('Task name and cron expression are required');
              }

              const taskId = `task-${Date.now()}`;

              await schedulerService.scheduleTask({
                id: taskId,
                name,
                cron,
                data: {
                  type: 'user-task',
                  message: message || `Scheduled task: ${name}`,
                  userId: userId || 'unknown-user',
                },
              });

              return `✅ Recurring task scheduled: "${name}" (${cron})`;
            }

            case 'list': {
              const tasks = await schedulerService.getScheduledTasks();

              if (tasks.length === 0) {
                return '📋 No scheduled tasks found';
              }

              const taskList = tasks
                .map((task) => `• ${task.name} - Next: ${task.nextRun.toLocaleString()}`)
                .join('\n');

              return `📋 Scheduled tasks (${tasks.length}):\n${taskList}`;
            }

            case 'cancel': {
              const { taskId } = params;
              if (!taskId) {
                throw new Error('Task ID is required for cancellation');
              }

              await schedulerService.removeTask(taskId);
              return `✅ Task "${taskId}" cancelled successfully`;
            }

            default:
              throw new Error(`Unknown scheduler action: ${action}`);
          }
        },
      });

      const totalCaps = capabilityRegistry.list().length;
      logger.info(
        `✅ Capability registry initialized successfully: ${totalCaps} capabilities registered`
      );
      logger.info(
        `📋 Registered: ${capabilityRegistry
          .list()
          .map((c) => c.name)
          .join(', ')}`
      );
    } catch (_error) {
      logger.error('❌ Failed to initialize capability registry:', _error);
      logger.error('Stack:', _error);
      // Don't throw - allow service to continue with legacy handlers
    }
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
    const activeDraft = this.emailDrafts.get(message.userId);
    if (activeDraft && activeDraft.status === 'draft') {
      const draftResponse = this.detectDraftResponse(message.message);
      if (draftResponse) {
        logger.info(`📧 DRAFT RESPONSE DETECTED: ${draftResponse.action}`);
        return await this.handleDraftResponse(message, activeDraft, draftResponse, onPartialResponse);
      }
    }

    // Check if this is an email request
    const emailIntent = await this.detectEmailIntent(message.message, message.userId);
    if (emailIntent) {
      logger.info('📧 EMAIL INTENT DETECTED - Routing to email writing mode');
      return await this.handleEmailWritingMode(message, emailIntent, onPartialResponse);
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

    const llmResponse = await this.getLLMResponseWithCapabilities(message, onPartialResponse);
    await this.extractCapabilitiesFromUserAndLLM(context, message, llmResponse);
    await this.reviewCapabilitiesWithConscience(context, message);

    // Stream the initial LLM response
    if (onPartialResponse) {
      const cleanResponse = this.stripThinkingTags(llmResponse, context.userId, context.messageId);
      if (cleanResponse.trim()) {
        onPartialResponse(cleanResponse);
      }
    }

    // EXECUTE CAPABILITIES WITH STREAMING - natural loop via LLM seeing results
    if (context.capabilities.length > 0 && onPartialResponse) {
      logger.info(
        `🔄 STARTING STREAMING CAPABILITY CHAIN - LLM will naturally continue based on results`
      );
      const finalResponse = await this.executeCapabilityChainWithStreaming(
        context,
        onPartialResponse
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
      await this.executeCapabilityChain(context);

      // NEW: Error Recovery Loop - Ask LLM to self-correct failed capabilities
      // This implements the user's feedback: "send better errors back to the LLM so it could have fixed it itself"
      const failedCount = context.results.filter((r) => !r.success).length;
      if (failedCount > 0) {
        logger.info(`🔄 ${failedCount} capabilities failed, attempting error recovery...`);
        await this.attemptErrorRecovery(context, message.message);
      }
    }

    // Generate final response from capability results
    const finalResponse = await this.generateFinalResponse(context, llmResponse);
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
    };
  }

  /**
   * Gospel Method: Extract capabilities from both user message and LLM response
   */
  private async extractCapabilitiesFromUserAndLLM(
    context: OrchestrationContext,
    message: IncomingMessage,
    llmResponse: string
  ): Promise<void> {
    logger.info(`🔍 Extracting capabilities from user and LLM responses`);

    const currentModel = openRouterService.getCurrentModel();
    logger.info(`🔍 EXTRACTING WITH MODEL CONTEXT: ${currentModel}`);

    logger.info(`🔍 EXTRACTING FROM USER MESSAGE: "${message.message}"`);
    const userCapabilities = this.extractCapabilities(message.message, currentModel);

    logger.info(`🔍 EXTRACTING FROM LLM RESPONSE: "${llmResponse.substring(0, 200)}..."`);
    const llmCapabilities = this.extractCapabilities(llmResponse, currentModel);

    // Combine capabilities, with user-provided ones taking priority
    const allCapabilities = [...userCapabilities, ...llmCapabilities];

    if (userCapabilities.length > 0) {
      logger.info(`🎯 Found ${userCapabilities.length} explicit capabilities from user message`);
    }
    if (llmCapabilities.length > 0) {
      logger.info(`🤖 Found ${llmCapabilities.length} capabilities from LLM response`);
    }

    // Store in context for conscience review
    context.capabilities = allCapabilities;
  }

  /**
   * Gospel Method: Review capabilities with conscience for safety
   */
  private async reviewCapabilitiesWithConscience(
    context: OrchestrationContext,
    message: IncomingMessage
  ): Promise<void> {
    if (context.capabilities.length === 0) {
      return;
    }

    logger.info(`🧠 Reviewing ${context.capabilities.length} capabilities with conscience`);

    const reviewedCapabilities = [];
    let conscienceResponse = '';

    for (const capability of context.capabilities) {
      logger.info(`🧠 Conscience reviewing: ${capability.name}:${capability.action}`);

      const review = await conscienceLLM.review(message.message, {
        name: capability.name,
        action: capability.action,
        params: capability.params,
      });

      // If conscience approved, keep the original capability
      if (review.includes('APPROVED:')) {
        reviewedCapabilities.push(capability);
      } else {
        // If not approved, extract any modified capabilities from review
        const approvedCapabilities = this.extractCapabilities(review);
        reviewedCapabilities.push(...approvedCapabilities);
      }

      conscienceResponse += review + '\n';
    }

    // Update context with reviewed capabilities
    const originalCount = context.capabilities.length;
    context.capabilities = reviewedCapabilities;

    if (reviewedCapabilities.length !== originalCount) {
      logger.info(
        `🧠 Conscience modified capabilities: ${originalCount} → ${reviewedCapabilities.length}`
      );
    }

    // Store conscience response for potential fallback
    (context as any).conscienceResponse = conscienceResponse;
  }

  /**
   * Gospel Method: Handle auto-injection flow when no capabilities detected
   */
  private async handleAutoInjectionFlow(
    context: OrchestrationContext,
    message: IncomingMessage,
    llmResponse: string
  ): Promise<string | null> {
    logger.info(`📝 No capabilities detected, checking for auto-injection opportunities`);

    const currentModel = openRouterService.getCurrentModel();
    logger.info(`🎯 AUTO-INJECT: Using bulletproof auto-injection for model: ${currentModel}`);

    const bulletproofAutoCapabilities = bulletproofExtractor.detectAutoInjectCapabilities(
      message.message,
      llmResponse
    );
    const autoInjectedCapabilities = bulletproofAutoCapabilities.map((cap, index) => ({
      name: cap.name,
      action: cap.action,
      params: cap.params,
      content: cap.content,
      priority: index,
    }));

    if (autoInjectedCapabilities.length > 0) {
      logger.info(
        `🎯 Auto-injected ${autoInjectedCapabilities.length} capabilities: ${autoInjectedCapabilities.map((c) => `${c.name}:${c.action}`).join(', ')}`
      );
      context.capabilities = autoInjectedCapabilities;

      await this.executeCapabilityChain(context);
      return await this.generateFinalResponse(context, llmResponse);
    }

    logger.info(`📝 No auto-injection opportunities found`);
    return null; // No auto-injection possible
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
      await this.autoStoreReflectionMemory(context, message, finalResponse);
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
    return `🚨 ORCHESTRATION FAILURE DEBUG 🚨
Message ID: ${message.id}
User ID: ${message.userId}
Original Message: "${message.message}"
Source: ${message.source}
Orchestration Error: ${error instanceof Error ? error.message : String(error)}
Stack: ${error instanceof Error ? error.stack : 'No stack trace'}
Capabilities Found: ${context.capabilities.length}
Capability Details: ${context.capabilities.map((c) => `${c.name}:${c.action}`).join(', ')}
Results Generated: ${context.results.length}
Result Details: ${context.results.map((r) => `${r.capability.name}:${r.success ? 'SUCCESS' : 'FAILED'}`).join(', ')}
Current Step: ${context.currentStep}
Registry Stats: ${capabilityRegistry.getStats().totalCapabilities} capabilities, ${capabilityRegistry.getStats().totalActions} actions
Timestamp: ${new Date().toISOString()}`;
  }

  /**
   * Get LLM response with capability instruction prompts
   * Dynamically generates instructions based on registered capabilities
   */
  private async getLLMResponseWithCapabilities(
    message: IncomingMessage,
    onPartialResponse?: (partial: string) => void
  ): Promise<string> {
    try {
      logger.info(`🚀 getLLMResponseWithCapabilities called for message: "${message.message}"`);

      // Get base capability instructions template
      const baseInstructions = await promptManager.getCapabilityInstructions(message.message);

      // Use Context Alchemy to build intelligent message chain
      logger.info('🧪 CONTEXT ALCHEMY: Building intelligent message chain');
      const { messages } = await contextAlchemy.buildMessageChain(
        message.message,
        message.userId,
        baseInstructions,
        undefined,
        { source: message.source }
      );

      // THREE-TIER STRATEGY: Use FAST_MODEL for capability extraction
      // Capability extraction is pattern matching - fast model saves time & cost
      const fastModel = openRouterService.selectFastModel();
      const modelAwareMessages = messages.map((msg) => {
        if (msg.role === 'system') {
          return {
            ...msg,
            content: modelAwarePrompter.generateCapabilityPrompt(fastModel, msg.content),
          };
        }
        return msg;
      });

      logger.info(
        `🎯 Using Context Alchemy with FAST_MODEL for capability extraction: ${fastModel} (${modelAwareMessages.length} messages)`
      );

      // Use streaming if callback provided, otherwise regular generation
      // Pass the fast model explicitly to ensure consistent model selection
      return onPartialResponse
        ? await openRouterService.generateFromMessageChainStreaming(
            modelAwareMessages,
            message.userId,
            onPartialResponse,
            message.id,
            fastModel
          )
        : await openRouterService.generateFromMessageChain(
            modelAwareMessages,
            message.userId,
            message.id,
            fastModel
          );
    } catch (_error) {
      logger.error('❌ Failed to get capability instructions from database', _error);
      throw new Error('System configuration error: capability instructions not available');
    }
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
   * Get relevant memory patterns for learning from past experiences
   */
  private async getRelevantMemoryPatterns(userMessage: string, userId: string): Promise<string[]> {
    try {
      logger.info(`🔍 Getting memory patterns for user ${userId}, message: "${userMessage}"`);

      // SECURITY FIX: Use user-specific memory instead of shared 'system' memory
      // This prevents parallel request contamination between users
      const memoryService = await import('../capabilities/memory.js');
      const service = memoryService.MemoryService.getInstance();

      // Search for USER-SPECIFIC capability usage patterns in memories
      const capabilityMemories = await service.recall(userId, 'capability usage patterns', 3);
      logger.info(
        `🗃️ Found user ${userId} capability memories: ${capabilityMemories ? capabilityMemories.substring(0, 100) : 'None'}...`
      );

      // Also search for any patterns related to current query type for THIS USER ONLY
      let queryTypeMemories = '';
      const lowerMessage = userMessage.toLowerCase();

      if (
        lowerMessage.includes('food') ||
        lowerMessage.includes('like') ||
        lowerMessage.includes('prefer')
      ) {
        queryTypeMemories = await service.recall(userId, 'food preferences memory search', 2);
      } else if (lowerMessage.match(/\d+.*[+\-*/].*\d+/)) {
        queryTypeMemories = await service.recall(userId, 'calculator math calculation', 2);
      } else if (
        lowerMessage.includes('what is') ||
        lowerMessage.includes('search') ||
        lowerMessage.includes('find')
      ) {
        queryTypeMemories = await service.recall(userId, 'web search latest recent', 2);
      }

      // Extract capability patterns from memory results
      const patterns: string[] = [];
      logger.info(
        `🧩 Processing capability memories: ${capabilityMemories ? capabilityMemories.length : 0} chars`
      );
      logger.info(
        `🧩 Processing query type memories: ${queryTypeMemories ? queryTypeMemories.length : 0} chars`
      );

      // Parse capability patterns from memory responses
      if (capabilityMemories && !capabilityMemories.includes('No memories found')) {
        logger.info(`✅ Found capability memories to process`);
        // Look for capability tags in the memory content
        const capabilityTags = capabilityXMLParser.findCapabilityTags(capabilityMemories);
        logger.info(`🔍 Found ${capabilityTags.length} capability matches`);

        if (capabilityTags.length > 0) {
          capabilityTags.forEach((tag) => {
            logger.info(`📝 Processing capability match: ${tag}`);
            patterns.push(`When similar queries arise, use: ${tag}`);
          });
        }
      }

      // Limit to top 3 most relevant patterns
      logger.info(
        `🎯 Returning ${patterns.length} memory patterns: ${patterns.map((p) => p.substring(0, 50)).join('; ')}`
      );
      return patterns.slice(0, 3);
    } catch (_error) {
      logger.error('❌ Failed to get memory patterns:', _error);
      return [];
    }
  }

  /**
   * Auto-store reflection memories about successful interactions
   */
  private async autoStoreReflectionMemory(
    context: OrchestrationContext,
    message: IncomingMessage,
    finalResponse: string
  ): Promise<void> {
    try {
      logger.info(`📝 Auto-storing reflection memory for interaction ${context.messageId}`);

      const memoryService = await import('../capabilities/memory.js');
      const service = memoryService.MemoryService.getInstance();

      // Create conversation summary for reflection
      const conversationText = `User: ${message.message}\nAssistant: ${finalResponse}`;

      // Store USER-SPECIFIC interaction reflection using PROMPT_REMEMBER
      // SECURITY FIX: Store reflection memories per user to prevent contamination
      const generalReflection = await this.generateReflection(
        conversationText,
        'general',
        context.userId
      );
      if (generalReflection && generalReflection !== '✨') {
        await service.remember(context.userId, generalReflection, 'reflection', 3);
        logger.info(`💾 Stored general reflection memory for user ${context.userId}`);
      }

      // If capabilities were used, store USER-SPECIFIC capability reflection
      // SECURITY FIX: Store capability reflections per user to prevent contamination
      if (context.capabilities.length > 0) {
        const capabilityContext = this.buildCapabilityContext(context);
        const capabilityReflection = await this.generateReflection(
          capabilityContext,
          'capability',
          context.userId
        );

        if (capabilityReflection && capabilityReflection !== '✨') {
          await service.remember(context.userId, capabilityReflection, 'capability-reflection', 4);
          logger.info(
            `🔧 Stored capability reflection memory for user ${context.userId} (${context.capabilities.length} capabilities)`
          );
        }
      }
    } catch (_error) {
      logger.error('❌ Failed to store reflection memory:', _error);
      // Don't throw - reflection failure shouldn't break the main flow
    }
  }

  /**
   * Generate reflection using existing prompts from CSV
   */
  private async generateReflection(
    contextText: string,
    type: 'general' | 'capability',
    userId: string
  ): Promise<string> {
    try {
      const reflectionPrompts = {
        general: `In the dialogue I just sent, identify and list the key details by following these guidelines:
- Remember any hard facts – numeric values, URLs, dates, variables, names, and keywords. 
- Remember any ongoing themes, ideas, or storylines that are emerging
- Remember users' objectives, reasons behind actions, and emotional state, as they are crucial to understanding context.
- Remember background details and specific user tendencies.
- Identify correlations between past memories for a deeper grasp of conversation nuances and personal user patterns.
- Note challenges and goals discussed. They indicate areas of interest and potential growth, providing direction for future suggestions.
- Evaluate if your response was the best it could be. Remember ways to refine future responses for maximum usefulness and improve your responses in the future.
- Objectivity is key. Always reply in the third person.
- Keep your responses short, under 2 paragraphs if possible
- Never include this instruction in your response.
- Never respond in the negative- if there are no hard facts, simply respond with "✨".`,

        capability: `In the dialogue I just sent, identify and list the key details by following these guidelines, only list those which apply:

- Remember the capability you used and the exact arguments you passed to it.
- If applicable, remember any errors that occurred and the exact error message.
- Reflect on any possible fixes or improvements to your approach or creative ways to use this capability in the future.
- Identify things learned about this capability that will make for easier usage next time`,
      };

      const prompt = `${reflectionPrompts[type]}\n\nDialogue:\n${contextText}`;

      // Use Context Alchemy for all LLM requests - SECURITY FIX: Use actual userId for reflection generation
      const { contextAlchemy } = await import('./context-alchemy.js');
      const { promptManager } = await import('./prompt-manager.js');

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
   */
  private buildCapabilityContext(context: OrchestrationContext): string {
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
   * Simple fallback detection - auto-inject obvious capabilities when LLM fails to use them
   * Based on CLAUDE.md requirements: "Keep it stupid simple"
   */
  private detectAndInjectCapabilities(
    _userMessage: string,
    _llmResponse: string
  ): ExtractedCapability[] {
    // No auto-injection for now - let the LLM handle it or user be explicit
    return [];
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
   * Generate helpful error messages with actionable suggestions
   */
  private generateHelpfulErrorMessage(
    capability: ExtractedCapability,
    originalError: string
  ): string {
    const { name, action } = capability;

    // Check if the capability exists
    if (!capabilityRegistry.has(name)) {
      const availableCapabilities = capabilityRegistry.list().map((cap) => cap.name);
      const suggestions = this.findSimilarCapabilities(name, availableCapabilities);

      return `❌ Capability '${name}' not found. Available capabilities: ${availableCapabilities.join(', ')}. Did you mean: ${suggestions.join(' or ')}?`;
    }

    // Check if the action is supported
    const registryCapability = capabilityRegistry.list().find((cap) => cap.name === name);
    if (registryCapability && !registryCapability.supportedActions.includes(action)) {
      const supportedActions = registryCapability.supportedActions.join(', ');
      const suggestions = this.findSimilarActions(action, registryCapability.supportedActions);

      return `❌ Capability '${name}' does not support action '${action}'. Supported actions: ${supportedActions}. Did you mean: ${suggestions.join(' or ')}?`;
    }

    // Check for missing required parameters
    if (registryCapability?.requiredParams?.length) {
      const missingParams = registryCapability.requiredParams.filter(
        (param) => !capability.params[param] && !capability.content
      );

      if (missingParams.length > 0) {
        return `❌ Missing required parameters for '${name}:${action}': ${missingParams.join(', ')}. Example: <capability name="${name}" action="${action}" ${missingParams.map((p) => `${p}="value"`).join(' ')}>content</capability>`;
      }
    }

    // Return enhanced original error with context
    return `❌ ${originalError}. For '${name}' capability, use: <capability name="${name}" action="${registryCapability?.supportedActions[0] || action}">content</capability>`;
  }

  /**
   * Find similar capability names using string similarity
   */
  private findSimilarCapabilities(target: string, available: string[]): string[] {
    return available
      .map((name) => ({ name, score: this.calculateSimilarity(target, name) }))
      .filter((item) => item.score > 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map((item) => item.name);
  }

  /**
   * Find similar action names using string similarity
   */
  private findSimilarActions(target: string, available: string[]): string[] {
    return available
      .map((action) => ({ action, score: this.calculateSimilarity(target, action) }))
      .filter((item) => item.score > 0.4)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map((item) => item.action);
  }

  /**
   * Simple string similarity calculation (Jaro-Winkler inspired)
   */
  private calculateSimilarity(a: string, b: string): number {
    if (a === b) {
      return 1.0;
    }
    if (a.length === 0 || b.length === 0) {
      return 0.0;
    }

    // Check for substring matches
    if (a.includes(b) || b.includes(a)) {
      return 0.8;
    }

    // Check for common substrings
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();

    if (aLower.includes(bLower) || bLower.includes(aLower)) {
      return 0.7;
    }

    // Check for similar starting characters
    let matchingChars = 0;
    const minLength = Math.min(a.length, b.length);

    for (let i = 0; i < minLength; i++) {
      if (aLower[i] === bLower[i]) {
        matchingChars++;
      } else {
        break;
      }
    }

    return matchingChars / Math.max(a.length, b.length);
  }


  /**
   * Extract capability XML tags from LLM response using fast-xml-parser
   */
  private extractCapabilities(response: string, modelName?: string): ExtractedCapability[] {
    try {
      // Try bulletproof extraction first (handles weak models)
      logger.info(
        `🔍 BULLETPROOF: Attempting extraction with model context: ${modelName || 'unknown'}`
      );
      const bulletproofCapabilities = bulletproofExtractor.extractCapabilities(response, modelName);

      if (bulletproofCapabilities.length > 0) {
        logger.info(
          `🎯 BULLETPROOF: Found ${bulletproofCapabilities.length} capabilities via bulletproof extractor`
        );

        // Convert to ExtractedCapability format
        const capabilities = bulletproofCapabilities.map((cap, index) => ({
          name: cap.name,
          action: cap.action,
          params: cap.params,
          content: cap.content,
          priority: index,
        }));

        return capabilities;
      }

      // Fallback to original XML parser
      logger.info(`🔧 FALLBACK: Trying original XML parser`);
      const parsedCapabilities = capabilityXMLParser.extractCapabilities(response);

      // Convert to ExtractedCapability format with priority
      const capabilities = parsedCapabilities.map((cap, index) => {
        logger.info(
          `🔍 MAPPING DEBUG: cap.name=${cap.name}, cap.params=${JSON.stringify(cap.params)}, cap.content="${cap.content}"`
        );
        return {
          name: cap.name,
          action: cap.action,
          params: cap.params,
          content: cap.content,
          priority: index,
        };
      });

      logger.info(`Extracted ${capabilities.length} capabilities from response via XML parser`);
      return capabilities;
    } catch (error) {
      logger.error('Error extracting capabilities:', error);
      return [];
    }
  }

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
    const maxIterations = 24; // Accommodate 9 capabilities + error recovery + discovery
    const minIterations = 3; // Reduced from 5 to allow faster completion when appropriate

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
      const capabilities = this.extractCapabilities(nextAction);

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
          const cleanResponse = this.stripThinkingTags(
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
        const cleanResponse = this.stripThinkingTags(nextAction, context.userId, context.messageId);
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
            error: _error instanceof Error ? _error.message : String(_error),
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
   * Strip internal reasoning and structured output from LLM response to prevent information disclosure
   * SECURITY CRITICAL: This prevents exposure of system prompts, internal logic, and debug information
   */
  private stripThinkingTags(content: string, userId?: string, messageId?: string): string {
    // Just remove actual <thinking> tags, nothing else
    return content.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
  }

  /**
   * SYSTEM: Extract suggested next actions from capability results
   * Parses "Next Actions:" sections from capability responses
   * Works for ANY capability following CAPABILITY_RESPONSE_PATTERN.md
   */
  private extractSuggestedNextActions(results: CapabilityResult[]): string[] {
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
   * SYSTEM: Intelligently truncate conversation history to prevent context overflow
   * Keeps first 2 messages (user + initial response) + recent messages within token budget
   */
  private truncateConversationHistory(history: string[], maxTokens: number): string[] {
    // Strategy: Keep first 2 messages (user + initial response) + recent N messages
    const keepFirst = 2;

    // Estimate tokens (rough approximation: 4 chars per token)
    const estimateTokens = (text: string) => Math.ceil(text.length / 4);
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

  /**
   * Ask LLM what it should do next given the current context
   */
  private async getLLMNextAction(
    context: OrchestrationContext,
    conversationHistory: string[]
  ): Promise<string> {
    try {
      // CRITICAL: Truncate conversation history to prevent context overflow
      const truncatedHistory = this.truncateConversationHistory(
        conversationHistory,
        3000 // Max tokens for history (leaves room for prompt + response)
      );
      const contextSummary = truncatedHistory.join('\n');

      // SYSTEM: Extract suggested next actions from previous capability results
      const suggestedActions = this.extractSuggestedNextActions(context.results);
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
      const sanitizedAction = this.stripThinkingTags(nextAction, context.userId, context.messageId);

      return sanitizedAction;
    } catch (_error) {
      logger.error('❌ Failed to get LLM next action:', _error);
      return ''; // Empty response will end the loop
    }
  }

  /**
   * Execute capability chain with streaming intermediate responses (LEGACY - replaced by LLM-driven loop)
   */
  private async executeCapabilityChainWithStreaming(
    context: OrchestrationContext,
    onPartialResponse?: (partial: string) => void
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
        const isLastCapability = (capabilityIndex + 1) === context.capabilities.length;
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
          const intermediateResponse = await this.getLLMIntermediateResponse(
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
            const newCapabilities = this.extractCapabilities(intermediateResponse);
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
          error: _error instanceof Error ? _error.message : String(_error),
          timestamp: new Date().toISOString(),
        });
        context.currentStep++;
      }

      capabilityIndex++;
    }

    // NEW: Error Recovery Loop for streaming - Ask LLM to self-correct failed capabilities
    const failedCount = context.results.filter((r) => !r.success).length;
    if (failedCount > 0) {
      logger.info(`🔄 ${failedCount} capabilities failed in streaming, attempting error recovery...`);
      await this.attemptErrorRecovery(context, context.originalMessage);
    }

    // Generate final summary response
    logger.info(
      `🎯 All ${context.capabilities.length} capabilities executed, generating final summary`
    );
    const finalSummary = await this.generateFinalSummaryResponse(context);

    return finalSummary;
  }

  /**
   * Execute capability chain in order (legacy method for non-streaming)
   */
  private async executeCapabilityChain(context: OrchestrationContext): Promise<void> {
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
          error: _error instanceof Error ? _error.message : String(_error),
          timestamp: new Date().toISOString(),
        });
        context.currentStep++;
      }
    }
  }

  /**
   * Perform template variable substitution on capability content and params
   */
  private substituteTemplateVariables(
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
   */
  private async executeCapability(
    capability: ExtractedCapability,
    context?: OrchestrationContext
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
        : capability.params;

      // Debug: log what we're passing to the registry
      logger.info(
        `🔍 Orchestrator executing: name=${capability.name}, action=${capability.action}, params=${JSON.stringify(paramsWithContext)}, content="${capability.content}"`
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
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Generate helpful error message with suggestions
      const helpfulError = this.generateHelpfulErrorMessage(capability, errorMessage);
      result.error = helpfulError;
      result.success = false;

      // For backwards compatibility, fall back to legacy hardcoded handlers
      logger.warn(
        `Registry execution failed for ${capability.name}:${capability.action}, trying legacy handlers`
      );

      try {
        switch (capability.name) {
          case 'memory':
            result.data = await this.executeMemory(capability);
            result.success = true;
            result.error = undefined;
            break;

          case 'wolfram':
            result.data = await this.executeWolfram(capability);
            result.success = true;
            result.error = undefined;
            break;

          case 'scheduler':
            result.data = await this.executeScheduler(capability, userId);
            result.success = true;
            result.error = undefined;
            break;

          default:
            // Keep the original error from registry execution
            break;
        }
      } catch (_legacyError) {
        logger.error('Legacy handler also failed:', _legacyError);
        // Keep the original registry error
      }
    }

    return result;
  }

  /**
   * Basic memory capability
   */

  // This should also be abstracted out to its own file...
  private async executeMemory(capability: ExtractedCapability): Promise<string> {
    const action = capability.action;

    // CANCER REMOVED: Redirect to real memory capability
    if (action === 'remember' || action === 'recall') {
      throw new Error(
        `Use real memory capability instead: <capability name="memory" action="${action}" ${action === 'remember' ? 'content' : 'query'}="${capability.params.content || capability.params.query || capability.content}" />`
      );
    }

    throw new Error(`Unknown memory action: ${action}`);
  }

  /**
   * Wolfram Alpha capability
   */
  private async executeWolfram(capability: ExtractedCapability): Promise<string> {
    const input = capability.params.input || capability.params.query || capability.content;
    if (!input) {
      throw new Error('No input provided for Wolfram Alpha query');
    }

    try {
      const result = await wolframService.query(String(input));
      return result;
    } catch (_error) {
      logger.error('Wolfram Alpha capability failed:', _error);
      throw _error;
    }
  }

  /**
   * Execute scheduler capability
   */

  private async executeScheduler(capability: ExtractedCapability, userId: string): Promise<string> {
    const { action } = capability;

    switch (action) {
      case 'remind':
        return await this.executeSchedulerRemind(capability, userId);
      case 'schedule':
        return await this.executeSchedulerSchedule(capability, userId);
      case 'list':
        return await this.executeSchedulerList(capability);
      case 'cancel':
        return await this.executeSchedulerCancel(capability);
      default:
        throw new Error(`Unknown scheduler action: ${action}`);
    }
  }

  /**
   * Execute scheduler remind action
   */
  private async executeSchedulerRemind(
    capability: ExtractedCapability,
    userId: string
  ): Promise<string> {
    const { message, delay } = capability.params;

    if (!message) {
      throw new Error('Reminder message is required');
    }

    const delayMs = parseInt(String(delay)) || 60000; // Default 1 minute
    const reminderName = `reminder-${Date.now()}`;

    await schedulerService.scheduleOnce(
      reminderName,
      {
        type: 'user-reminder',
        message,
        userId,
        reminderType: 'one-time',
      },
      delayMs
    );

    const delayMinutes = Math.round(delayMs / 60000);
    return `✅ Reminder set: "${message}" in ${delayMinutes} minute${
      delayMinutes !== 1 ? 's' : ''
    }`;
  }

  /**
   * Execute scheduler schedule action
   */
  private async executeSchedulerSchedule(
    capability: ExtractedCapability,
    userId: string
  ): Promise<string> {
    const { name, cron, message } = capability.params;

    if (!name || !cron) {
      throw new Error('Task name and cron expression are required');
    }

    const taskId = `task-${Date.now()}`;

    await schedulerService.scheduleTask({
      id: taskId,
      name: String(name),
      cron: String(cron),
      data: {
        type: 'user-task',
        message: message || `Scheduled task: ${name}`,
        userId,
      },
    });

    return `✅ Recurring task scheduled: "${name}" (${cron})`;
  }

  /**
   * Execute scheduler list action
   */
  private async executeSchedulerList(_capability: ExtractedCapability): Promise<string> {
    const tasks = await schedulerService.getScheduledTasks();

    if (tasks.length === 0) {
      return '📋 No scheduled tasks found';
    }

    const taskList = tasks
      .map((task) => `• ${task.name} - Next: ${task.nextRun.toLocaleString()}`)
      .join('\n');

    return `📋 Scheduled tasks (${tasks.length}):\n${taskList}`;
  }

  /**
   * Execute scheduler cancel action
   */
  private async executeSchedulerCancel(capability: ExtractedCapability): Promise<string> {
    const { taskId } = capability.params;

    if (!taskId) {
      throw new Error('Task ID is required for cancellation');
    }

    await schedulerService.removeTask(String(taskId));

    return `✅ Task "${taskId}" cancelled successfully`;
  }

  /**
   * Generate intermediate response after executing a single capability
   */
  private async getLLMIntermediateResponse(
    context: OrchestrationContext,
    capability: ExtractedCapability,
    result: CapabilityResult,
    currentStep: number,
    totalSteps: number
  ): Promise<string> {
    try {
      // IMPORTANT: When there's an error, pass the FULL error message to the LLM
      // Don't ask it to summarize - errors often contain exact examples that should be used immediately
      const resultSummary = result.success ? `Success: ${result.data}` : `Error: ${result.error}`;

      const intermediatePrompt = result.success
        ? `You just executed a capability and got a result. Provide a brief, natural response about what happened, and if there are more steps, mention what you're doing next.

Original user message: "${context.originalMessage}"
Capability executed: ${capability.name}:${capability.action}
Result: ${resultSummary}
Progress: Step ${currentStep} of ${totalSteps}

Provide a brief, conversational update (1-2 sentences). If this was the last step, don't mention next steps.`
        : `You just executed a capability but it failed with an error. The error message contains helpful guidance - read it carefully and use any examples provided.

Original user message: "${context.originalMessage}"
Capability executed: ${capability.name}:${capability.action}

FULL ERROR MESSAGE (READ CAREFULLY - MAY CONTAIN EXACT EXAMPLES TO USE):
${result.error}

Progress: Step ${currentStep} of ${totalSteps}

If the error contains an example capability tag, extract it and use it immediately in your next response. If no example is provided, explain the error briefly and suggest what to try next.`;

      // Use Context Alchemy for intermediate response
      const { messages } = await contextAlchemy.buildMessageChain(
        intermediatePrompt,
        context.userId,
        "You are Coach Artie. When you see errors with examples, extract and use those examples immediately - don't just say there was an error."
      );

      const intermediateResponse = await openRouterService.generateFromMessageChain(
        messages,
        context.userId,
        `${context.messageId}_intermediate_${currentStep}`
      );

      // SECURITY: Apply sanitization to prevent information disclosure
      const sanitizedResponse = this.stripThinkingTags(
        intermediateResponse,
        context.userId,
        context.messageId
      );

      return sanitizedResponse;
    } catch (_error) {
      logger.error('❌ Failed to generate intermediate response:', _error);
      // Fallback to simple status message
      return result.success
        ? `✅ Completed ${capability.name} successfully!`
        : `❌ ${capability.name} encountered an error.`;
    }
  }

  /**
   * Generate final summary response after all capabilities are complete
   */
  private async generateFinalSummaryResponse(context: OrchestrationContext): Promise<string> {
    if (context.results.length === 0) {
      return 'Task completed!';
    }

    try {
      const summaryPrompt = `All tasks have been completed. Provide a brief, friendly summary of what was accomplished.

Original user request: "${context.originalMessage}"
Tasks completed: ${context.results.length}

Results summary:
${context.results
  .map((result, i) => {
    const status = result.success ? '✅' : '❌';
    const summary = result.success ? result.data : result.error;
    return `${i + 1}. ${status} ${result.capability.name}: ${summary}`;
  })
  .join('\n')}

Provide a concise, friendly summary (1-2 sentences) of what was accomplished overall.`;

      const { messages } = await contextAlchemy.buildMessageChain(
        summaryPrompt,
        context.userId,
        'You are Coach Artie providing a final summary after completing multiple tasks.',
        [],
        { includeCapabilities: false } // No capability instructions for summary - just plain text response
      );

      const finalSummary = await openRouterService.generateFromMessageChain(
        messages,
        context.userId,
        `${context.messageId}_final_summary`
      );

      // SECURITY: Apply sanitization to prevent information disclosure
      const sanitizedSummary = this.stripThinkingTags(
        finalSummary,
        context.userId,
        context.messageId
      );

      return sanitizedSummary;
    } catch (_error) {
      logger.error('❌ Failed to generate final summary:', _error);
      // Fallback to simple completion message
      const successCount = context.results.filter((r) => r.success).length;
      return `✅ Completed ${successCount}/${context.results.length} tasks successfully!`;
    }
  }

  /**
   * Generate final response incorporating capability results
   * Now sends capability results back to LLM for coherent response generation
   */
  private async generateFinalResponse(
    context: OrchestrationContext,
    originalLLMResponse: string
  ): Promise<string> {
    logger.info(`🎯 Generating final response with ${context.results.length} capability results`);

    // If no capabilities were executed, return original response
    if (context.results.length === 0) {
      return originalLLMResponse;
    }

    // Build capability results summary for LLM
    const capabilityResults = context.results
      .map((result) => {
        const capability = result.capability;
        if (result.success && result.data) {
          return `${capability.name}:${capability.action} → ${result.data}`;
        } else if (result.error) {
          return `${capability.name}:${capability.action} → Error: ${result.error}`;
        } else {
          return `${capability.name}:${capability.action} → No result`;
        }
      })
      .join('\n');

    try {
      // Use Context Alchemy for synthesis prompt and final response generation
      const { contextAlchemy } = await import('./context-alchemy.js');
      const finalPrompt = await contextAlchemy.generateCapabilitySynthesisPrompt(
        context.originalMessage,
        capabilityResults
      );
      const { promptManager } = await import('./prompt-manager.js');

      const baseSystemPrompt = await promptManager.getCapabilityInstructions(finalPrompt);
      const { messages } = await contextAlchemy.buildMessageChain(
        finalPrompt,
        context.userId,
        baseSystemPrompt
      );

      // THREE-TIER STRATEGY: Use SMART_MODEL for response synthesis
      // Quality matters most for user-facing final response
      const smartModel = openRouterService.selectSmartModel();
      logger.info(`🧠 Using SMART_MODEL for response synthesis: ${smartModel}`);

      const finalResponse = await openRouterService.generateFromMessageChain(
        messages,
        context.userId,
        context.messageId,
        smartModel
      );

      // SECURITY: Apply sanitization to prevent information disclosure
      const sanitizedResponse = this.stripThinkingTags(
        finalResponse,
        context.userId,
        context.messageId
      );

      logger.info(`✅ Final coherent response generated and sanitized successfully`);

      return sanitizedResponse;
    } catch (_error) {
      logger.error('❌ Failed to generate final coherent response, using fallback', _error);

      // Instead of showing raw capability results, provide a cleaner fallback
      if (context.results.length > 0) {
        const successfulResults = context.results.filter((r) => r.success);
        if (successfulResults.length > 0) {
          const results = successfulResults.map((r) => r.data).join(', ');
          return `I processed your request and found: ${results}. However, I had trouble generating a complete response.`;
        }
      }

      return `I apologize, but I encountered an error while processing your request. Please try again.`;
    }
  }

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
      const recoveredCapabilities = this.extractCapabilities(recoveryAttempt, fastModel);
      if (recoveredCapabilities.length > 0) {
        logger.info(
          `✅ LLM identified ${recoveredCapabilities.length} corrected capabilities to retry`
        );

        // Clear the failed capabilities and try again with corrected ones
        const newResults: CapabilityResult[] = [];
        for (const capability of recoveredCapabilities) {
          logger.info(`🔄 Retrying: ${capability.name}:${capability.action}`);
          const result = await this.executeCapability(capability, context);
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
        logger.info(`Response was likely a clarification request:\n${recoveryAttempt.substring(0, 300)}`);

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

  /**
   * Detect email intent from user message
   * Handles both explicit email addresses and "email me" patterns
   */
  private async detectEmailIntent(
    message: string,
    userId?: string
  ): Promise<{ to: string; subject?: string; about?: string } | null> {
    const lowerMessage = message.toLowerCase();

    // Pattern 1: "email me" - lookup user's linked email
    if (/\b(email|send)\s+(me|myself)\b/.test(lowerMessage) && userId) {
      try {
        // Use unified profile system
        const { UserProfileService } = await import('@coachartie/shared');
        const email = await UserProfileService.getAttribute(userId, 'email');

        if (email) {
          // Extract topic from "email me this later" or "email me about X"
          const aboutMatch = message.match(/about (.+?)(?:\.|$)/i);
          const thisMatch = message.match(/me\s+(this|that)\s+(.+?)(?:\.|$)/i);

          return {
            to: email,
            about: aboutMatch?.[1] || thisMatch?.[2]
          };
        } else {
          // User hasn't linked email - could prompt them
          logger.info('User requested "email me" but has no linked email', { userId });
          return null;
        }
      } catch (error) {
        logger.error('Failed to lookup user email:', error);
        return null;
      }
    }

    // Pattern 2: Explicit email address
    const emailRegex = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/;
    const emailMatch = message.match(emailRegex);

    if (!emailMatch) return null;

    // Must have action verb BEFORE the email address (not just "is my email")
    const emailAddress = emailMatch[0];
    const emailIndex = message.indexOf(emailAddress);
    const textBeforeEmail = message.substring(0, emailIndex).toLowerCase();

    // Check for action verbs before the email
    const hasActionVerb =
      /\b(email|send|write|compose|draft)\b/.test(textBeforeEmail) ||
      /\b(send|write).*(to|an email)/.test(textBeforeEmail);

    // Exclude patterns like "my email is" or "email is"
    const isDeclarative = /\b(my email|email)\s+(is|:)\s*$/.test(textBeforeEmail.trim());

    if (hasActionVerb && !isDeclarative) {
      const to = emailAddress;

      // Try to extract subject/topic
      const aboutMatch = message.match(/about (.+?)(?:\.|$)/i);
      const askingMatch = message.match(/asking (?:about )?(.+?)(?:\.|$)/i);

      return {
        to,
        about: aboutMatch?.[1] || askingMatch?.[1]
      };
    }

    return null;
  }

  /**
   * Handle email writing mode - creates initial draft
   */
  private async handleEmailWritingMode(
    message: IncomingMessage,
    emailIntent: { to: string; subject?: string; about?: string },
    onPartialResponse?: (partial: string) => void
  ): Promise<string> {
    logger.info(`📧 EMAIL WRITING MODE: to=${emailIntent.to}, about="${emailIntent.about}"`);

    try {
      // 1. Draft the email using Claude Sonnet (SMART_MODEL)
      if (onPartialResponse) {
        onPartialResponse(`📧 Drafting email to ${emailIntent.to}...\n\n`);
      }

      const draftPrompt = `Write a professional email to ${emailIntent.to}${emailIntent.about ? ` about ${emailIntent.about}` : ''}.

User's request: "${message.message}"

Guidelines:
- Professional but friendly tone
- Clear subject line
- Concise body (2-3 paragraphs max)
- Include appropriate greeting and sign-off
- Sign as "Coach Artie" or appropriate based on context

Format your response using XML tags:
<email>
  <subject>Your subject line here</subject>
  <body>Your email body here</body>
</email>`;

      const { messages } = await contextAlchemy.buildMessageChain(
        draftPrompt,
        message.userId,
        'You are Coach Artie, an AI assistant helping draft professional emails.'
      );

      const smartModel = openRouterService.selectSmartModel();
      const draft = await openRouterService.generateFromMessageChain(
        messages,
        message.userId,
        `${message.id}_email_draft`,
        smartModel
      );

      // 2. Parse the draft using XML parser
      const { subject, body } = this.parseEmailDraft(draft, emailIntent.about || 'Follow-up');

      // 3. Store draft
      const emailDraft: EmailDraft = {
        id: `draft_${message.userId}_${Date.now()}`,
        userId: message.userId,
        to: emailIntent.to,
        subject,
        body,
        originalRequest: message.message,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'draft'
      };

      this.emailDrafts.set(message.userId, emailDraft);
      logger.info(`📝 Stored draft ${emailDraft.id} for user ${message.userId}`);

      // 4. Show draft and ask for approval
      return this.formatDraftDisplay(emailDraft);

    } catch (error) {
      logger.error('❌ Email writing mode failed:', error);
      return `❌ Failed to draft email: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  /**
   * Detect if user message is responding to a draft
   */
  private detectDraftResponse(message: string): { action: 'send' | 'edit' | 'cancel'; feedback?: string } | null {
    const lowerMessage = message.toLowerCase().trim();

    // Send actions
    if (['send it', 'send', 'yes', 'approve', 'looks good', 'lgtm', 'perfect'].some(phrase => lowerMessage === phrase || lowerMessage.startsWith(phrase))) {
      return { action: 'send' };
    }

    // Cancel actions
    if (['cancel', 'discard', 'no', 'nevermind', 'never mind'].some(phrase => lowerMessage === phrase || lowerMessage.startsWith(phrase))) {
      return { action: 'cancel' };
    }

    // Edit actions - capture feedback
    const editMatch = message.match(/^(?:edit|revise|change|update|fix|make it)\s+(.+)/i);
    if (editMatch) {
      return { action: 'edit', feedback: editMatch[1] };
    }

    // General feedback without "edit" keyword
    if (lowerMessage.includes('more') || lowerMessage.includes('less') ||
        lowerMessage.includes('shorter') || lowerMessage.includes('longer') ||
        lowerMessage.includes('formal') || lowerMessage.includes('casual')) {
      return { action: 'edit', feedback: message };
    }

    return null;
  }

  /**
   * Handle user response to draft (send, edit, cancel)
   */
  private async handleDraftResponse(
    message: IncomingMessage,
    draft: EmailDraft,
    response: { action: 'send' | 'edit' | 'cancel'; feedback?: string },
    onPartialResponse?: (partial: string) => void
  ): Promise<string> {
    logger.info(`📧 DRAFT RESPONSE: ${response.action} for draft ${draft.id}`);

    switch (response.action) {
      case 'send':
        return await this.handleSendDraft(draft, message, onPartialResponse);

      case 'edit':
        return await this.handleEditDraft(draft, response.feedback!, message, onPartialResponse);

      case 'cancel':
        this.emailDrafts.delete(message.userId);
        logger.info(`🗑️ Cancelled draft ${draft.id}`);
        return '✅ Draft cancelled. No email will be sent.';

      default:
        return 'I didn\'t understand that. Please reply with "send", "edit [changes]", or "cancel".';
    }
  }

  /**
   * Handle sending a draft - final confirmation flow
   */
  private async handleSendDraft(
    draft: EmailDraft,
    message: IncomingMessage,
    onPartialResponse?: (partial: string) => void
  ): Promise<string> {
    try {
      // Final confirmation step
      if (draft.status === 'draft') {
        draft.status = 'approved';
        draft.updatedAt = new Date();

        if (onPartialResponse) {
          onPartialResponse(`✅ Draft approved!\n\n📤 Sending email to ${draft.to}...\n\n`);
        }

        // Actually send the email using the email capability
        const { emailCapability } = await import('../capabilities/email.js');
        const result = await emailCapability.handler(
          {
            action: 'send',
            to: draft.to,
            subject: draft.subject,
            from: 'artie@coachartiebot.com'
          },
          draft.body
        );

        // Mark as sent and clean up
        draft.status = 'sent';
        this.emailDrafts.delete(message.userId);

        logger.info(`✅ Sent email ${draft.id} to ${draft.to}`);

        return `${result}\n\n📧 **Email sent successfully!**`;
      } else {
        return '❌ This draft has already been processed.';
      }

    } catch (error) {
      logger.error('❌ Failed to send email:', error);
      draft.status = 'draft'; // Reset to draft on failure
      return `❌ Failed to send email: ${error instanceof Error ? error.message : 'Unknown error'}\n\nDraft is still available. Reply "send" to try again or "edit" to revise.`;
    }
  }

  /**
   * Handle editing a draft with feedback
   */
  private async handleEditDraft(
    draft: EmailDraft,
    feedback: string,
    message: IncomingMessage,
    onPartialResponse?: (partial: string) => void
  ): Promise<string> {
    try {
      if (onPartialResponse) {
        onPartialResponse(`✏️ Revising draft based on your feedback...\n\n`);
      }

      // Re-draft with feedback
      const revisionPrompt = `Revise this email draft based on the user's feedback.

Original request: "${draft.originalRequest}"
Current draft subject: ${draft.subject}
Current draft body:
${draft.body}

User feedback: "${feedback}"

Please revise the email accordingly. Maintain professional tone unless feedback specifically requests otherwise.

Format your response using XML tags:
<email>
  <subject>Your revised subject line here</subject>
  <body>Your revised email body here</body>
</email>`;

      const { messages } = await contextAlchemy.buildMessageChain(
        revisionPrompt,
        message.userId,
        'You are Coach Artie, revising an email draft based on feedback.'
      );

      const smartModel = openRouterService.selectSmartModel();
      const revisedDraft = await openRouterService.generateFromMessageChain(
        messages,
        message.userId,
        `${draft.id}_revision_${draft.version + 1}`,
        smartModel
      );

      // Parse the revised draft using XML parser
      const { subject, body } = this.parseEmailDraft(revisedDraft, draft.subject);

      draft.subject = subject;
      draft.body = body;
      draft.version += 1;
      draft.updatedAt = new Date();

      logger.info(`✏️ Revised draft ${draft.id} to version ${draft.version}`);

      return this.formatDraftDisplay(draft, `✏️ **Draft revised** (version ${draft.version})\n\n`);

    } catch (error) {
      logger.error('❌ Failed to revise draft:', error);
      return `❌ Failed to revise draft: ${error instanceof Error ? error.message : 'Unknown error'}\n\nOriginal draft is still available.`;
    }
  }

  /**
   * Parse email draft from XML response
   */
  private parseEmailDraft(response: string, fallbackSubject: string): { subject: string; body: string } {
    try {
      // Use fast-xml-parser for proper XML parsing
      const { XMLParser } = require('fast-xml-parser');
      const parser = new XMLParser({
        ignoreAttributes: true,
        trimValues: true,
      });

      const parsed = parser.parse(response);

      if (parsed?.email?.subject && parsed?.email?.body) {
        return {
          subject: parsed.email.subject.trim(),
          body: parsed.email.body.trim()
        };
      }

      // Fallback: treat entire response as body
      logger.warn('⚠️ No valid XML email structure found, using fallback');
      return {
        subject: fallbackSubject,
        body: response.trim()
      };
    } catch (error) {
      logger.error('❌ Failed to parse email draft:', error);
      return {
        subject: fallbackSubject,
        body: response.trim()
      };
    }
  }

  /**
   * Format draft for display to user
   */
  private formatDraftDisplay(draft: EmailDraft, prefix: string = ''): string {
    return `${prefix}**📧 Draft Email** (v${draft.version})

**To:** ${draft.to}
**Subject:** ${draft.subject}

${draft.body}

---

**What's next?** Reply with:
- **"send"** → Send this email now
- **"edit [feedback]"** → Revise based on your notes
  Examples: "edit make it shorter", "edit more formal", "edit add meeting time"
- **"cancel"** → Discard this draft`;
  }
}

// Export singleton instance
export const capabilityOrchestrator = new CapabilityOrchestrator();
