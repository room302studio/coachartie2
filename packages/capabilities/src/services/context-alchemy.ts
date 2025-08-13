import { logger } from '@coachartie/shared';
import { conscienceLLM } from './conscience.js';
import { IncomingMessage } from '@coachartie/shared';

interface ContextSource {
  name: string;
  priority: number;
  tokenWeight: number;
  content: string;
  category: 'temporal' | 'goals' | 'memory' | 'capabilities' | 'user_state';
}

interface ContextBudget {
  totalTokens: number;
  reservedForUser: number;
  reservedForSystem: number;
  availableForContext: number;
}

/**
 * Context Alchemy System - Intelligent context window management
 * 
 * Instead of hardcoded string replacements, this system:
 * 1. Gathers context from multiple sources
 * 2. Prioritizes based on relevance and importance  
 * 3. Manages token budget intelligently
 * 4. Assembles optimal context for the LLM
 */
export class ContextAlchemy {
  private static instance: ContextAlchemy;
  
  static getInstance(): ContextAlchemy {
    if (!ContextAlchemy.instance) {
      ContextAlchemy.instance = new ContextAlchemy();
    }
    return ContextAlchemy.instance;
  }

  /**
   * Main entry point - builds contextual message chain (user message is always last)
   */
  async buildMessageChain(
    userMessage: string, 
    userId: string, 
    baseSystemPrompt: string, 
    existingMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
  ): Promise<{
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    contextSources: ContextSource[];
  }> {
    logger.info('🧪 Context Alchemy: Building intelligent message chain');
    
    // 1. Calculate token budget
    const budget = this.calculateTokenBudget(userMessage, baseSystemPrompt);
    
    // 2. Gather all available context sources
    const mockMessage = { message: userMessage, userId, id: 'context-gen', source: 'alchemy' } as IncomingMessage;
    const contextSources = await this.gatherContextSources(mockMessage);
    
    // 3. Prioritize and select context within budget
    const selectedContext = this.selectOptimalContext(contextSources, budget);
    
    // 4. Build message chain
    const messageChain = this.assembleMessageChain(
      baseSystemPrompt, 
      userMessage, 
      selectedContext, 
      existingMessages
    );
    
    logger.info(`🧪 Context Alchemy: Built chain with ${messageChain.length} messages and ${selectedContext.length} context sources`);
    selectedContext.forEach(ctx => {
      logger.info(`  📝 ${ctx.name} (${ctx.category}, priority: ${ctx.priority}, tokens: ~${ctx.tokenWeight})`);
    });
    
    return { messages: messageChain, contextSources: selectedContext };
  }

  /**
   * Calculate intelligent token budget based on model capabilities
   */
  private calculateTokenBudget(userMessage: string, baseInstructions: string): ContextBudget {
    // Conservative estimate: ~4 chars per token
    const userTokens = Math.ceil(userMessage.length / 4);
    const systemTokens = Math.ceil(baseInstructions.length / 4);
    
    // Free models typically have 4k-8k context windows
    const totalTokens = 4000; // Conservative for free models
    const reservedForResponse = 500; // Reserve tokens for response
    
    const availableForContext = totalTokens - userTokens - systemTokens - reservedForResponse;
    
    return {
      totalTokens,
      reservedForUser: userTokens,
      reservedForSystem: systemTokens,
      availableForContext: Math.max(0, availableForContext)
    };
  }

  /**
   * Gather context from all available sources
   */
  private async gatherContextSources(message: IncomingMessage): Promise<ContextSource[]> {
    const sources: ContextSource[] = [];

    // 1. Temporal context (always high priority)
    sources.push(await this.getTemporalContext());
    
    // 2. Goal context (high priority if goals exist)
    sources.push(await this.getGoalContext(message));
    
    // 3. Memory context (medium priority)
    const memoryContext = await this.getMemoryContext(message);
    if (memoryContext) sources.push(memoryContext);
    
    // 4. Capability context (low priority - just essential info)
    sources.push(await this.getCapabilityContext());

    return sources.filter(source => source.content.length > 0);
  }

  /**
   * Get current date/time context
   */
  private async getTemporalContext(): Promise<ContextSource> {
    const now = new Date();
    const formatted = now.toLocaleDateString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short'
    });
    
    const content = `Current date and time: ${formatted}\nISO timestamp: ${now.toISOString()}`;
    
    return {
      name: 'temporal_context',
      priority: 100, // Always highest priority
      tokenWeight: Math.ceil(content.length / 4),
      content,
      category: 'temporal'
    };
  }

  /**
   * Get goal-aware context via conscience whisper
   */
  private async getGoalContext(message: IncomingMessage): Promise<ContextSource> {
    try {
      const goalWhisper = await conscienceLLM.getGoalWhisper(message.message, message.userId);
      
      if (!goalWhisper) {
        return {
          name: 'goal_context',
          priority: 0,
          tokenWeight: 0,
          content: '',
          category: 'goals'
        };
      }
      
      const content = `[Conscience: ${goalWhisper}]`;
      
      return {
        name: 'goal_context', 
        priority: 90, // High priority when available
        tokenWeight: Math.ceil(content.length / 4),
        content,
        category: 'goals'
      };
    } catch (error) {
      logger.warn('Failed to get goal context:', error);
      return {
        name: 'goal_context',
        priority: 0,
        tokenWeight: 0,
        content: '',
        category: 'goals'
      };
    }
  }

  /**
   * Get relevant memory patterns
   */
  private async getMemoryContext(message: IncomingMessage): Promise<ContextSource | null> {
    try {
      // This would integrate with the existing memory pattern system
      // For now, return a placeholder to maintain the architecture
      return {
        name: 'memory_context',
        priority: 70,
        tokenWeight: 50,
        content: '# Recent relevant experiences: (memory integration pending)',
        category: 'memory'
      };
    } catch (error) {
      logger.warn('Failed to get memory context:', error);
      return null;
    }
  }

  /**
   * Get essential capability information
   */
  private async getCapabilityContext(): Promise<ContextSource> {
    // Just the essential capability info, not a massive list
    const content = `Available capabilities: calculate, remember, recall, web-search, goal, variable_store, todo, linkedin`;
    
    return {
      name: 'capability_context',
      priority: 30, // Lower priority - capabilities can be learned
      tokenWeight: Math.ceil(content.length / 4),
      content,
      category: 'capabilities'
    };
  }

  /**
   * Select optimal context sources within token budget
   */
  private selectOptimalContext(sources: ContextSource[], budget: ContextBudget): ContextSource[] {
    // Sort by priority (highest first)
    const sortedSources = [...sources].sort((a, b) => b.priority - a.priority);
    
    const selected: ContextSource[] = [];
    let usedTokens = 0;
    
    for (const source of sortedSources) {
      if (usedTokens + source.tokenWeight <= budget.availableForContext) {
        selected.push(source);
        usedTokens += source.tokenWeight;
        logger.debug(`✅ Selected ${source.name} (${source.tokenWeight} tokens)`);
      } else {
        logger.debug(`❌ Skipped ${source.name} (${source.tokenWeight} tokens, would exceed budget)`);
      }
    }
    
    logger.info(`🧪 Context selection: ${usedTokens}/${budget.availableForContext} tokens used`);
    
    return selected;
  }

  /**
   * Assemble message chain with intelligent context placement
   */
  private assembleMessageChain(
    baseSystemPrompt: string,
    userMessage: string,
    contextSources: ContextSource[],
    existingMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
  ): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    
    const contextByCategory = this.groupContextByCategory(contextSources);
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
    
    // 1. System message with temporal context
    let systemContent = baseSystemPrompt;
    if (contextByCategory.temporal.length > 0) {
      systemContent = `${contextByCategory.temporal[0].content}\n\n${systemContent}`;
    }
    if (contextByCategory.capabilities.length > 0) {
      systemContent += `\n\n${contextByCategory.capabilities[0].content}`;
    }
    
    messages.push({ role: 'system', content: systemContent.trim() });
    
    // 2. Add any existing conversation history
    messages.push(...existingMessages);
    
    // 3. Add context messages (some randomization for variety)
    if (contextByCategory.memory.length > 0) {
      // Randomly decide if memory goes as assistant context or user context
      const role = Math.random() > 0.5 ? 'assistant' : 'user';
      messages.push({
        role,
        content: `Context: ${contextByCategory.memory[0].content}`
      });
    }
    
    // 4. Add goal whisper as system-level context if available
    if (contextByCategory.goals.length > 0) {
      messages.push({
        role: 'system',
        content: contextByCategory.goals[0].content
      });
    }
    
    // 5. User message ALWAYS comes last
    messages.push({ role: 'user', content: userMessage });
    
    return messages;
  }

  /**
   * Group context sources by category for organized assembly
   */
  private groupContextByCategory(sources: ContextSource[]): Record<string, ContextSource[]> {
    const grouped: Record<string, ContextSource[]> = {
      temporal: [],
      goals: [],
      memory: [],
      capabilities: [],
      user_state: []
    };
    
    for (const source of sources) {
      grouped[source.category].push(source);
    }
    
    return grouped;
  }
}

// Export singleton
export const contextAlchemy = ContextAlchemy.getInstance();