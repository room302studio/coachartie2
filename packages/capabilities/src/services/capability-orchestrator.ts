import { logger, IncomingMessage } from '@coachartie/shared';
import { openRouterService } from './openrouter.js';
import { schedulerService } from './scheduler.js';

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
  respondTo: IncomingMessage['respondTo'];
}

export class CapabilityOrchestrator {
  private contexts = new Map<string, OrchestrationContext>();

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
      respondTo: message.respondTo
    };

    this.contexts.set(message.id, context);

    try {
      logger.info(`🎬 Starting orchestration for message ${message.id}`);

      // Step 1: Get initial LLM response with capability instructions
      const llmResponse = await this.getLLMResponseWithCapabilities(message);
      logger.info(`🤖 LLM response received: ${llmResponse.substring(0, 100)}...`);

      // Step 2: Extract capabilities from the response
      const capabilities = this.extractCapabilities(llmResponse);
      context.capabilities = capabilities;

      if (capabilities.length === 0) {
        logger.info(`📝 No capabilities detected, returning LLM response directly`);
        return llmResponse;
      }

      logger.info(`🔧 Found ${capabilities.length} capabilities to execute: ${capabilities.map(c => `${c.name}:${c.action}`).join(', ')}`);

      // Step 3: Execute capabilities in order
      await this.executeCapabilityChain(context);

      // Step 4: Generate final response with capability results
      const finalResponse = await this.generateFinalResponse(context, llmResponse);

      this.contexts.delete(message.id);
      return finalResponse;

    } catch (error) {
      logger.error(`❌ Orchestration failed for message ${message.id}:`, error);
      this.contexts.delete(message.id);
      
      // Fallback to simple LLM response
      try {
        return await openRouterService.generateResponse(message.message, message.userId);
      } catch (fallbackError) {
        logger.error('❌ Fallback also failed:', fallbackError);
        return "I encountered an error processing your request. Please try again.";
      }
    }
  }

  /**
   * Get LLM response with capability instruction prompts
   */
  private async getLLMResponseWithCapabilities(message: IncomingMessage): Promise<string> {
    const capabilityInstructions = `
You are Coach Artie, a helpful AI assistant with access to various capabilities. You can use XML tags to execute capabilities when needed.

Available capabilities:
- <capability name="calculator" action="calculate" expression="2+2" /> - Perform calculations
- <capability name="web" action="search" query="search terms" /> - Search the web
- <capability name="web" action="fetch" url="https://example.com" /> - Fetch web content
- <capability name="memory" action="remember" content="information to store" /> - Store information
- <capability name="memory" action="recall" query="what to remember" /> - Recall stored information
- <capability name="wolfram" action="query" input="moon phase today" /> - Query Wolfram Alpha for data
- <capability name="github" action="search" query="search repos" /> - Search GitHub
- <capability name="briefing" action="create" topic="topic" /> - Create briefings
- <capability name="scheduler" action="remind" message="reminder text" delay="60000" /> - Set reminder (delay in ms)
- <capability name="scheduler" action="schedule" name="task name" cron="0 9 * * *" message="task description" /> - Schedule recurring task
- <capability name="scheduler" action="list" /> - List scheduled tasks
- <capability name="scheduler" action="cancel" taskId="task-id" /> - Cancel scheduled task

Instructions:
1. Respond naturally to the user's message
2. If you need to perform calculations, searches, or other actions, include the appropriate capability tags
3. You can use multiple capabilities in one response
4. Place capability tags where you want the results to appear in your response

User's message: ${message.message}`;

    return await openRouterService.generateResponse(capabilityInstructions, message.userId);
  }

  /**
   * Extract capability XML tags from LLM response
   */
  private extractCapabilities(response: string): ExtractedCapability[] {
    const capabilities: ExtractedCapability[] = [];
    
    // Regular expression to match capability XML tags
    const capabilityRegex = /<capability\s+([^>]+)\s*(?:\/>|>(.*?)<\/capability>)/gs;
    let match;
    let priority = 0;

    while ((match = capabilityRegex.exec(response)) !== null) {
      const attributes = match[1];
      const content = match[2]?.trim();

      // Parse attributes
      const params: Record<string, any> = {};
      let name = '';
      let action = '';

      // Simple attribute parsing
      const attrRegex = /(\w+)="([^"]+)"/g;
      let attrMatch;
      
      while ((attrMatch = attrRegex.exec(attributes)) !== null) {
        const [, key, value] = attrMatch;
        if (key === 'name') {
          name = value;
        } else if (key === 'action') {
          action = value;
        } else {
          params[key] = value;
        }
      }

      if (name && action) {
        capabilities.push({
          name,
          action,
          params,
          content,
          priority: priority++
        });
      }
    }

    return capabilities;
  }

  /**
   * Execute capability chain in order
   */
  private async executeCapabilityChain(context: OrchestrationContext): Promise<void> {
    for (const capability of context.capabilities) {
      try {
        logger.info(`🔧 Executing capability ${capability.name}:${capability.action}`);
        
        const result = await this.executeCapability(capability);
        context.results.push(result);
        context.currentStep++;

        logger.info(`✅ Capability ${capability.name}:${capability.action} ${result.success ? 'succeeded' : 'failed'}`);

      } catch (error) {
        logger.error(`❌ Capability ${capability.name}:${capability.action} failed:`, error);
        
        context.results.push({
          capability,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString()
        });
        context.currentStep++;
      }
    }
  }

  /**
   * Execute a single capability
   */
  private async executeCapability(capability: ExtractedCapability): Promise<CapabilityResult> {
    const result: CapabilityResult = {
      capability,
      success: false,
      timestamp: new Date().toISOString()
    };

    try {
      // For now, implement basic capability handlers inline
      // TODO: Integrate with the existing capability registry system
      
      switch (capability.name) {
        case 'calculator':
          result.data = await this.executeCalculator(capability);
          result.success = true;
          break;
          
        case 'web':
          result.data = await this.executeWeb(capability);
          result.success = true;
          break;
          
        case 'memory':
          result.data = await this.executeMemory(capability);
          result.success = true;
          break;
          
        case 'wolfram':
          result.data = await this.executeWolfram(capability);
          result.success = true;
          break;
          
        case 'scheduler':
          result.data = await this.executeScheduler(capability);
          result.success = true;
          break;
          
        default:
          result.error = `Unknown capability: ${capability.name}`;
          result.success = false;
      }

    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      result.success = false;
    }

    return result;
  }

  /**
   * Basic calculator capability
   */
  private async executeCalculator(capability: ExtractedCapability): Promise<string> {
    const expression = capability.params.expression || capability.content;
    if (!expression) {
      throw new Error('No expression provided for calculation');
    }

    // Simple expression evaluation (unsafe but for prototype)
    // TODO: Use safe math expression evaluator
    try {
      const result = Function(`'use strict'; return (${expression})`)();
      return `${expression} = ${result}`;
    } catch (error) {
      throw new Error(`Invalid expression: ${expression}`);
    }
  }

  /**
   * Basic web capability
   */
  private async executeWeb(capability: ExtractedCapability): Promise<string> {
    const action = capability.action;
    
    if (action === 'search') {
      const query = capability.params.query || capability.content;
      if (!query) {
        throw new Error('No search query provided');
      }
      // Placeholder - would integrate with actual search API
      return `Search results for "${query}": [Placeholder - would show actual search results]`;
    }
    
    if (action === 'fetch') {
      const url = capability.params.url;
      if (!url) {
        throw new Error('No URL provided for fetch');
      }
      // Placeholder - would fetch actual content
      return `Content from ${url}: [Placeholder - would show actual content]`;
    }

    throw new Error(`Unknown web action: ${action}`);
  }

  /**
   * Basic memory capability
   */
  private async executeMemory(capability: ExtractedCapability): Promise<string> {
    const action = capability.action;
    
    if (action === 'remember') {
      const content = capability.params.content || capability.content;
      if (!content) {
        throw new Error('No content provided to remember');
      }
      // Placeholder - would store in actual memory system
      return `Remembered: ${content}`;
    }
    
    if (action === 'recall') {
      const query = capability.params.query || capability.content;
      if (!query) {
        throw new Error('No query provided for recall');
      }
      // Placeholder - would query actual memory system
      return `Recalled information about "${query}": [Placeholder - would show actual memories]`;
    }

    throw new Error(`Unknown memory action: ${action}`);
  }

  /**
   * Basic Wolfram Alpha capability
   */
  private async executeWolfram(capability: ExtractedCapability): Promise<string> {
    const input = capability.params.input || capability.params.query || capability.content;
    if (!input) {
      throw new Error('No input provided for Wolfram Alpha query');
    }

    // Placeholder for Wolfram Alpha integration
    // TODO: Integrate with actual Wolfram Alpha API
    
    // Mock some common queries for testing
    const query = input.toLowerCase();
    
    if (query.includes('moon phase')) {
      return `Current moon phase: Waxing Gibbous (73% illuminated). The next full moon is in 4 days.`;
    }
    
    if (query.includes('stock') || query.includes('AAPL') || query.includes('apple')) {
      return `AAPL (Apple Inc.): $185.64 (+2.1% today). Market cap: $2.87T. 52-week range: $164.08 - $199.62`;
    }
    
    if (query.includes('weather')) {
      return `Weather data for current location: 72°F, partly cloudy with 10% chance of rain. Humidity: 65%, Wind: 8 mph NW.`;
    }
    
    if (query.includes('pi') || query.includes('π')) {
      return `π (pi) ≈ 3.14159265358979323846264338327950288... (first 35 digits)`;
    }
    
    if (query.includes('population')) {
      return `Current world population: approximately 8.1 billion people (as of 2024)`;
    }
    
    // Generic response for other queries
    return `Wolfram Alpha result for "${input}": [Computational knowledge engine would provide detailed analysis here]`;
  }

  /**
   * Execute scheduler capability
   */
  private async executeScheduler(capability: ExtractedCapability): Promise<string> {
    const { action } = capability;
    
    switch (action) {
      case 'remind':
        return await this.executeSchedulerRemind(capability);
      case 'schedule':
        return await this.executeSchedulerSchedule(capability);
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
  private async executeSchedulerRemind(capability: ExtractedCapability): Promise<string> {
    const { message, delay } = capability.params;
    
    if (!message) {
      throw new Error('Reminder message is required');
    }
    
    const delayMs = parseInt(delay) || 60000; // Default 1 minute
    const reminderName = `reminder-${Date.now()}`;
    
    await schedulerService.scheduleOnce(reminderName, {
      type: 'user-reminder',
      message,
      userId: 'current-user', // TODO: Get from context
      reminderType: 'one-time'
    }, delayMs);
    
    const delayMinutes = Math.round(delayMs / 60000);
    return `✅ Reminder set: "${message}" in ${delayMinutes} minute${delayMinutes !== 1 ? 's' : ''}`;
  }

  /**
   * Execute scheduler schedule action
   */
  private async executeSchedulerSchedule(capability: ExtractedCapability): Promise<string> {
    const { name, cron, message } = capability.params;
    
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
        userId: 'current-user' // TODO: Get from context
      }
    });
    
    return `✅ Recurring task scheduled: "${name}" (${cron})`;
  }

  /**
   * Execute scheduler list action
   */
  private async executeSchedulerList(capability: ExtractedCapability): Promise<string> {
    const tasks = await schedulerService.getScheduledTasks();
    
    if (tasks.length === 0) {
      return '📋 No scheduled tasks found';
    }
    
    const taskList = tasks.map(task => 
      `• ${task.name} - Next: ${task.nextRun.toLocaleString()}`
    ).join('\n');
    
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
    
    await schedulerService.removeTask(taskId);
    
    return `✅ Task "${taskId}" cancelled successfully`;
  }

  /**
   * Generate final response incorporating capability results
   */
  private async generateFinalResponse(
    context: OrchestrationContext, 
    originalLLMResponse: string
  ): Promise<string> {
    logger.info(`🎯 Generating final response with ${context.results.length} capability results`);

    // Replace capability tags with actual results
    let finalResponse = originalLLMResponse;

    for (const result of context.results) {
      const capability = result.capability;
      
      // Build replacement text
      let replacement: string;
      if (result.success && result.data) {
        replacement = result.data;
      } else if (result.error) {
        replacement = `[Error: ${result.error}]`;
      } else {
        replacement = '[No result]';
      }

      // Find and replace the original capability tag
      const tagPattern = new RegExp(
        `<capability\\s+[^>]*name="${capability.name}"[^>]*action="${capability.action}"[^>]*(?:\\/?>|>.*?</capability>)`,
        'gs'
      );
      
      finalResponse = finalResponse.replace(tagPattern, replacement);
    }

    logger.info(`✅ Final response generated successfully`);
    return finalResponse;
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