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
import { mcpClientCapability } from "../capabilities/mcp-client.js";
import { mcpInstallerCapability } from "../capabilities/mcp-installer.js";
import { memoryCapability } from "../capabilities/memory.js";
import { XMLParser } from "fast-xml-parser";
import { CapabilitySuggester } from "../utils/capability-suggester.js";

// Define capability extraction types
interface ExtractedCapability {
  name: string;
  action: string;
  params: Record<string, any>;
  content?: string;
  priority: number;
}

interface CapabilityResult {
  capability: ExtractedCapability;
  success: boolean;
  data?: any;
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

      // Register real memory capability with persistence
      capabilityRegistry.register(memoryCapability);

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
        handler: async (params, content) => {
          const { action } = params;

          switch (action) {
            case 'remind': {
              const { message, delay, userId } = params;
              if (!message) {
                throw new Error('Reminder message is required');
              }

              const delayMs = parseInt(delay) || 60000; // Default 1 minute
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

      // Step 2: Extract capabilities from the response
      const capabilities = this.extractCapabilities(llmResponse);
      context.capabilities = capabilities;

      if (capabilities.length === 0) {
        logger.info(
          `📝 No capabilities detected, returning LLM response directly`
        );
        return llmResponse;
      }

      logger.info(
        `🔧 Found ${capabilities.length} capabilities to execute: ${capabilities
          .map((c) => `${c.name}:${c.action}`)
          .join(", ")}`
      );

      // Step 3: Execute capabilities in order
      await this.executeCapabilityChain(context);

      // Step 4: Generate final response with capability results
      const finalResponse = await this.generateFinalResponse(
        context,
        llmResponse
      );

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
      // Try to get from database first
      const capabilityInstructions = await promptManager.getCapabilityInstructions(message.message);
      
      logger.info(`🎯 Using capability instructions from database`);
      
      return await openRouterService.generateResponse(
        capabilityInstructions,
        message.userId
      );
    } catch (error) {
      logger.error('❌ Failed to get capability instructions from database, generating dynamic fallback', error);
      
      // Generate dynamic instructions based on registered capabilities
      const dynamicInstructions = this.generateDynamicCapabilityInstructions(message.message);
      
      return await openRouterService.generateResponse(
        dynamicInstructions,
        message.userId
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
    const examples = this.generateContextualExamples(userMessage, capabilities);

    return `You are Coach Artie, a helpful AI assistant with access to powerful capabilities through XML tags.

CRITICAL: You MUST use XML capability tags for ANY action that requires computation, data retrieval, or external operations.

SUPPORTED FORMATS:
- With content: <capability name="calculator" action="calculate">2+2</capability>
- Self-closing: <capability name="web" action="search" query="latest news" />
- Mixed: <capability name="scheduler" action="remind" delay="60000" message="task">reminder content</capability>

AVAILABLE CAPABILITIES:
${capabilityDocs}

EXAMPLES:
${examples}

IMPORTANT RULES:
1. ALWAYS use capability tags when you need to calculate, search, or perform any action
2. Use self-closing tags for simple operations with only attributes
3. Use content tags for complex expressions or text
4. You can chain multiple capabilities in one response
5. If unsure, use a capability rather than trying to answer directly
6. DO NOT provide your own answer after a capability tag - the capability will handle it
7. Let the capability tags do the work - don't duplicate or guess the results

User's message: ${userMessage}

Remember: Use capability tags for ALL calculations, searches, and operations!`;
  }

  /**
   * Generate simpler instructions for free/smaller models with intelligent suggestions
   */
  private generateSimpleCapabilityInstructions(userMessage: string, capabilities: RegisteredCapability[]): string {
    // Get intelligent suggestions based on user query
    const suggestions = this.capabilitySuggester.suggestCapabilities(userMessage, 2);
    
    // Use the top suggestion as primary example
    let primaryExample = '<capability name="calculator" action="calculate">2 + 2</capability>';
    let suggestionsSection = '';
    
    if (suggestions.length > 0) {
      primaryExample = suggestions[0].example;
      
      // Create suggestions section
      suggestionsSection = `

🎯 **Suggested capabilities for your query:**
${suggestions.map((s, i) => `${i + 1}. ${s.example} (${Math.round(s.confidence * 100)}% match - ${s.reasoning})`).join('\n')}

💡 Use these suggestions to accomplish your task!`;
    }
    
    return `You are Coach Artie. Use XML tags for actions.

SUPPORTED FORMATS:
✅ With content: <capability name="calculator" action="calculate">2+2</capability>
✅ Self-closing: <capability name="web" action="search" query="latest news" />
✅ With params: <capability name="scheduler" action="remind" delay="60000" message="task">content</capability>

IMPORTANT: Do NOT write your own answer after capability tags - they will be replaced with results!

Best suggestion for your task: ${primaryExample}${suggestionsSection}

User: ${userMessage}

Your response:`;
  }

  /**
   * Extract mathematical expression from user message
   */
  private extractMathExpression(message: string): string {
    // Try to extract numbers and operators
    const mathPattern = /[\d\s\+\-\*\/\(\)\.]+/g;
    const matches = message.match(mathPattern);
    
    if (matches && matches.length > 0) {
      // Join all matches and clean up
      return matches.join(' ').trim();
    }
    
    // Fallback to the whole message
    return message;
  }

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
    if (a === b) return 1.0;
    if (a.length === 0 || b.length === 0) return 0.0;
    
    // Check for substring matches
    if (a.includes(b) || b.includes(a)) return 0.8;
    
    // Check for common substrings
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();
    
    if (aLower.includes(bLower) || bLower.includes(aLower)) return 0.7;
    
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
  private extractCapabilities(response: string): ExtractedCapability[] {
    const capabilities: ExtractedCapability[] = [];

    try {
      // Extract capability tags from the response using regex to find individual tags
      // We still use regex to find the tags, but then parse each one with XML parser
      const capabilityRegex = /<capability\s+[^>]*(?:\/>|>.*?<\/capability>)/gs;
      const matches = response.match(capabilityRegex);

      if (!matches) {
        return capabilities;
      }

      // Configure XML parser
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        textNodeName: "#text",
        parseAttributeValue: true,
        trimValues: true,
        preserveOrder: false,
        parseTagValue: false,
      });

      let priority = 0;

      for (const match of matches) {
        try {
          // Wrap in a root element to make it valid XML
          const wrappedXml = `<root>${match}</root>`;
          const parsed = parser.parse(wrappedXml);

          if (parsed.root && parsed.root.capability) {
            const capabilityNode = parsed.root.capability;
            
            // Extract name and action from attributes
            const name = capabilityNode["@_name"];
            const action = capabilityNode["@_action"];

            if (!name || !action) {
              logger.warn(`Skipping capability tag missing required attributes: name="${name}", action="${action}"`);
              continue;
            }

            // Extract all other attributes as params
            const params: Record<string, any> = {};
            Object.keys(capabilityNode).forEach(key => {
              if (key.startsWith("@_") && key !== "@_name" && key !== "@_action") {
                const paramName = key.substring(2); // Remove "@_" prefix
                params[paramName] = capabilityNode[key];
              }
            });

            // Extract content (text between opening and closing tags)
            let contentStr: string | undefined;
            
            // For self-closing tags, there's no content
            if (match.includes('/>')) {
              contentStr = undefined;
            } else {
              // For tags with content, extract everything between opening and closing tags
              const contentMatch = match.match(/>(.+?)<\/capability>/s);
              if (contentMatch) {
                contentStr = contentMatch[1].trim();
              }
            }

            capabilities.push({
              name,
              action,
              params,
              content: contentStr,
              priority: priority++,
            });

            logger.debug(`Extracted capability: ${name}:${action} with params:`, params);
          }
        } catch (parseError) {
          logger.warn(`Failed to parse capability XML: ${match}`, parseError);
          // Continue processing other capability tags even if one fails
        }
      }
    } catch (error) {
      logger.error("Error extracting capabilities:", error);
      // Fall back to empty array rather than throwing
    }

    logger.info(`Extracted ${capabilities.length} capabilities from response`);
    return capabilities;
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

        const result = await this.executeCapability(capability, context);
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
      // TODO: Remove this fallback once all capabilities are migrated to registry
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
  // TODO: ALSO MOVED TO ITS OWN FILE
  private async executeWolfram(
    capability: ExtractedCapability
  ): Promise<string> {
    const input =
      capability.params.input || capability.params.query || capability.content;
    if (!input) {
      throw new Error("No input provided for Wolfram Alpha query");
    }

    try {
      const result = await wolframService.query(input);
      return result;
    } catch (error) {
      logger.error("Wolfram Alpha capability failed:", error);
      throw error;
    }
  }

  /**
   * Execute scheduler capability
   */

  // TODO: I think we already have a schedule file somewhere? Centralize all the code in one place, ideally
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

    const delayMs = parseInt(delay) || 60000; // Default 1 minute
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
      name,
      cron,
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
    capability: ExtractedCapability
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

    await schedulerService.removeTask(taskId);

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
        context.userId
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
