import { logger, IncomingMessage } from "@coachartie/shared";
import { openRouterService } from "./openrouter.js";
import { schedulerService } from "./scheduler.js";
import { wolframService } from "./wolfram.js";
import { promptManager } from "./prompt-manager.js";
import { capabilityRegistry, RegisteredCapability } from "./capability-registry.js";
import { calculatorCapability } from "../capabilities/calculator.js";
import { webCapability } from "../capabilities/web.js";
import { packageManagerCapability } from "../capabilities/package-manager.js";
import { filesystemCapability } from "../capabilities/filesystem.js";
import { environmentCapability } from "../capabilities/environment.js";
import { mcpClientCapability, mcpClientService } from "../capabilities/mcp-client.js";
import { mcpInstallerCapability } from "../capabilities/mcp-installer.js";
import { mcpAutoInstallerCapability } from "../capabilities/mcp-auto-installer.js";
import { systemInstallerCapability } from "../capabilities/system-installer.js";
import { memoryCapability } from "../capabilities/memory.js";
import { githubCapability } from "../capabilities/github.js";
import { deploymentCheerleaderCapability } from "../capabilities/deployment-cheerleader.js";
import { creditStatusCapability } from "../capabilities/credit-status.js";
import { linkedInCapability } from "../capabilities/linkedin.js";
import { goalCapability } from "../capabilities/goal.js";
import { variableStoreCapability } from "../capabilities/variable-store.js";
import { todoCapability } from "../capabilities/todo.js";
import { CapabilitySuggester } from "../utils/capability-suggester.js";
import { capabilityXMLParser } from "../utils/xml-parser.js";
import { conscienceLLM } from './conscience.js';
import { bulletproofExtractor } from "../utils/bulletproof-capability-extractor.js";
import { robustExecutor } from "../utils/robust-capability-executor.js";
import { modelAwarePrompter } from "../utils/model-aware-prompter.js";

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
  respondTo: IncomingMessage["respondTo"];
}

export class CapabilityOrchestrator {
  private contexts = new Map<string, OrchestrationContext>();
  private capabilitySuggester: CapabilitySuggester;

  constructor() {
    // Initialize the capability registry with existing capabilities
    this.initializeCapabilityRegistry();
    
    // Initialize the capability suggester
    this.capabilitySuggester = new CapabilitySuggester(capabilityRegistry.list());
  }

  /**
   * Initialize the capability registry with existing capability handlers
   * This bridges the gap between legacy hardcoded capabilities and the new registry system
   */
  private initializeCapabilityRegistry(): void {
    logger.info('🔧 Initializing capability registry with existing capabilities');

    try {
      // Register calculator capability from external file
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

      // Register deployment cheerleader capability
      capabilityRegistry.register(deploymentCheerleaderCapability);

      // Register credit status capability for monitoring API usage
      capabilityRegistry.register(creditStatusCapability);

      // Register LinkedIn capability
      capabilityRegistry.register(linkedInCapability);

      // Register goal capability
      capabilityRegistry.register(goalCapability);

      // Register variable store capability
      capabilityRegistry.register(variableStoreCapability);

      // Register todo capability
      capabilityRegistry.register(todoCapability);

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
        }
      });

      // Register scheduler capability
      capabilityRegistry.register({
        name: 'scheduler',
        supportedActions: ['remind', 'schedule', 'list', 'cancel'],
        description: 'Manages scheduled tasks and reminders',
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
        }
      });

      logger.info('✅ Capability registry initialized successfully');
    } catch (error) {
      logger.error('❌ Failed to initialize capability registry:', error);
      // Don't throw - allow service to continue with legacy handlers
    }
  }

  /**
   * Main orchestration entry point
   * Takes an incoming message and orchestrates the full capability pipeline
   */
  async orchestrateMessage(message: IncomingMessage): Promise<string> {
    logger.info("🎯 ORCHESTRATOR START - This should always appear");
    
    const context: OrchestrationContext = {
      messageId: message.id,
      userId: message.userId,
      originalMessage: message.message,
      source: message.source,
      capabilities: [],
      results: [],
      currentStep: 0,
      respondTo: message.respondTo,
    };

    this.contexts.set(message.id, context);

    try {
      logger.info(`🎬 Starting orchestration for message ${message.id}`);

      // Step 1: Get initial LLM response with capability instructions
      const llmResponse = await this.getLLMResponseWithCapabilities(message);
      logger.info(
        `🤖 LLM response received: ${llmResponse.substring(0, 100)}...`
      );

      // Step 2: Extract capabilities from both user message AND LLM response
      // Get current model name for model-aware extraction
      const currentModel = openRouterService.getCurrentModel();
      logger.info(`🔍 EXTRACTING WITH MODEL CONTEXT: ${currentModel}`);
      
      logger.info(`🔍 EXTRACTING FROM USER MESSAGE: "${message.message}"`);
      const userCapabilities = this.extractCapabilities(message.message, currentModel);
      logger.info(`🔍 EXTRACTING FROM LLM RESPONSE: "${llmResponse.substring(0, 200)}..."`);
      const llmCapabilities = this.extractCapabilities(llmResponse, currentModel);
      
      // Combine capabilities, with user-provided ones taking priority
      const capabilities = [...userCapabilities, ...llmCapabilities];
      
      if (userCapabilities.length > 0) {
        logger.info(`🎯 Found ${userCapabilities.length} explicit capabilities from user message`);
      }
      if (llmCapabilities.length > 0) {
        logger.info(`🤖 Found ${llmCapabilities.length} capabilities from LLM response`);
      }

      // Step 2.5: Conscience review for risky operations
      const reviewedCapabilities = [];
      let conscienceResponse = '';
      
      for (const capability of capabilities) {
        logger.info(`🧠 Conscience reviewing: ${capability.name}:${capability.action}`);
        
        const review = await conscienceLLM.review(message.message, {
          name: capability.name,
          action: capability.action,
          params: capability.params
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
      
      context.capabilities = reviewedCapabilities;
      
      if (reviewedCapabilities.length !== capabilities.length) {
        logger.info(`🧠 Conscience modified capabilities: ${capabilities.length} → ${reviewedCapabilities.length}`);
      }

      if (reviewedCapabilities.length === 0 && capabilities.length === 0) {
        logger.info(
          `📝 No capabilities detected, checking for auto-injection opportunities`
        );
        
        // Auto-inject capabilities using bulletproof detection
        const currentModel = openRouterService.getCurrentModel();
        logger.info(`🎯 AUTO-INJECT: Using bulletproof auto-injection for model: ${currentModel}`);
        
        const bulletproofAutoCapabilities = bulletproofExtractor.detectAutoInjectCapabilities(message.message, llmResponse);
        const autoInjectedCapabilities = bulletproofAutoCapabilities.map((cap, index) => ({
          name: cap.name,
          action: cap.action,
          params: cap.params,
          content: cap.content,
          priority: index
        }));
        
        if (autoInjectedCapabilities.length > 0) {
          logger.info(`🎯 Auto-injected ${autoInjectedCapabilities.length} capabilities: ${autoInjectedCapabilities.map(c => `${c.name}:${c.action}`).join(', ')}`);
          context.capabilities = autoInjectedCapabilities;
          
          // Execute the auto-injected capabilities
          await this.executeCapabilityChain(context);
          
          // Generate final response with capability results
          const finalResponse = await this.generateFinalResponse(context, llmResponse);
          return finalResponse;
        } else {
          logger.info(`📝 No auto-injection opportunities found, returning LLM response directly`);
          return llmResponse;
        }
      }

      // If conscience blocked capabilities but provided a response, return that
      if (reviewedCapabilities.length === 0 && capabilities.length > 0) {
        logger.info(`🧠 Conscience blocked all capabilities, returning conscience response`);
        return conscienceResponse.trim();
      }

      logger.info(
        `🔧 Found ${reviewedCapabilities.length} capabilities to execute: ${reviewedCapabilities
          .map((c) => `${c.name}:${c.action}`)
          .join(", ")}`
      );
      
      // Debug: Log first few characters of each capability's content/params
      capabilities.forEach((cap, i) => {
        const contentPreview = cap.content ? cap.content.substring(0, 50) + '...' : 'no content';
        const paramsPreview = Object.keys(cap.params).length > 0 ? JSON.stringify(cap.params).substring(0, 100) + '...' : 'no params';
        logger.info(`  ${i+1}. ${cap.name}:${cap.action} - Content: "${contentPreview}" - Params: ${paramsPreview}`);
      });

      // Step 3: Execute capabilities in order
      await this.executeCapabilityChain(context);

      // Step 4: Generate final response with capability results
      const finalResponse = await this.generateFinalResponse(
        context,
        llmResponse
      );

      // Step 5: Auto-store reflection memory about successful patterns
      await this.autoStoreReflectionMemory(context, message, finalResponse);

      this.contexts.delete(message.id);
      return finalResponse;
    } catch (error) {
      logger.error(`❌ Orchestration failed for message ${message.id}:`, error);
      this.contexts.delete(message.id);

      // Fallback to super verbose error instead of simple LLM response
      return `🚨 ORCHESTRATION FAILURE DEBUG 🚨
Message ID: ${message.id}
User ID: ${message.userId}
Original Message: "${message.message}"
Source: ${message.source}
Orchestration Error: ${error instanceof Error ? error.message : String(error)}
Stack: ${error instanceof Error ? error.stack : 'No stack trace'}
Capabilities Found: ${context.capabilities.length}
Capability Details: ${context.capabilities.map(c => `${c.name}:${c.action}`).join(', ')}
Results Generated: ${context.results.length}
Result Details: ${context.results.map(r => `${r.capability.name}:${r.success ? 'SUCCESS' : 'FAILED'}`).join(', ')}
Current Step: ${context.currentStep}
Registry Stats: ${capabilityRegistry.getStats().totalCapabilities} capabilities, ${capabilityRegistry.getStats().totalActions} actions
Timestamp: ${new Date().toISOString()}`;
    }
  }

  /**
   * Get LLM response with capability instruction prompts
   * Dynamically generates instructions based on registered capabilities
   */
  private async getLLMResponseWithCapabilities(
    message: IncomingMessage
  ): Promise<string> {
    try {
      logger.info(`🚀 getLLMResponseWithCapabilities called for message: "${message.message}"`);
      
      // Try to get from database first (force refresh to bypass cache)
      const prompt = await promptManager.getPrompt('capability_instructions', true);
      if (!prompt) {
        throw new Error('No capability instructions found in database');
      }
      
      // Get relevant past experiences from memory  
      logger.info("🧪 MEMORY INJECTION TEST - This line should always appear");
      const pastExperiences = await this.getRelevantMemoryPatterns(message.message, message.userId);
      
      // Include past experiences in the prompt
      let capabilityInstructions = prompt.content.replace(/\{\{USER_MESSAGE\}\}/g, message.message);
      
      if (pastExperiences.length > 0) {
        const experienceContext = pastExperiences.map(exp => `- ${exp}`).join('\n');
        capabilityInstructions = capabilityInstructions.replace(
          'You are Coach Artie,',
          `You are Coach Artie. Here are relevant past experiences that worked well:\n${experienceContext}\n\nYou are Coach Artie,`
        );
        logger.info(`🧠 Injected ${pastExperiences.length} past experiences into prompt`);
      }
      
      // Apply model-aware prompting for better capability generation
      const currentModel = openRouterService.getCurrentModel();
      const modelAwareInstructions = modelAwarePrompter.generateCapabilityPrompt(currentModel, capabilityInstructions);
      
      logger.info(`🎯 Using model-aware capability instructions for ${currentModel}`);
      
      return await openRouterService.generateResponse(
        modelAwareInstructions,
        message.userId,
        undefined,
        message.id
      );
    } catch (error) {
      logger.error('❌ Failed to get capability instructions from database, generating dynamic fallback', error);
      
      // Generate dynamic instructions based on registered capabilities
      const dynamicInstructions = this.generateDynamicCapabilityInstructions(message.message);
      
      // Apply model-aware prompting to fallback instructions too
      const currentModel = openRouterService.getCurrentModel();
      const modelAwareInstructions = modelAwarePrompter.generateCapabilityPrompt(currentModel, dynamicInstructions);
      
      logger.info(`🔄 Using model-aware fallback instructions for ${currentModel}`);
      
      return await openRouterService.generateResponse(
        modelAwareInstructions,
        message.userId,
        undefined,
        message.id
      );
    }
  }

  /**
   * Dynamically generate capability instructions based on what's registered
   */
  private generateDynamicCapabilityInstructions(userMessage: string): string {
    const capabilities = capabilityRegistry.list();
    
    // Check if we're using a free/smaller model
    const currentModel = openRouterService.getCurrentModel();
    const isFreeModel = currentModel?.includes('free') || currentModel?.includes('mini') || currentModel?.includes('3b');
    
    logger.info(`🔍 DEBUG - Current model: ${currentModel}, isFreeModel: ${isFreeModel}`);
    
    if (isFreeModel) {
      // Simpler, more direct prompt for free/smaller models
      return this.generateSimpleCapabilityInstructions(userMessage, capabilities);
    }
    
    // Full prompt for more capable models
    // Build capability descriptions
    const capabilityDocs = capabilities.map(cap => {
      const actions = cap.supportedActions.join(', ');
      const params = cap.requiredParams?.length ? ` (requires: ${cap.requiredParams.join(', ')})` : '';
      return `- ${cap.name}: ${cap.description || 'No description'}. Actions: ${actions}${params}`;
    }).join('\n');

    // Generate contextual examples based on the user's message
    this.generateContextualExamples(userMessage, capabilities);

    // Get available MCP tools
    const mcpTools = this.getAvailableMCPTools();
    const mcpExamples = mcpTools.length > 0 ? `
- Search Wikipedia: <search-wikipedia>search terms</search-wikipedia>
- Get Wikipedia article: <get-wikipedia-article limit="5">article title</get-wikipedia-article>
- Get current time: <get-current-time />` : '';

    return `You are Coach Artie, a helpful AI assistant. 

You have access to capabilities through simple XML tags when needed:
- Calculate: <calculate>2 + 2 * 5</calculate>
- Remember: <remember>I love Hawaiian pizza</remember>  
- Recall: <recall>pizza</recall> or <recall user="john">preferences</recall> or <recall auto />
- Web search: <web-search>latest AI news</web-search>${mcpExamples}

AVAILABLE CAPABILITIES:
${capabilityDocs}

${mcpTools.length > 0 ? `AVAILABLE MCP TOOLS:
${mcpTools.map(tool => `- ${tool.name}: ${tool.description || 'No description'}`).join('\n')}

IMPORTANT: Use simple syntax for all capabilities:
- Single word tags: <remember>content</remember>, <calculate>2+2</calculate>
- Kebab-case for MCP tools: <search-wikipedia>query</search-wikipedia>
- Optional attributes: <recall query="specific">general search</recall>
` : ''}

Use capabilities only when actually needed. Most conversations don't require them - respond naturally.

User's message: ${userMessage}`;
  }

  /**
   * Get available MCP tools from all connected servers
   */
  private getAvailableMCPTools(): Array<{name: string, description?: string}> {
    try {
      // Get MCP client capability to access connected servers
      const mcpClient = capabilityRegistry.list().find(cap => cap.name === 'mcp_client');
      if (!mcpClient) {
        return [];
      }

      const tools: Array<{name: string, description?: string}> = [];
      
      // Get all connections (this is accessing private state, but needed for context)
      const connections = Array.from((mcpClientService as unknown as { connections?: Map<string, unknown> }).connections?.values() || []);
      
      for (const connection of connections) {
        const conn = connection as { connected?: boolean; tools?: Array<{ name: string; description?: string }> };
        if (conn.connected && conn.tools) {
          for (const tool of conn.tools) {
            tools.push({
              name: tool.name,
              description: tool.description
            });
          }
        }
      }
      
      return tools;
    } catch (error) {
      logger.warn('Failed to get MCP tools for context:', error);
      return [];
    }
  }

  /**
   * Generate simpler instructions for free/smaller models with intelligent suggestions
   */
  private generateSimpleCapabilityInstructions(userMessage: string, _capabilities: RegisteredCapability[]): string {
    // Get available MCP tools for simple prompt too
    const mcpTools = this.getAvailableMCPTools();
    const mcpExamples = mcpTools.length > 0 ? `
- Search Wikipedia: <search-wikipedia>search terms</search-wikipedia>
- Get current time: <get-current-time />` : '';

    return `You are Coach Artie, a helpful AI assistant.

If you need to:
- Calculate something: <calculate>2 + 2</calculate>
- Remember information: <remember>info to store</remember>  
- Recall past information: <recall>search terms</recall>
- Search the web: <web-search>search terms</web-search>${mcpExamples}

${mcpTools.length > 0 ? `
Use simple tags for everything - much easier than complex XML!
` : ''}

Only use capability tags when you actually need to perform an action. Most conversations don't need capabilities - just respond naturally.

User: ${userMessage}`;
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
      logger.info(`🗃️ Found user ${userId} capability memories: ${capabilityMemories ? capabilityMemories.substring(0, 100) : 'None'}...`);
      
      // Also search for any patterns related to current query type for THIS USER ONLY
      let queryTypeMemories = '';
      const lowerMessage = userMessage.toLowerCase();
      
      if (lowerMessage.includes('food') || lowerMessage.includes('like') || lowerMessage.includes('prefer')) {
        queryTypeMemories = await service.recall(userId, 'food preferences memory search', 2);
      } else if (lowerMessage.match(/\d+.*[+\-*/].*\d+/)) {
        queryTypeMemories = await service.recall(userId, 'calculator math calculation', 2);
      } else if (lowerMessage.includes('what is') || lowerMessage.includes('search') || lowerMessage.includes('find')) {
        queryTypeMemories = await service.recall(userId, 'web search latest recent', 2);
      }
      
      // Extract capability patterns from memory results
      const patterns: string[] = [];
      logger.info(`🧩 Processing capability memories: ${capabilityMemories ? capabilityMemories.length : 0} chars`);
      logger.info(`🧩 Processing query type memories: ${queryTypeMemories ? queryTypeMemories.length : 0} chars`);
      
      // Parse capability patterns from memory responses
      if (capabilityMemories && !capabilityMemories.includes('No memories found')) {
        logger.info(`✅ Found capability memories to process`);
        // Look for capability tags in the memory content
        const capabilityTags = capabilityXMLParser.findCapabilityTags(capabilityMemories);
        logger.info(`🔍 Found ${capabilityTags.length} capability matches`);
        
        if (capabilityTags.length > 0) {
          capabilityTags.forEach(tag => {
            logger.info(`📝 Processing capability match: ${tag}`);
            patterns.push(`When similar queries arise, use: ${tag}`);
          });
        }
      }
      
      
      // Limit to top 3 most relevant patterns
      logger.info(`🎯 Returning ${patterns.length} memory patterns: ${patterns.map(p => p.substring(0, 50)).join('; ')}`);
      return patterns.slice(0, 3);
      
    } catch (error) {
      logger.error('❌ Failed to get memory patterns:', error);
      return [];
    }
  }

  /**
   * Auto-store reflection memories about successful interactions
   */
  private async autoStoreReflectionMemory(context: OrchestrationContext, message: IncomingMessage, finalResponse: string): Promise<void> {
    try {
      logger.info(`📝 Auto-storing reflection memory for interaction ${context.messageId}`);

      const memoryService = await import('../capabilities/memory.js');
      const service = memoryService.MemoryService.getInstance();

      // Create conversation summary for reflection
      const conversationText = `User: ${message.message}\nAssistant: ${finalResponse}`;
      
      // Store USER-SPECIFIC interaction reflection using PROMPT_REMEMBER
      // SECURITY FIX: Store reflection memories per user to prevent contamination
      const generalReflection = await this.generateReflection(conversationText, 'general', context.userId);
      if (generalReflection && generalReflection !== '✨') {
        await service.remember(context.userId, generalReflection, 'reflection', 3);
        logger.info(`💾 Stored general reflection memory for user ${context.userId}`);
      }

      // If capabilities were used, store USER-SPECIFIC capability reflection
      // SECURITY FIX: Store capability reflections per user to prevent contamination
      if (context.capabilities.length > 0) {
        const capabilityContext = this.buildCapabilityContext(context);
        const capabilityReflection = await this.generateReflection(capabilityContext, 'capability', context.userId);
        
        if (capabilityReflection && capabilityReflection !== '✨') {
          await service.remember(context.userId, capabilityReflection, 'capability-reflection', 4);
          logger.info(`🔧 Stored capability reflection memory for user ${context.userId} (${context.capabilities.length} capabilities)`);
        }
      }

    } catch (error) {
      logger.error('❌ Failed to store reflection memory:', error);
      // Don't throw - reflection failure shouldn't break the main flow
    }
  }

  /**
   * Generate reflection using existing prompts from CSV
   */
  private async generateReflection(contextText: string, type: 'general' | 'capability', userId: string): Promise<string> {
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
- Identify things learned about this capability that will make for easier usage next time`
      };

      const prompt = `${reflectionPrompts[type]}\n\nDialogue:\n${contextText}`;
      
      // SECURITY FIX: Use actual userId for reflection generation to prevent contamination
      const reflection = await openRouterService.generateResponse(prompt, userId);
      return reflection.trim();
      
    } catch (error) {
      logger.error(`❌ Failed to generate ${type} reflection:`, error);
      return '';
    }
  }

  /**
   * Build capability context for reflection
   */
  private buildCapabilityContext(context: OrchestrationContext): string {
    const capabilityDetails = context.capabilities.map((cap, i) => {
      const result = context.results[i];
      const status = result ? (result.success ? 'SUCCESS' : 'FAILED') : 'UNKNOWN';
      const data = result?.data ? ` - Result: ${JSON.stringify(result.data).substring(0, 100)}` : '';
      const error = result?.error ? ` - Error: ${result.error}` : '';
      
      return `Capability ${i + 1}: ${cap.name}:${cap.action}
Arguments: ${JSON.stringify(cap.params)}
Content: ${cap.content || 'none'}
Status: ${status}${data}${error}`;
    }).join('\n\n');

    return `User Message: ${context.originalMessage}
    
Capabilities Used:
${capabilityDetails}`;
  }


  /**
   * Simple fallback detection - auto-inject obvious capabilities when LLM fails to use them
   * Based on CLAUDE.md requirements: "Keep it stupid simple"
   */
  private detectAndInjectCapabilities(_userMessage: string, _llmResponse: string): ExtractedCapability[] {
    // No auto-injection for now - let the LLM handle it or user be explicit
    return [];
  }


  /**
   * Extract search query for memory recall
   */
  private extractMemorySearchQuery(lowerMessage: string): string {
    // Extract key terms from the message for memory search
    const words = lowerMessage.split(/\s+/).filter(word => word.length > 2);
    
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
      'news about'
    ];
    
    return webIndicators.some(indicator => lowerMessage.includes(indicator));
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
  private generateHelpfulErrorMessage(capability: ExtractedCapability, originalError: string): string {
    const { name, action } = capability;
    
    // Check if the capability exists
    if (!capabilityRegistry.has(name)) {
      const availableCapabilities = capabilityRegistry.list().map(cap => cap.name);
      const suggestions = this.findSimilarCapabilities(name, availableCapabilities);
      
      return `❌ Capability '${name}' not found. Available capabilities: ${availableCapabilities.join(', ')}. Did you mean: ${suggestions.join(' or ')}?`;
    }
    
    // Check if the action is supported
    const registryCapability = capabilityRegistry.list().find(cap => cap.name === name);
    if (registryCapability && !registryCapability.supportedActions.includes(action)) {
      const supportedActions = registryCapability.supportedActions.join(', ');
      const suggestions = this.findSimilarActions(action, registryCapability.supportedActions);
      
      return `❌ Capability '${name}' does not support action '${action}'. Supported actions: ${supportedActions}. Did you mean: ${suggestions.join(' or ')}?`;
    }
    
    // Check for missing required parameters
    if (registryCapability?.requiredParams?.length) {
      const missingParams = registryCapability.requiredParams.filter(param => 
        !capability.params[param] && !capability.content
      );
      
      if (missingParams.length > 0) {
        return `❌ Missing required parameters for '${name}:${action}': ${missingParams.join(', ')}. Example: <capability name="${name}" action="${action}" ${missingParams.map(p => `${p}="value"`).join(' ')}>content</capability>`;
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
      .map(name => ({ name, score: this.calculateSimilarity(target, name) }))
      .filter(item => item.score > 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map(item => item.name);
  }

  /**
   * Find similar action names using string similarity
   */
  private findSimilarActions(target: string, available: string[]): string[] {
    return available
      .map(action => ({ action, score: this.calculateSimilarity(target, action) }))
      .filter(item => item.score > 0.4)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map(item => item.action);
  }

  /**
   * Simple string similarity calculation (Jaro-Winkler inspired)
   */
  private calculateSimilarity(a: string, b: string): number {
    if (a === b) {return 1.0;}
    if (a.length === 0 || b.length === 0) {return 0.0;}
    
    // Check for substring matches
    if (a.includes(b) || b.includes(a)) {return 0.8;}
    
    // Check for common substrings
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();
    
    if (aLower.includes(bLower) || bLower.includes(aLower)) {return 0.7;}
    
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
   * Generate contextual examples based on user's message
   */
  private generateContextualExamples(userMessage: string, capabilities: RegisteredCapability[]): string {
    const examples: string[] = [];
    const lowerMessage = userMessage.toLowerCase();
    
    // Collect examples from capabilities that have them defined
    for (const cap of capabilities) {
      if (cap.examples && cap.examples.length > 0) {
        // Check if this capability is relevant to the user's message
        const isRelevant = this.isCapabilityRelevant(cap.name, lowerMessage);
        
        if (isRelevant || examples.length < 3) {
          // Add the first example from this capability
          examples.push(cap.examples[0]);
        }
      }
    }
    
    // If we don't have enough examples, generate some defaults
    if (examples.length < 3) {
      // Always include calculator example if available
      if (capabilityRegistry.has('calculator')) {
        examples.push('<capability name="calculator" action="calculate">25 * 4 + 10</capability>');
      }
      
      // Add other common examples based on available capabilities
      if (capabilityRegistry.has('web') && examples.length < 3) {
        examples.push('<capability name="web" action="search">latest news about AI</capability>');
      }
      
      if (capabilityRegistry.has('memory') && examples.length < 3) {
        examples.push('<capability name="memory" action="remember">important information</capability>');
      }
      
      if (capabilityRegistry.has('scheduler') && examples.length < 3) {
        examples.push('<capability name="scheduler" action="remind" delay="60000" message="Check task">Reminder</capability>');
      }
    }
    
    // Format examples with labels
    return examples.map((ex, i) => `Example ${i + 1}: ${ex}`).join('\n');
  }

  /**
   * Check if a capability is relevant to the user's message
   */
  private isCapabilityRelevant(capabilityName: string, lowerMessage: string): boolean {
    const relevanceMap: Record<string, string[]> = {
      calculator: ['calculate', 'math', 'add', 'subtract', 'multiply', 'divide', 'sum', 'times', 'plus', 'minus', 'equals'],
      web: ['search', 'find', 'look up', 'google', 'web', 'internet', 'online'],
      memory: ['remember', 'recall', 'note', 'save', 'store', 'memorize', 'forget'],
      scheduler: ['remind', 'schedule', 'later', 'tomorrow', 'alarm', 'timer', 'notification'],
      wolfram: ['wolfram', 'complex', 'scientific', 'integral', 'derivative', 'equation', 'physics'],
      filesystem: ['file', 'directory', 'folder', 'read', 'write', 'create', 'delete'],
      environment: ['env', 'environment', 'variable', 'config', 'setting'],
      package_manager: ['install', 'npm', 'package', 'dependency', 'module'],
      mcp_client: ['mcp', 'connect', 'tool', 'external'],
      mcp_installer: ['install mcp', 'setup mcp', 'configure mcp']
    };
    
    const keywords = relevanceMap[capabilityName] || [];
    return keywords.some(keyword => lowerMessage.includes(keyword));
  }

  /**
   * Extract capability XML tags from LLM response using fast-xml-parser
   */
  private extractCapabilities(response: string, modelName?: string): ExtractedCapability[] {
    try {
      // Try bulletproof extraction first (handles weak models)
      logger.info(`🔍 BULLETPROOF: Attempting extraction with model context: ${modelName || 'unknown'}`);
      const bulletproofCapabilities = bulletproofExtractor.extractCapabilities(response, modelName);
      
      if (bulletproofCapabilities.length > 0) {
        logger.info(`🎯 BULLETPROOF: Found ${bulletproofCapabilities.length} capabilities via bulletproof extractor`);
        
        // Convert to ExtractedCapability format
        const capabilities = bulletproofCapabilities.map((cap, index) => ({
          name: cap.name,
          action: cap.action,
          params: cap.params,
          content: cap.content,
          priority: index
        }));
        
        return capabilities;
      }
      
      // Fallback to original XML parser
      logger.info(`🔧 FALLBACK: Trying original XML parser`);
      const parsedCapabilities = capabilityXMLParser.extractCapabilities(response);
      
      // Convert to ExtractedCapability format with priority
      const capabilities = parsedCapabilities.map((cap, index) => {
        logger.info(`🔍 MAPPING DEBUG: cap.name=${cap.name}, cap.params=${JSON.stringify(cap.params)}, cap.content="${cap.content}"`);
        return {
          name: cap.name,
          action: cap.action,
          params: cap.params,
          content: cap.content,
          priority: index
        };
      });

      logger.info(`Extracted ${capabilities.length} capabilities from response via XML parser`);
      return capabilities;
    } catch (error) {
      logger.error("Error extracting capabilities:", error);
      return [];
    }
  }

  /**
   * Execute capability chain in order
   */
  private async executeCapabilityChain(
    context: OrchestrationContext
  ): Promise<void> {
    for (const capability of context.capabilities) {
      try {
        logger.info(
          `🔧 Executing capability ${capability.name}:${capability.action}`
        );

        // Use robust executor with retry logic for bulletproof capability execution
        const capabilityForRobustExecution = {
          name: capability.name,
          action: capability.action,
          content: capability.content || '',
          params: capability.params
        };
        
        const robustResult = await robustExecutor.executeWithRetry(
          capabilityForRobustExecution,
          { userId: context.userId, messageId: context.messageId },
          3 // max retries
        );
        
        // Convert robust result to orchestrator format
        const result: CapabilityResult = {
          capability,
          success: robustResult.success,
          data: robustResult.data,
          error: robustResult.error,
          timestamp: robustResult.timestamp
        };
        context.results.push(result);
        context.currentStep++;

        logger.info(
          `✅ Capability ${capability.name}:${capability.action} ${
            result.success ? "succeeded" : "failed"
          }`
        );
      } catch (error) {
        logger.error(
          `❌ Capability ${capability.name}:${capability.action} failed:`,
          error
        );

        context.results.push({
          capability,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        });
        context.currentStep++;
      }
    }
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
      // Inject userId into params for capabilities that need user context
      const paramsWithContext = ['scheduler', 'memory'].includes(capability.name)
        ? { ...capability.params, userId }
        : capability.params;
      
      // Debug: log what we're passing to the registry
      logger.info(`🔍 Orchestrator executing: name=${capability.name}, action=${capability.action}, params=${JSON.stringify(paramsWithContext)}, content="${capability.content}"`);
      
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
      logger.warn(`Registry execution failed for ${capability.name}:${capability.action}, trying legacy handlers`);
      
      try {
        switch (capability.name) {
          case "memory":
            result.data = await this.executeMemory(capability);
            result.success = true;
            result.error = undefined;
            break;

          case "wolfram":
            result.data = await this.executeWolfram(capability);
            result.success = true;
            result.error = undefined;
            break;

          case "scheduler":
            result.data = await this.executeScheduler(capability, userId);
            result.success = true;
            result.error = undefined;
            break;

          default:
            // Keep the original error from registry execution
            break;
        }
      } catch (legacyError) {
        logger.error('Legacy handler also failed:', legacyError);
        // Keep the original registry error
      }
    }

    return result;
  }



  /**
   * Basic memory capability
   */

  // This should also be abstracted out to its own file...
  private async executeMemory(
    capability: ExtractedCapability
  ): Promise<string> {
    const action = capability.action;

    if (action === "remember") {
      const content = capability.params.content || capability.content;
      if (!content) {
        throw new Error("No content provided to remember");
      }
      // Placeholder - would store in actual memory system
      return `Remembered: ${content}`;
    }

    if (action === "recall") {
      const query = capability.params.query || capability.content;
      if (!query) {
        throw new Error("No query provided for recall");
      }
      // Placeholder - would query actual memory system
      return `Recalled information about "${query}": [Placeholder - would show actual memories]`;
    }

    throw new Error(`Unknown memory action: ${action}`);
  }

  /**
   * Wolfram Alpha capability
   */
  private async executeWolfram(
    capability: ExtractedCapability
  ): Promise<string> {
    const input =
      capability.params.input || capability.params.query || capability.content;
    if (!input) {
      throw new Error("No input provided for Wolfram Alpha query");
    }

    try {
      const result = await wolframService.query(String(input));
      return result;
    } catch (error) {
      logger.error("Wolfram Alpha capability failed:", error);
      throw error;
    }
  }

  /**
   * Execute scheduler capability
   */

  private async executeScheduler(
    capability: ExtractedCapability,
    userId: string
  ): Promise<string> {
    const { action } = capability;

    switch (action) {
      case "remind":
        return await this.executeSchedulerRemind(capability, userId);
      case "schedule":
        return await this.executeSchedulerSchedule(capability, userId);
      case "list":
        return await this.executeSchedulerList(capability);
      case "cancel":
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
      throw new Error("Reminder message is required");
    }

    const delayMs = parseInt(String(delay)) || 60000; // Default 1 minute
    const reminderName = `reminder-${Date.now()}`;

    await schedulerService.scheduleOnce(
      reminderName,
      {
        type: "user-reminder",
        message,
        userId,
        reminderType: "one-time",
      },
      delayMs
    );

    const delayMinutes = Math.round(delayMs / 60000);
    return `✅ Reminder set: "${message}" in ${delayMinutes} minute${
      delayMinutes !== 1 ? "s" : ""
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
      throw new Error("Task name and cron expression are required");
    }

    const taskId = `task-${Date.now()}`;

    await schedulerService.scheduleTask({
      id: taskId,
      name: String(name),
      cron: String(cron),
      data: {
        type: "user-task",
        message: message || `Scheduled task: ${name}`,
        userId,
      },
    });

    return `✅ Recurring task scheduled: "${name}" (${cron})`;
  }

  /**
   * Execute scheduler list action
   */
  private async executeSchedulerList(
    _capability: ExtractedCapability
  ): Promise<string> {
    const tasks = await schedulerService.getScheduledTasks();

    if (tasks.length === 0) {
      return "📋 No scheduled tasks found";
    }

    const taskList = tasks
      .map((task) => `• ${task.name} - Next: ${task.nextRun.toLocaleString()}`)
      .join("\n");

    return `📋 Scheduled tasks (${tasks.length}):\n${taskList}`;
  }

  /**
   * Execute scheduler cancel action
   */
  private async executeSchedulerCancel(
    capability: ExtractedCapability
  ): Promise<string> {
    const { taskId } = capability.params;

    if (!taskId) {
      throw new Error("Task ID is required for cancellation");
    }

    await schedulerService.removeTask(String(taskId));

    return `✅ Task "${taskId}" cancelled successfully`;
  }

  /**
   * Generate final response incorporating capability results
   * Now sends capability results back to LLM for coherent response generation
   */
  private async generateFinalResponse(
    context: OrchestrationContext,
    originalLLMResponse: string
  ): Promise<string> {
    logger.info(
      `🎯 Generating final response with ${context.results.length} capability results`
    );

    // If no capabilities were executed, return original response
    if (context.results.length === 0) {
      return originalLLMResponse;
    }

    // Build capability results summary for LLM
    const capabilityResults = context.results.map(result => {
      const capability = result.capability;
      if (result.success && result.data) {
        return `${capability.name}:${capability.action} → ${result.data}`;
      } else if (result.error) {
        return `${capability.name}:${capability.action} → Error: ${result.error}`;
      } else {
        return `${capability.name}:${capability.action} → No result`;
      }
    }).join('\n');

    // Create final response prompt
    const finalPrompt = `You are Coach Artie. The user asked: "${context.originalMessage}"

You initially planned to use these capabilities, and here are the results:
${capabilityResults}

Please provide a final, coherent response that incorporates these capability results naturally. Be conversational, helpful, and don't repeat the raw capability output - instead, present the information in a natural way.

Important: 
- Don't use capability tags in your final response
- Present the results as if you calculated/found them yourself
- Be concise but friendly
- If there were errors, acknowledge them helpfully`;

    try {
      // Get final coherent response from LLM
      const finalResponse = await openRouterService.generateResponse(
        finalPrompt,
        context.userId,
        undefined,
        context.messageId
      );
      
      logger.info(`✅ Final coherent response generated successfully`);
      return finalResponse;
      
    } catch (error) {
      logger.error('❌ Failed to generate final coherent response, returning error message', error);
      
      // Return a simple error message instead of trying to parse XML with regex
      return `I apologize, but I encountered an error while processing your request. The capability results were: ${capabilityResults}`;
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
