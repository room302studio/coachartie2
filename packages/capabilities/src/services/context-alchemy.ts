import { logger } from '@coachartie/shared';
import { conscienceLLM } from './conscience.js';
import { IncomingMessage } from '@coachartie/shared';
import { MemoryEntourageInterface } from './memory-entourage-interface.js';
import { BasicKeywordMemoryEntourage } from './basic-keyword-memory-entourage.js';
import { CombinedMemoryEntourage } from './combined-memory-entourage.js';

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
  private memoryEntourage: MemoryEntourageInterface;
  
  constructor() {
    // Initialize with CombinedMemoryEntourage for multi-layered memory integration
    this.memoryEntourage = new CombinedMemoryEntourage();
    logger.info('🧠 Context Alchemy: Initialized with CombinedMemoryEntourage (keyword + semantic)');
  }
  
  static getInstance(): ContextAlchemy {
    if (!ContextAlchemy.instance) {
      ContextAlchemy.instance = new ContextAlchemy();
    }
    return ContextAlchemy.instance;
  }

  /**
   * Upgrade the memory entourage implementation (for dependency injection)
   */
  setMemoryEntourage(memoryEntourage: MemoryEntourageInterface): void {
    this.memoryEntourage = memoryEntourage;
    logger.info('🧠 Context Alchemy: Memory entourage implementation upgraded');
  }

  /**
   * Main entry point - builds contextual message chain (user message is always last)
   */
  async buildMessageChain(
    userMessage: string, 
    userId: string, 
    baseSystemPrompt: string, 
    existingMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [],
    options: { minimal?: boolean } = {}
  ): Promise<{
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    contextSources: ContextSource[];
  }> {
    logger.info(`🧪 Context Alchemy: Building ${options.minimal ? 'minimal' : 'intelligent'} message chain`);
    
    let selectedContext: ContextSource[] = [];
    
    if (!options.minimal) {
      // 1. Calculate token budget
      const budget = this.calculateTokenBudget(userMessage, baseSystemPrompt);
      
      // 2. Assemble message context (beautiful, readable pattern)
      const mockMessage: IncomingMessage = { 
        message: userMessage, 
        userId, 
        id: 'context-gen', 
        source: 'capabilities',
        respondTo: { type: 'api' },
        timestamp: new Date(),
        retryCount: 0
      };
      const contextSources = await this.assembleMessageContext(mockMessage);
      
      // 3. Prioritize and select context within budget
      selectedContext = this.selectOptimalContext(contextSources, budget);
    } else {
      // Minimal mode: only add temporal context for date/time awareness
      const minimalSources: ContextSource[] = [];
      await this.addCurrentDateTime(minimalSources);
      selectedContext = minimalSources;
    }
    
    // 4. Build message chain
    const messageChain = this.assembleMessageChain(
      baseSystemPrompt, 
      userMessage, 
      selectedContext, 
      existingMessages
    );
    
    // Single comprehensive context alchemy log
    const contextBreakdown = selectedContext.map(ctx => `${ctx.name}:${ctx.tokenWeight}t`).join(',');
    const totalTokens = selectedContext.reduce((sum, ctx) => sum + ctx.tokenWeight, 0);
    logger.info(`🧪 ALCHEMY: ${messageChain.length} msgs | ${selectedContext.length} contexts | ${totalTokens}t total | [${contextBreakdown}]`);
    
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
   * Assemble message context (inspired by the beautiful assembleMessagePreamble pattern)
   * Each step is crystal clear, single responsibility, easy to debug
   */
  private async assembleMessageContext(message: IncomingMessage): Promise<ContextSource[]> {
    logger.info(`📝 Assembling message context for <${message.userId}> message`);
    const sources: ContextSource[] = [];

    await this.addCurrentDateTime(sources);
    await this.addGoalWhisper(message, sources);  
    await this.addRelevantMemories(message, sources);
    await this.addTodoContext(message, sources);
    // Skip goals - they overlap with TODOs too much
    await this.addCreditBalanceContext(sources);
    await this.addCapabilityManifest(sources);
    // Future: await this.addUserPreferences(message, sources);
    // Future: await this.addConversationHistory(message, sources);

    return sources.filter(source => source.content.length > 0);
  }

  /**
   * Add current date/time to message context (matches assembleMessagePreamble pattern)
   */
  private async addCurrentDateTime(sources: ContextSource[]): Promise<void> {
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
    
    sources.push({
      name: 'temporal_context',
      priority: 100, // Always highest priority
      tokenWeight: Math.ceil(content.length / 4),
      content,
      category: 'temporal'
    });
  }

  /**
   * Add goal whisper to message context (matches assembleMessagePreamble pattern)
   */
  private async addGoalWhisper(message: IncomingMessage, sources: ContextSource[]): Promise<void> {
    try {
      const goalWhisper = await conscienceLLM.getGoalWhisper(message.message, message.userId);
      
      if (goalWhisper) {
        const content = `[Conscience: ${goalWhisper}]`;
        
        sources.push({
          name: 'goal_context', 
          priority: 90, // High priority when available
          tokenWeight: Math.ceil(content.length / 4),
          content,
          category: 'goals'
        });
      }
    } catch (error) {
      logger.warn('Failed to add goal whisper:', error);
      // Graceful degradation - continue without goal context
    }
  }

  /**
   * Add relevant memories to message context (matches assembleMessagePreamble pattern)
   */
  private async addRelevantMemories(message: IncomingMessage, sources: ContextSource[]): Promise<void> {
    try {
      // Calculate available token budget for memory context
      const estimatedOtherTokens = 500; // Conservative estimate for other context
      const maxTokensForMemory = 800; // Max tokens for memory content
      
      const memoryResult = await this.memoryEntourage.getMemoryContext(
        message.message,
        message.userId,
        {
          maxTokens: maxTokensForMemory,
          priority: 'speed', // Default to speed for responsive interactions
          minimal: false
        }
      );
      
      // Only add memory context if we actually have useful content
      if (memoryResult.content && memoryResult.content.trim().length > 0) {
        sources.push({
          name: 'memory_context',
          priority: 70,
          tokenWeight: Math.ceil(memoryResult.content.length / 4),
          content: memoryResult.content,
          category: 'memory'
        });
        
        // Condensed but detailed memory audit log
        const memoryIds = memoryResult.memoryIds || [];
        const preview = memoryResult.content.substring(0, 150).replace(/\n/g, ' ');
        logger.info(`🧠 MEMORY: ${memoryResult.memoryCount} memories | conf=${memoryResult.confidence.toFixed(2)} | ${memoryResult.content.length} chars | IDs=[${memoryIds.slice(0, 8).join(',')}${memoryIds.length > 8 ? '...' : ''}] | cats=[${memoryResult.categories.join(',')}] | "${preview}..."`);
        
      }
    } catch (error) {
      logger.warn('Failed to add relevant memories:', error);
      // Graceful degradation - continue without memory context
    }
  }

  /**
   * Add TODO context - simple is better
   */
  private async addTodoContext(message: IncomingMessage, sources: ContextSource[]): Promise<void> {
    try {
      const { TodoService } = await import('../capabilities/todo.js');
      const todoService = TodoService.getInstance();
      
      const allLists = await todoService.listAllLists(message.userId);
      
      if (!allLists || allLists.includes('No todo lists found')) return;
      
      // Just grab the numbers
      const pendingMatch = allLists.match(/(\d+) pending/);
      const pending = pendingMatch ? parseInt(pendingMatch[1]) : 0;
      
      if (pending > 0) {
        const todoContent = `📋 You have ${pending} pending TODOs`;
        
        sources.push({
          name: 'todo_context',
          priority: 85,
          tokenWeight: 20,
          content: todoContent,
          category: 'user_state'
        });
      }
    } catch (e) {
      // TODOs broken? Move on without them
    }
  }

  /**
   * Add credit balance warning to context if low
   */
  private async addCreditBalanceContext(sources: ContextSource[]): Promise<void> {
    try {
      const { getDatabase } = await import('@coachartie/shared');
      const dbInstance = await getDatabase();
      
      // Get latest credit info
      const creditInfo = await dbInstance.get(`
        SELECT credits_remaining, daily_spend 
        FROM credit_balance 
        WHERE provider = 'openrouter' 
        ORDER BY last_updated DESC 
        LIMIT 1
      `);
      
      if (creditInfo && creditInfo.credits_remaining !== null) {
        const remaining = creditInfo.credits_remaining;
        const dailySpend = creditInfo.daily_spend || 0;
        
        // Only add warning if credits are low
        if (remaining < 0.50) {  // Less than 50 cents
          const content = `⚠️ API Credits Low: $${remaining.toFixed(2)} remaining (daily usage: $${dailySpend.toFixed(2)})`;
          
          sources.push({
            name: 'credit_warning',
            priority: 95, // Very high priority - important operational info
            tokenWeight: Math.ceil(content.length / 4),
            content,
            category: 'user_state'
          });
          
          logger.warn(`💳 Low credit warning added to context: $${remaining.toFixed(2)}`);
        }
      }
    } catch (error) {
      // Silent fail - credits aren't critical for operation
      logger.debug('Could not fetch credit balance:', error);
    }
  }

  /**
   * Add capability manifest to message context (matches assembleMessagePreamble pattern)
   */
  private async addCapabilityManifest(sources: ContextSource[]): Promise<void> {
    // Just the essential capability info, not a massive list
    const content = `Available capabilities: calculate, remember, recall, web-search, goal, variable_store, todo, linkedin`;
    
    sources.push({
      name: 'capability_context',
      priority: 30, // Lower priority - capabilities can be learned
      tokenWeight: Math.ceil(content.length / 4),
      content,
      category: 'capabilities'
    });
  }

  /**
   * Throw the I Ching for guidance
   */
  private throwIChing(): string {
    const hexagrams = [
      '☰ Creative', '☷ Receptive', '☳ Thunder', '☵ Water',
      '☶ Mountain', '☴ Wind', '☲ Fire', '☱ Lake'
    ];
    return hexagrams[Math.floor(Math.random() * hexagrams.length)];
  }

  /**
   * Select context with stochastic variation - guided by I Ching
   */
  private selectOptimalContext(sources: ContextSource[], budget: ContextBudget): ContextSource[] {
    const hexagram = this.throwIChing();
    
    // Add 10-30% randomness to priorities based on hexagram
    const chaos = hexagram.includes('Thunder') ? 0.3 : 0.1;
    
    const stochastic = [...sources].map(s => ({
      ...s,
      originalPriority: s.priority,
      priority: s.priority * (1 - chaos + Math.random() * chaos * 2)
    }));
    
    // Sort by stochastic priority
    const sortedSources = stochastic.sort((a, b) => b.priority - a.priority);
    
    const selected: ContextSource[] = [];
    let usedTokens = 0;
    
    for (const source of sortedSources) {
      if (usedTokens + source.tokenWeight <= budget.availableForContext) {
        selected.push(source);
        usedTokens += source.tokenWeight;
      }
    }
    
    // Detailed stochastic log showing chaos factor and what got selected
    const selectionDetails = selected.map(s => `${s.name}(${s.tokenWeight}t)`).join(',');
    const totalSources = sources.length;
    const selectedRatio = (selected.length / totalSources * 100).toFixed(0);
    logger.info(`🎲 CONTEXT: ${hexagram} | chaos=${chaos} | ${selected.length}/${totalSources} sources (${selectedRatio}%) | ${usedTokens}/${budget.availableForContext}t | [${selectionDetails}]`);
    
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