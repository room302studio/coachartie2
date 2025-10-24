import { logger } from '@coachartie/shared';
import { conscienceLLM } from './conscience.js';
import { IncomingMessage } from '@coachartie/shared';
import { MemoryEntourageInterface } from './memory-entourage-interface.js';
import { CombinedMemoryEntourage } from './combined-memory-entourage.js';

// Debug flag for detailed Context Alchemy logging
const DEBUG = process.env.CONTEXT_ALCHEMY_DEBUG === 'true';

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
    if (DEBUG) {
      logger.info(
        '🧠 Context Alchemy: Initialized with CombinedMemoryEntourage (keyword + semantic)'
      );
    }
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
    if (DEBUG) {
      logger.info('🧠 Context Alchemy: Memory entourage implementation upgraded');
    }
  }

  /**
   * Main entry point - builds contextual message chain (user message is always last)
   */
  async buildMessageChain(
    userMessage: string,
    userId: string,
    baseSystemPrompt: string,
    existingMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [],
    options: { minimal?: boolean; capabilityContext?: string[]; channelId?: string; includeCapabilities?: boolean } = {}
  ): Promise<{
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    contextSources: ContextSource[];
  }> {
    // Always log if Context Alchemy is called and debug status
    logger.info(`🧪 Context Alchemy called (DEBUG=${DEBUG})`);

    if (DEBUG) {
      logger.info('╔═══════════════════════════════════════════════════════════════╗');
    }
    if (DEBUG) {
      logger.info('║              🧪 CONTEXT ALCHEMY ASSEMBLY START 🧪              ║');
    }
    if (DEBUG) {
      logger.info('╚═══════════════════════════════════════════════════════════════╝');
    }
    if (DEBUG) {
      logger.info(`📥 User: ${userId} | Message length: ${userMessage.length} chars`);
    }
    if (DEBUG) {
      logger.info(`⚙️  Mode: ${options.minimal ? 'MINIMAL' : 'FULL INTELLIGENCE'}`);
    }

    let selectedContext: ContextSource[] = [];
    let conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    if (!options.minimal) {
      // 1. Calculate token budget
      const budget = this.calculateTokenBudget(userMessage, baseSystemPrompt);

      // 2. Load conversation history (if available)
      conversationHistory = await this.getConversationHistory(userId, options.channelId, 3);

      // 3. Assemble message context (beautiful, readable pattern)
      const mockMessage: IncomingMessage = {
        message: userMessage,
        userId,
        id: 'context-gen',
        source: 'capabilities',
        respondTo: { type: 'api' },
        timestamp: new Date(),
        retryCount: 0,
        context: options.channelId ? { channelId: options.channelId } : undefined,
      };
      const contextSources = await this.assembleMessageContext(
        mockMessage,
        options.capabilityContext,
        options.includeCapabilities ?? true // Default to true for backwards compatibility
      );

      // 4. Prioritize and select context within budget
      selectedContext = this.selectOptimalContext(contextSources, budget);
    } else {
      // Minimal mode: only add temporal context for date/time awareness
      const minimalSources: ContextSource[] = [];
      await this.addCurrentDateTime(minimalSources);
      selectedContext = minimalSources;
    }

    // 5. Build message chain with conversation history
    const messageChain = this.assembleMessageChain(
      baseSystemPrompt,
      userMessage,
      selectedContext,
      existingMessages,
      conversationHistory
    );

    // Final assembly summary
    if (DEBUG) {
      logger.info('┌─ FINAL MESSAGE CHAIN ───────────────────────────────────────────┐');
    }
    messageChain.forEach((msg, i) => {
      const preview = msg.content.substring(0, 60).replace(/\n/g, ' ');
      const suffix = msg.content.length > 60 ? '...' : '';
      if (DEBUG) {
        logger.info(`│ [${i}] ${msg.role.padEnd(9)}: ${preview}${suffix}`);
      }
    });
    if (DEBUG) {
      logger.info('└─────────────────────────────────────────────────────────────────┘');
    }

    if (DEBUG) {
      logger.info('┌─ CONTEXT SOURCES INCLUDED ──────────────────────────────────────┐');
    }
    selectedContext.forEach((ctx) => {
      if (DEBUG) {
        logger.info(
          `│ ${ctx.category.padEnd(12)} | Pri:${ctx.priority.toString().padStart(3)} | ~${ctx.tokenWeight.toString().padStart(4)} tokens | ${ctx.name}`
        );
      }
    });
    if (DEBUG) {
      logger.info('└─────────────────────────────────────────────────────────────────┘');
    }

    if (DEBUG) {
      logger.info('╔═══════════════════════════════════════════════════════════════╗');
    }
    if (DEBUG) {
      logger.info(
        `║ ✅ CONTEXT ASSEMBLY COMPLETE: ${messageChain.length} messages, ${selectedContext.length} sources ║`
      );
    }
    if (DEBUG) {
      logger.info('╚═══════════════════════════════════════════════════════════════╝\n');
    }

    return { messages: messageChain, contextSources: selectedContext };
  }

  /**
   * Generate synthesis prompt for capability results
   * This creates a properly formatted prompt for synthesizing capability execution results
   * into a coherent response
   */
  async generateCapabilitySynthesisPrompt(
    originalMessage: string,
    capabilityResults: string
  ): Promise<string> {
    if (DEBUG) {
      logger.info('🧪 Context Alchemy: Generating capability synthesis prompt');
    }

    // TODO: Use prompt database for these templates once available
    const synthesisPrompt = `Assistant response synthesis. User asked: "${originalMessage}"

Capability execution results:
${capabilityResults}

Please provide a final, coherent response that incorporates these capability results naturally. Be conversational, helpful, and don't repeat the raw capability output - instead, present the information in a natural way.

Important:
- Don't use capability tags in your final response
- Present the results as if you calculated/found them yourself
- Be concise but friendly
- If there were errors, acknowledge them helpfully`;

    return synthesisPrompt;
  }

  /**
   * Calculate intelligent token budget based on model capabilities
   */
  private calculateTokenBudget(userMessage: string, baseInstructions: string): ContextBudget {
    // Conservative estimate: ~4 chars per token
    const userTokens = Math.ceil(userMessage.length / 4);
    const systemTokens = Math.ceil(baseInstructions.length / 4);

    // Modern models (Claude 3.5, GPT-4) have 128k-200k context windows
    // Use 8k intelligently - enough for rich context without waste
    const totalTokens = 8000; // Increased from 4000 for better conversations
    const reservedForResponse = 1000; // Reserve more tokens for detailed responses

    const availableForContext = totalTokens - userTokens - systemTokens - reservedForResponse;

    const budget = {
      totalTokens,
      reservedForUser: userTokens,
      reservedForSystem: systemTokens,
      availableForContext: Math.max(0, availableForContext),
    };

    if (DEBUG) {
      logger.info('┌─ TOKEN BUDGET CALCULATION ─────────────────────────────────────┐');
    }
    if (DEBUG) {
      logger.info(`│ Total Window:     ${totalTokens} tokens`);
    }
    if (DEBUG) {
      logger.info(`│ User Message:     ${userTokens} tokens (${userMessage.length} chars)`);
    }
    if (DEBUG) {
      logger.info(`│ System Prompt:    ${systemTokens} tokens`);
    }
    if (DEBUG) {
      logger.info(`│ Reserved Reply:   ${reservedForResponse} tokens`);
    }
    if (DEBUG) {
      logger.info(`│ ═══════════════════════════════════════════════════════════════ │`);
    }
    if (DEBUG) {
      logger.info(
        `│ 💰 Available:     ${budget.availableForContext} tokens for context enrichment`
      );
    }
    if (DEBUG) {
      logger.info('└─────────────────────────────────────────────────────────────────┘');
    }

    return budget;
  }

  /**
   * Assemble message context (inspired by the beautiful assembleMessagePreamble pattern)
   * Each step is crystal clear, single responsibility, easy to debug
   */
  private async assembleMessageContext(
    message: IncomingMessage,
    capabilityContext?: string[],
    includeCapabilities: boolean = true
  ): Promise<ContextSource[]> {
    if (DEBUG) {
      logger.info(`📝 Assembling message context for <${message.userId}> message`);
    }
    if (capabilityContext && capabilityContext.length > 0 && DEBUG) {
      logger.info(`🔧 Capability context: ${capabilityContext.join(', ')}`);
    }
    const sources: ContextSource[] = [];

    await this.addCurrentDateTime(sources);
    await this.addGoalWhisper(message, sources);
    await this.addRecentChannelMessages(message, sources); // Add immediate channel context
    await this.addRecentGuildMessages(message, sources); // Add broader guild context
    await this.addRelevantMemories(message, sources, capabilityContext);
    if (includeCapabilities) {
      await this.addCapabilityManifest(sources);
    }
    await this.addDiscordEnvironment(sources); // Add Discord server context
    // Future: await this.addUserPreferences(message, sources);

    return sources.filter((source) => source.content.length > 0);
  }

  /**
   * Get conversation history from database
   * Returns last N message pairs for continuity
   */
  private async getConversationHistory(
    userId: string,
    channelId?: string,
    limit: number = 3
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    try {
      const { database } = await import('./database.js');

      // Build query to get recent messages
      let query = `
        SELECT value, user_id, created_at
        FROM messages
        WHERE user_id = ?
      `;
      const params: any[] = [userId];

      // Filter by channel if available (for Discord context)
      if (channelId) {
        query += ` AND channel_id = ?`;
        params.push(channelId);
      }

      query += `
        ORDER BY created_at DESC
        LIMIT ?
      `;
      params.push(limit * 2); // Get pairs (user + assistant)

      const messages = await database.all(query, params);

      if (!messages || messages.length === 0) {
        return [];
      }

      // Convert to message format
      const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];

      for (const msg of messages.reverse()) {
        // Determine if this is user or assistant message
        // Messages from the user have their userId, bot messages might have different logic
        const isUser = msg.user_id === userId;
        history.push({
          role: isUser ? 'user' : 'assistant',
          content: msg.value,
        });
      }

      if (DEBUG && history.length > 0) {
        logger.info(`│ ✅ Loaded ${history.length} messages from conversation history`);
      }

      return history.slice(0, limit * 2); // Return up to N pairs
    } catch (error) {
      logger.warn('Failed to load conversation history:', error);
      return []; // Graceful degradation
    }
  }

  /**
   * Add current date/time to message context (compressed format to save tokens)
   */
  private async addCurrentDateTime(sources: ContextSource[]): Promise<void> {
    const now = new Date();
    // Compressed format: saves ~14 tokens vs verbose format
    const dayName = now.toLocaleDateString('en-US', { weekday: 'short' });
    const timeStr = now.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const tzMatch = now.toLocaleTimeString('en-US', { timeZoneName: 'short' }).match(/\b[A-Z]{3,4}\b/);
    const tz = tzMatch ? tzMatch[0] : 'UTC';

    // Format: "Date: 2025-10-24 13:40 EST (Fri)"
    const content = `Date: ${now.toISOString().split('T')[0]} ${timeStr} ${tz} (${dayName})`;

    sources.push({
      name: 'temporal_context',
      priority: 100, // Always highest priority
      tokenWeight: Math.ceil(content.length / 4),
      content,
      category: 'temporal',
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
          category: 'goals',
        });
      }
    } catch (error) {
      logger.warn('Failed to add goal whisper:', error);
      // Graceful degradation - continue without goal context
    }
  }

  /**
   * Add recent messages from guild (Discord server)
   */
  private async addRecentGuildMessages(
    message: IncomingMessage,
    sources: ContextSource[]
  ): Promise<void> {
    try {
      // Only process if we have Discord context with guildId
      if (!message.context?.guildId) {
        return;
      }

      const guildId = message.context.guildId;
      if (DEBUG) {
        logger.info(`📨 Fetching recent guild messages for guild: ${guildId}`);
      }

      // Import database dynamically
      const { database } = await import('./database.js');

      // Fetch recent messages from this guild (deduplicated)
      const recentGuildMessages = await database.all(
        `
        SELECT DISTINCT value, user_id, created_at
        FROM messages
        WHERE guild_id = ?
          AND user_id != ?
        ORDER BY created_at DESC
        LIMIT 5
      `,
        [guildId, message.userId]
      );

      if (recentGuildMessages && recentGuildMessages.length > 0) {
        const content = `Recent guild activity:\n${recentGuildMessages
          .map((m: any) => `[${m.user_id}]: ${m.value.substring(0, 200)}`)
          .join('\n')}`;

        sources.push({
          name: 'guild_context',
          priority: 60, // Lower than direct memories but still relevant
          tokenWeight: Math.ceil(content.length / 4),
          content,
          category: 'memory',
        });

        if (DEBUG) {
          logger.info(`│ ✅ Found ${recentGuildMessages.length} recent guild messages`);
        }
      }
    } catch (error) {
      logger.warn('Failed to add recent guild messages:', error);
      // Graceful degradation - continue without guild context
    }
  }

  /**
   * Add recent messages from channel
   */
  private async addRecentChannelMessages(
    message: IncomingMessage,
    sources: ContextSource[]
  ): Promise<void> {
    try {
      // Only process if we have Discord context with channelId
      const channelId = message.context?.channelId || message.respondTo?.channelId;
      if (!channelId) {
        return;
      }

      if (DEBUG) {
        logger.info(`📨 Fetching recent channel messages for channel: ${channelId}`);
      }

      // Import database dynamically
      const { database } = await import('./database.js');

      // Fetch recent messages from this channel (deduplicated)
      const recentChannelMessages = await database.all(
        `
        SELECT DISTINCT value, user_id, created_at
        FROM messages
        WHERE channel_id = ?
          AND user_id != ?
        ORDER BY created_at DESC
        LIMIT 10
      `,
        [channelId, message.userId]
      );

      if (recentChannelMessages && recentChannelMessages.length > 0) {
        const content = `Recent channel conversation:\n${recentChannelMessages
          .map((m: any) => `[${m.user_id}]: ${m.value.substring(0, 300)}`)
          .join('\n')}`;

        sources.push({
          name: 'channel_context',
          priority: 80, // Higher priority as it's more immediate context
          tokenWeight: Math.ceil(content.length / 4),
          content,
          category: 'memory',
        });

        if (DEBUG) {
          logger.info(`│ ✅ Found ${recentChannelMessages.length} recent channel messages`);
        }
      }
    } catch (error) {
      logger.warn('Failed to add recent channel messages:', error);
      // Graceful degradation - continue without channel context
    }
  }

  /**
   * Add relevant memories to message context (matches assembleMessagePreamble pattern)
   */
  private async addRelevantMemories(
    message: IncomingMessage,
    sources: ContextSource[],
    capabilityContext?: string[]
  ): Promise<void> {
    try {
      if (DEBUG) {
        logger.info('┌─ MEMORY SEARCH (3-Layer Entourage) ────────────────────────────┐');
      }

      // Enhance search query with capability context for tool-specific memories
      let searchQuery = message.message;
      if (capabilityContext && capabilityContext.length > 0) {
        const capabilityHints = capabilityContext.join(' ');
        searchQuery = `${message.message} [capabilities: ${capabilityHints}]`;
        if (DEBUG) {
          logger.info(`│ 🔧 Enhanced with capability context: ${capabilityHints}`);
        }
      }

      // Calculate available token budget for memory context
      // With 8k total budget, we can afford much richer memory context
      const estimatedOtherTokens = 500; // Conservative estimate for other context
      const maxTokensForMemory = 1200; // Increased from 800 - rich memory context!

      const startTime = Date.now();
      const memoryResult = await this.memoryEntourage.getMemoryContext(
        searchQuery,
        message.userId,
        {
          maxTokens: maxTokensForMemory,
          priority: 'speed', // Default to speed for responsive interactions
          minimal: false,
        }
      );
      const searchTime = Date.now() - startTime;

      // Only add memory context if we actually have useful content
      if (memoryResult.content && memoryResult.content.trim().length > 0) {
        sources.push({
          name: 'memory_context',
          priority: 70,
          tokenWeight: Math.ceil(memoryResult.content.length / 4),
          content: memoryResult.content,
          category: 'memory',
        });

        if (DEBUG) {
          logger.info(`│ ✅ Found ${memoryResult.memoryCount} memories in ${searchTime}ms`);
        }
        if (DEBUG) {
          logger.info(`│ Confidence: ${(memoryResult.confidence * 100).toFixed(1)}%`);
        }
        if (DEBUG) {
          logger.info(`│ Categories: ${memoryResult.categories.join(', ')}`);
        }

        // 🔍 DEBUG: Log memory IDs for backward debugging
        if (memoryResult.memoryIds && memoryResult.memoryIds.length > 0) {
          if (DEBUG) {
            logger.info(`│ Memory IDs: [${memoryResult.memoryIds.join(', ')}]`);
          }
        }

        // Show preview of memory content
        const preview = memoryResult.content.substring(0, 100).replace(/\n/g, ' ');
        if (DEBUG) {
          logger.info(`│ Preview: "${preview}${memoryResult.content.length > 100 ? '...' : ''}"`);
        }
      } else {
        if (DEBUG) {
          logger.info('│ ⚠️  No relevant memories found');
        }
      }
      if (DEBUG) {
        logger.info('└─────────────────────────────────────────────────────────────────┘');
      }
    } catch (error) {
      logger.warn('Failed to add relevant memories:', error);
      // Graceful degradation - continue without memory context
    }
  }

  /**
   * Add capability manifest to message context (COMPRESSED format - saves ~800 tokens!)
   */
  private async addCapabilityManifest(sources: ContextSource[]): Promise<void> {
    try {
      // Use COMPRESSED format: saves ~800 tokens vs full instructions
      // Lists capabilities concisely with format shown once
      const { capabilityRegistry } = await import('./capability-registry.js');
      const content = capabilityRegistry.generateCompressedInstructions();

      sources.push({
        name: 'capability_context',
        priority: 30, // Lower priority - capabilities can be learned
        tokenWeight: Math.ceil(content.length / 4),
        content,
        category: 'capabilities',
      });

      const capCount = capabilityRegistry.size();
      if (DEBUG) {
        logger.info(
          `│ ✅ Added COMPRESSED capability instructions (${capCount} capabilities, ${content.length} chars, saved ~800 tokens)`
        );
      }
    } catch (error) {
      logger.warn('Failed to add capability manifest:', error);
      // Graceful fallback to minimal instructions
      const content = `Use XML format: <capability name="X" action="Y" data='{"param":"value"}' />
Available: web, calculator, memory`;
      sources.push({
        name: 'capability_context',
        priority: 30,
        tokenWeight: Math.ceil(content.length / 4),
        content,
        category: 'capabilities',
      });
    }
  }

  /**
   * Add Discord environment context - available servers and their IDs
   * This helps Coach Artie understand what Discord servers it's connected to
   */
  private async addDiscordEnvironment(sources: ContextSource[]): Promise<void> {
    try {
      // Fetch Discord health info from the health server
      const response = await fetch('http://localhost:47319/health');
      if (!response.ok) {
        if (DEBUG) {
          logger.info('│ ⚠️  Discord health endpoint not available');
        }
        return;
      }

      const health = (await response.json()) as any; // Type as any for flexible health response
      if (!health?.discord?.guildDetails || health.discord.guildDetails.length === 0) {
        if (DEBUG) {
          logger.info('│ ⚠️  No Discord guild details available');
        }
        return;
      }

      // Format guild info for token efficiency: Name (ID: xxx)
      const guildInfo = health.discord.guildDetails
        .map((g: any) => `${g.name} (ID: ${g.id})`)
        .join(', ');

      const content = `Connected Discord servers: ${guildInfo}`;

      sources.push({
        name: 'discord_environment',
        priority: 50, // Between capabilities and memories
        tokenWeight: Math.ceil(content.length / 4),
        content,
        category: 'user_state',
      });

      if (DEBUG) {
        logger.info(
          `│ ✅ Added Discord environment: ${health.discord.guildDetails.length} servers`
        );
      }
    } catch (error) {
      logger.warn('Failed to add Discord environment:', error);
      // Graceful degradation - continue without Discord environment
    }
  }

  /**
   * Select optimal context sources within token budget
   */
  private selectOptimalContext(sources: ContextSource[], budget: ContextBudget): ContextSource[] {
    if (DEBUG) {
      logger.info('┌─ CONTEXT SELECTION (Priority & Budget) ────────────────────────┐');
    }

    // Sort by priority (highest first)
    const sortedSources = [...sources].sort((a, b) => b.priority - a.priority);

    const selected: ContextSource[] = [];
    let usedTokens = 0;

    for (const source of sortedSources) {
      if (usedTokens + source.tokenWeight <= budget.availableForContext) {
        selected.push(source);
        usedTokens += source.tokenWeight;
        if (DEBUG) {
          logger.info(
            `│ ✅ SELECTED: ${source.name.padEnd(20)} (${source.tokenWeight} tokens, pri: ${source.priority})`
          );
        }
      } else {
        if (DEBUG) {
          logger.info(
            `│ ❌ SKIPPED:  ${source.name.padEnd(20)} (${source.tokenWeight} tokens would exceed budget)`
          );
        }
      }
    }

    if (DEBUG) {
      logger.info(`│ ═══════════════════════════════════════════════════════════════ │`);
    }
    if (DEBUG) {
      logger.info(
        `│ Token usage: ${usedTokens}/${budget.availableForContext} (${Math.round((usedTokens / budget.availableForContext) * 100)}% of budget)`
      );
    }
    if (DEBUG) {
      logger.info('└─────────────────────────────────────────────────────────────────┘');
    }

    return selected;
  }

  /**
   * Assemble message chain with intelligent context placement
   * Now includes conversation history for natural dialogue!
   */
  private assembleMessageChain(
    baseSystemPrompt: string,
    userMessage: string,
    contextSources: ContextSource[],
    existingMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [],
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []
  ): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    if (DEBUG) {
      logger.info('┌─ MESSAGE CHAIN ASSEMBLY ────────────────────────────────────────┐');
    }

    const contextByCategory = this.groupContextByCategory(contextSources);
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

    // 1. System message with temporal context + capabilities
    let systemContent = baseSystemPrompt;
    if (contextByCategory.temporal.length > 0) {
      systemContent = `${contextByCategory.temporal[0].content}\n\n${systemContent}`;
    }
    if (contextByCategory.capabilities.length > 0) {
      systemContent += `\n\n${contextByCategory.capabilities[0].content}`;
    }

    messages.push({ role: 'system', content: systemContent.trim() });

    // 2. Add contextual information as system message (cleaner than fake user messages!)
    if (contextByCategory.memory.length > 0 || contextByCategory.goals.length > 0 || contextByCategory.user_state.length > 0) {
      let contextContent = 'Relevant context:\n';

      if (contextByCategory.memory.length > 0) {
        contextContent += `${contextByCategory.memory[0].content}\n`;
      }
      if (contextByCategory.goals.length > 0) {
        contextContent += `${contextByCategory.goals[0].content}\n`;
      }
      if (contextByCategory.user_state.length > 0) {
        contextContent += `${contextByCategory.user_state[0].content}`;
      }

      messages.push({ role: 'system', content: contextContent.trim() });
    }

    // 3. Add conversation history (this is the game-changer!)
    if (conversationHistory.length > 0) {
      if (DEBUG) {
        logger.info(`│ 💬 Adding ${conversationHistory.length} messages from conversation history`);
      }
      messages.push(...conversationHistory);
    }

    // 4. Add any existing conversation history from the caller
    messages.push(...existingMessages);

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
      user_state: [],
    };

    for (const source of sources) {
      grouped[source.category].push(source);
    }

    return grouped;
  }
}

// Export singleton
export const contextAlchemy = ContextAlchemy.getInstance();
