import { logger } from '@coachartie/shared';
import { conscienceLLM } from './conscience.js';
import { IncomingMessage } from '@coachartie/shared';
import { MemoryEntourageInterface } from './memory-entourage-interface.js';
import { CombinedMemoryEntourage } from './combined-memory-entourage.js';
import { CreditMonitor } from './credit-monitor.js';

// Vision and metro-doctor capabilities - these are optional/WIP features
// Disabled until files are implemented
const visionCapability: { execute: (opts: any) => Promise<string> } | null = null;
const processMetroAttachment: ((url: string) => Promise<{ stdout: string; stderr?: string }>) | null = null;

// Debug flag for detailed Context Alchemy logging
const DEBUG = process.env.CONTEXT_ALCHEMY_DEBUG === 'true';

// UI Modality Rules - loaded from database at runtime
// Legacy fallback for backward compatibility
const UI_MODALITY_RULES_FALLBACK = `
🎮 DISCORD FORMATTING & UI RULES:

FORMATTING FOR DISCORD:
- Use **bold** for emphasis and headings (NOT ### headers - they don't render in Discord!)
- Use *italic* for subtle emphasis
- Use \`code\` for inline code, commands, or file paths
- Use \`\`\`language for code blocks with syntax highlighting
- Use > for quotes (single line only)
- Use bullet points (- or •) for lists
- Keep responses conversational and scannable
- Break long responses into short paragraphs
- AVOID: ### headers, long paragraphs, walls of text

DISCORD UI COMPONENTS - USE WHEN APPROPRIATE:

CHOICE SCENARIO → USE BUTTONS:
When the user must pick ONE from 2-3 equally-valid options (e.g., "Yes/No/Maybe", "Morning/Afternoon/Evening")
Use: <capability name="discord-ui" action="buttons" data='[{"label":"Option 1","style":"primary"},{"label":"Option 2","style":"secondary"}]' />

COMPARISON SCENARIO → USE SELECT MENU:
When comparing 3+ alternatives where user needs to evaluate tradeoffs (e.g., "Python vs JavaScript vs Go")
Use: <capability name="discord-ui" action="select" data='{"placeholder":"Choose...","options":[{"label":"Python","value":"python"},{"label":"JavaScript","value":"js"}]}' />

STRUCTURED INPUT → USE MODAL:
When you need multiple fields from the user (name, email, preferences, settings)
Use: <capability name="discord-ui" action="modal" data='{"title":"User Form","inputs":[{"label":"Name","customId":"name_field","required":true}]}' />

INFORMATION DELIVERY → STAY IN CHAT:
When explaining, answering questions, or providing information (no user choice needed)

⚠️ IMPORTANT: Format responses for Discord readability. Use **bold** instead of ### headers. Keep it concise.
`;

// Slack UI Modality Rules - loaded from database at runtime
// Legacy fallback for backward compatibility
const SLACK_UI_MODALITY_RULES_FALLBACK = `
💬 SLACK INTERACTION GUIDELINES:

SLACK CONTEXT AWARENESS:
You are currently in a Slack workspace. Slack has different UI capabilities than Discord.

FORMATTING FOR SLACK:
- Use *bold* for emphasis
- Use _italic_ for subtle emphasis
- Use \`code\` for inline code
- Use \`\`\`code blocks\`\`\` for multi-line code
- Use > for quotes
- Use • or - for bullet points

MESSAGE THREADING:
- Slack conversations often happen in threads
- Keep responses concise and focused
- Use threads to organize longer conversations

SLACK-SPECIFIC FEATURES:
- Reactions: Users can react with emoji
- Mentions: Use @username to mention users
- Channels: Messages in channels are visible to all members

⚠️ IMPORTANT: Format your responses for optimal Slack readability. Be concise and use Slack markdown formatting.
`;

interface ContextSource {
  name: string;
  priority: number;
  tokenWeight: number;
  content: string;
  category: 'temporal' | 'goals' | 'memory' | 'capabilities' | 'user_state' | 'evidence' | 'system';
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
    options: {
      minimal?: boolean;
      capabilityContext?: string[];
      channelId?: string;
      includeCapabilities?: boolean;
      source?: string;
      // Discord channel history - source of truth for DMs (includes webhook/n8n messages)
      discordChannelHistory?: Array<{
        author: string;
        content: string;
        timestamp: string;
        isBot: boolean;
      }>;
    } = {}
  ): Promise<{
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    contextSources: ContextSource[];
  }> {
    if (DEBUG) {
      logger.info(
        `🧪 Context Alchemy: user=${userId}, mode=${options.minimal ? 'minimal' : 'full'}, msg_len=${userMessage.length}`
      );
    }

    let selectedContext: ContextSource[] = [];
    let conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    if (!options.minimal) {
      // 1. Calculate token budget
      const budget = this.calculateTokenBudget(userMessage, baseSystemPrompt);

      // 2. Load conversation history (if available)
      // Scale conversation history with context window size (minimum 2 pairs, scales up)
      const contextSize = parseInt(process.env.CONTEXT_WINDOW_SIZE || '32000', 10);
      const historyLimit = Math.max(2, Math.floor((contextSize / 8000) * 3));

      // Prefer Discord channel history when available (source of truth - includes webhook/n8n messages)
      if (options.discordChannelHistory && options.discordChannelHistory.length > 0) {
        conversationHistory = this.convertDiscordHistoryToMessages(
          options.discordChannelHistory,
          historyLimit
        );
        if (DEBUG) {
          logger.info(
            `│ 📜 Using Discord channel history (${conversationHistory.length} messages)`
          );
        }
      } else {
        conversationHistory = await this.getConversationHistory(
          userId,
          options.channelId,
          historyLimit
        );
      }

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

    // 4.5. Check credit status and add warnings if needed (both for Artie and user)
    await this.addCreditWarnings(selectedContext);

    // 5. Build message chain with conversation history
    const messageChain = await this.assembleMessageChain(
      baseSystemPrompt,
      userMessage,
      selectedContext,
      existingMessages,
      conversationHistory,
      options.source
    );

    if (DEBUG) {
      logger.info(
        `📝 Message chain: ${messageChain.length} messages (${messageChain.filter((m) => m.role === 'system').length} system, ${messageChain.filter((m) => m.role === 'user').length} user, ${messageChain.filter((m) => m.role === 'assistant').length} assistant)`
      );
    }

    // Calculate total tokens for percentage display
    const totalContextTokens = selectedContext.reduce((sum, ctx) => sum + ctx.tokenWeight, 0);

    if (DEBUG) {
      logger.info('🧪 CONTEXT SOURCES:');
      selectedContext.forEach((ctx) => {
        const percentage =
          totalContextTokens > 0
            ? ((ctx.tokenWeight / totalContextTokens) * 100).toFixed(1)
            : '0.0';
        logger.info(
          `  ${ctx.name.padEnd(22)}: ${percentage.padStart(5)}% (${ctx.tokenWeight.toString().padStart(4)} tokens, pri:${ctx.priority})`
        );
      });
      logger.info(
        `  ${'TOTAL'.padEnd(22)}: 100.0% (${totalContextTokens.toString().padStart(4)} tokens)`
      );
      logger.info(
        `✅ Context ready: ${messageChain.length} messages, ${selectedContext.length} sources\n`
      );
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

    // Load from database with fallback
    try {
      const { promptManager } = await import('./prompt-manager.js');
      const synthesisTemplate = await promptManager.getPrompt('PROMPT_CAPABILITY_SYNTHESIS');

      if (synthesisTemplate) {
        // Replace template variables
        return synthesisTemplate.content
          .replace(/\{\{USER_MESSAGE\}\}/g, originalMessage)
          .replace(/\{\{CAPABILITY_RESULTS\}\}/g, capabilityResults);
      }
    } catch (error) {
      logger.warn('Failed to load synthesis prompt from database, using fallback');
    }

    // Fallback prompt
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
    // Configurable context window size - defaults to 32k for modern models
    const totalTokens = parseInt(process.env.CONTEXT_WINDOW_SIZE || '32000', 10);
    const reservedForResponse = Math.floor(totalTokens * 0.25); // Reserve 25% for response

    const availableForContext = totalTokens - userTokens - systemTokens - reservedForResponse;

    const budget = {
      totalTokens,
      reservedForUser: userTokens,
      reservedForSystem: systemTokens,
      availableForContext: Math.max(0, availableForContext),
    };

    if (DEBUG) {
      logger.info(
        `💰 Token budget: ${totalTokens} total, ${budget.availableForContext} available for context (user:${userTokens}, system:${systemTokens}, reply:${reservedForResponse})`
      );
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

    // Current date/time - temporal awareness
    await this.addCurrentDateTime(sources);

    // Discord situational awareness - explicit "where am I" context
    await this.addDiscordSituationalAwareness(message, sources);

    // Reply context - the message being replied to (if any)
    await this.addReplyContext(message, sources);

    // Attachment context (includes URLs for vision/OCR or user follow-up)
    await this.addAttachmentContext(message, sources);

    // Slack situational awareness - explicit "where am I" context for Slack
    await this.addSlackSituationalAwareness(message, sources);

    // Goal whisper from Conscience - high-level intent/guidance
    await this.addGoalWhisper(message, sources);

    // Channel vibes - activity level, response style hints ("the vibes of the room")
    await this.addChannelVibes(message, sources);

    // Recent channel messages - immediate conversational context (what just happened)
    await this.addRecentChannelMessages(message, sources);

    // Recent guild messages - broader Discord server context (what's happening elsewhere)
    await this.addRecentGuildMessages(message, sources);

    // Relevant memories - long-term context from memory system (what we remember)
    await this.addRelevantMemories(message, sources, capabilityContext);

    // Capability learnings - only loaded when we know which capabilities are actually being executed
    // (not during initial context building - that's wasteful)
    // These get loaded later in the orchestration flow after extraction + conscience review
    // await this.addCapabilityLearnings(message, sources, capabilityContext);

    // Capability manifest - available tools/actions (how to do things)
    if (includeCapabilities) {
      await this.addCapabilityManifest(sources);
    }

    // Discord environment - connected servers (where we are)
    await this.addDiscordEnvironment(sources);

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

      // Human-like memory: blend channel-specific + global context
      // 70% from current channel, 30% from anywhere (like human recollection)
      const channelLimit = Math.ceil(limit * 0.7);
      const globalLimit = Math.floor(limit * 0.3);

      const allMessages: any[] = [];

      // Get recent messages from current channel (immediate context)
      if (channelId) {
        const channelQuery = `
          SELECT value, user_id, created_at, 'channel' as source
          FROM messages
          WHERE user_id = ? AND channel_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        `;
        const channelMessages = await database.all(channelQuery, [
          userId,
          channelId,
          channelLimit * 2,
        ]);
        allMessages.push(...channelMessages);
      }

      // Get some recent messages from ALL channels (cross-context awareness)
      const globalQuery = `
        SELECT value, user_id, created_at, 'global' as source
        FROM messages
        WHERE user_id = ?
        ${channelId ? 'AND channel_id != ?' : ''}
        ORDER BY created_at DESC
        LIMIT ?
      `;
      const globalParams = channelId
        ? [userId, channelId, globalLimit * 2]
        : [userId, globalLimit * 2];
      const globalMessages = await database.all(globalQuery, globalParams);
      allMessages.push(...globalMessages);

      // Sort all messages by recency
      allMessages.sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );

      // Take the limit
      const messages = allMessages.slice(0, limit * 2);

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
   * Convert Discord channel history to message format
   * Discord history is the source of truth - includes webhook/n8n messages
   */
  private convertDiscordHistoryToMessages(
    discordHistory: Array<{
      author: string;
      content: string;
      timestamp: string;
      isBot: boolean;
    }>,
    limit: number
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    // Discord history comes in chronological order (oldest first)
    // Take the most recent messages up to limit * 2 (pairs)
    const recentHistory = discordHistory.slice(-(limit * 2));

    return recentHistory
      .filter((msg) => msg.content && msg.content.trim().length > 0)
      .map((msg) => ({
        // Bot messages (including webhook/n8n) are assistant, human messages are user
        role: msg.isBot ? ('assistant' as const) : ('user' as const),
        content: msg.content,
      }));
  }

  /**
   * Add credit warnings if balance is low (for both Artie's awareness and user notification)
   */
  private async addCreditWarnings(sources: ContextSource[]): Promise<void> {
    try {
      const creditMonitor = CreditMonitor.getInstance();
      const [creditInfo, alerts] = await Promise.all([
        creditMonitor.getCurrentBalance(),
        creditMonitor.getActiveAlerts(),
      ]);

      // Build credit warning message if we have alerts or low balance
      const warningParts: string[] = [];

      // Add active alerts
      if (alerts.length > 0) {
        warningParts.push(...alerts.map((a) => a.message));
      }

      // Add balance info if available
      if (creditInfo?.credits_remaining !== undefined) {
        const balance = creditInfo.credits_remaining;

        // Critical warning (<$5)
        if (balance < 5) {
          warningParts.push(
            `🤖💸 "I'm faddddingggg..." - Only $${balance.toFixed(2)} credits left!`
          );
          warningParts.push(
            '⚡ SWITCH TO CHEAPER MODELS IMMEDIATELY (use Haiku/Gemini Flash for non-critical tasks)'
          );
        }
        // Warning (<$25)
        else if (balance < 25) {
          warningParts.push(`⚠️ Low credit balance: $${balance.toFixed(2)} remaining`);
          warningParts.push('💡 Consider using cheaper models for simple tasks');
        }
        // Info (just show balance if we have it)
        else {
          warningParts.push(`💰 Current balance: $${balance.toFixed(2)}`);
        }
      }

      // Add daily spend warning if high
      if (creditInfo?.daily_spend !== undefined && creditInfo.daily_spend > 10) {
        warningParts.push(`📊 Today's spend: $${creditInfo.daily_spend.toFixed(2)}`);
      }

      // Only add to context if we have warnings
      if (warningParts.length > 0) {
        const content = warningParts.join('\n');

        sources.push({
          name: 'credit_status',
          priority: 95, // Very high priority - Artie needs to know this!
          tokenWeight: Math.ceil(content.length / 4),
          content,
          category: 'user_state',
        });

        if (DEBUG || (creditInfo?.credits_remaining && creditInfo.credits_remaining < 25)) {
          logger.warn(`💰 Credit warning added to context: ${warningParts[0]}`);
        }
      }
    } catch (error) {
      logger.warn('Failed to add credit warnings:', error);
      // Graceful degradation - continue without credit warnings
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
      hour12: false,
    });
    const tzMatch = now
      .toLocaleTimeString('en-US', { timeZoneName: 'short' })
      .match(/\b[A-Z]{3,4}\b/);
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
   * Add explicit Discord situational awareness - tells the LLM WHERE it is
   * "You are in Discord server X, channel #Y, talking to @user"
   */
  private async addDiscordSituationalAwareness(
    message: IncomingMessage,
    sources: ContextSource[]
  ): Promise<void> {
    // Only for Discord messages with context
    const ctx = message.context;
    if (!ctx || message.source !== 'discord') {
      return;
    }

    const parts: string[] = [];

    // Location: Server + Channel
    if (ctx.guildName && ctx.channelName) {
      parts.push(`📍 Discord server "${ctx.guildName}" in #${ctx.channelName}`);
    } else if (ctx.channelName) {
      parts.push(`📍 Discord DM or channel: #${ctx.channelName}`);
    }

    // User info
    if (ctx.displayName || ctx.username) {
      const displayName = ctx.displayName || ctx.username;
      parts.push(`👤 Talking to: @${displayName}`);
    }

    // Forum thread context (if applicable)
    if (ctx.isForumThread && ctx.threadName) {
      parts.push(`💬 Forum thread: "${ctx.threadName}"`);
    }

    // Mentions (if any)
    if (ctx.mentions && ctx.mentions.length > 0) {
      const mentionNames = ctx.mentions.map((m: any) => `@${m.displayName || m.username}`).join(', ');
      parts.push(`🏷️  Mentions: ${mentionNames}`);
    }

    // Build final content
    if (parts.length > 0) {
      const content = parts.join('\n');

      sources.push({
        name: 'discord_situational',
        priority: 98, // Very high - right after temporal
        tokenWeight: Math.ceil(content.length / 4),
        content,
        category: 'user_state',
      });

      if (DEBUG) {
        logger.info(`│ ✅ Added Discord situational awareness: ${ctx.guildName || 'DM'}/#${ctx.channelName}`);
      }
    }
  }

  /**
   * Add reply context - the message being replied to
   * Helps the LLM understand what the user is responding to
   */
  private async addReplyContext(
    message: IncomingMessage,
    sources: ContextSource[]
  ): Promise<void> {
    const ctx = message.context;
    if (!ctx || !ctx.replyContext) {
      return;
    }

    const reply = ctx.replyContext;
    const content = `💬 Replying to @${reply.author}: "${reply.content}"`;

    sources.push({
      name: 'reply_context',
      priority: 97, // Very high priority - directly relevant to understanding the conversation
      tokenWeight: Math.ceil(content.length / 4),
      content,
      category: 'user_state',
    });

    if (DEBUG) {
      logger.info(
        `│ ✅ Added reply context: @${reply.author} - "${reply.content.substring(0, 50)}..."`
      );
    }
  }

  /**
   * Add explicit Slack situational awareness - tells the LLM WHERE it is
   * "You are in Slack channel #X, talking to @user"
   */
  private async addSlackSituationalAwareness(
    message: IncomingMessage,
    sources: ContextSource[]
  ): Promise<void> {
    // Only for Slack messages with context
    const ctx = message.context;
    if (!ctx || (message.source !== 'slack' && ctx.platform !== 'slack')) {
      return;
    }

    const parts: string[] = [];

    // Location: Channel ID and type
    if (ctx.channelId) {
      const channelType = ctx.channelType || 'channel';
      if (channelType === 'im') {
        parts.push(`📍 Slack direct message`);
      } else if (channelType === 'mpim') {
        parts.push(`📍 Slack group direct message`);
      } else {
        parts.push(`📍 Slack channel (${ctx.channelId})`);
      }
    }

    // User info
    if (ctx.username) {
      parts.push(`👤 Talking to: @${ctx.username}`);
    }

    // Thread context (if applicable)
    if (ctx.isThread && ctx.threadTs) {
      parts.push(`💬 Thread conversation (ts: ${ctx.threadTs})`);
    }

    // Build final content
    if (parts.length > 0) {
      const content = parts.join('\n');

      sources.push({
        name: 'slack_situational',
        priority: 98, // Very high - right after temporal
        tokenWeight: Math.ceil(content.length / 4),
        content,
        category: 'user_state',
      });

      if (DEBUG) {
        logger.info(`│ ✅ Added Slack situational awareness: ${ctx.channelType || 'channel'}/${ctx.channelId}`);
      }
    }
  }

  /**
   * Attachment context (URLs and metadata). Encourages vision/OCR or user-provided text.
   */
  private async addAttachmentContext(
    message: IncomingMessage,
    sources: ContextSource[]
  ): Promise<void> {
    const currentAttachments = Array.isArray(message.context?.attachments)
      ? message.context.attachments
      : [];
    const recentAttachments = Array.isArray(message.context?.recentAttachments)
      ? message.context.recentAttachments
      : [];
    const recentUrls = Array.isArray(message.context?.recentUrls)
      ? message.context.recentUrls
      : [];

    const attachments = [...currentAttachments, ...recentAttachments].filter((att) => !!att?.url);

    if (attachments.length > 0) {
      const lines: string[] = [];
      lines.push(`📎 Attachments detected (${attachments.length})`);

      const seen = new Set<string>();
      attachments.slice(0, 8).forEach((att: any, idx: number) => {
        const url = att.url || att.proxyUrl;
        if (!url || seen.has(url)) return;
        seen.add(url);

        const label = att.name || att.id || `attachment-${idx + 1}`;
        const type = att.contentType ? ` (${att.contentType})` : '';
        const from = att.author ? ` by ${att.author}` : '';
        lines.push(`- ${label}${type}${from}: ${url}`);
      });

      if (attachments.length > 8) {
        lines.push(`…and ${attachments.length - 8} more (see context)`);
      }

      lines.push(
        'Vision/OCR recommended: call the vision capability with these URLs to extract text/entities, or ask the user to paste the text if vision is unavailable.'
      );

      const content = lines.join('\n');

      sources.push({
        name: 'attachments',
        priority: 95, // High, near reply context
        tokenWeight: Math.ceil(content.length / 4),
        content,
        category: 'user_state',
      });
    }

    // Optional: auto vision extraction
    const autoVision =
      (process.env.AUTO_VISION_EXTRACT || 'true').toLowerCase() !== 'false' &&
      !!process.env.OPENROUTER_API_KEY &&
      visionCapability !== null;

    if (autoVision && attachments.length > 0) {
      const urls = attachments
        .map((att: any) => att.url || att.proxyUrl)
        .filter((u: any) => typeof u === 'string')
        .slice(0, 3); // cap auto-processing

      if (urls.length > 0) {
        try {
          const visionResult = await visionCapability!.execute({
            action: 'extract',
            urls,
            objective: 'Extract text and key entities (names, emails, links) from recent attachments.',
          } as any);

          // Trim if very long to avoid context bloat
          const MAX_VISION_CHARS = 2000;
          const truncated =
            visionResult.length > MAX_VISION_CHARS
              ? visionResult.slice(0, MAX_VISION_CHARS) + '\n…[truncated]'
              : visionResult;

          sources.push({
            name: 'attachments_vision',
            priority: 90, // slightly below attachment listing, above memories
            tokenWeight: Math.ceil(truncated.length / 4),
            content: truncated,
            category: 'evidence',
          });
        } catch (error: any) {
          const msg = `Vision auto-extract failed: ${error?.message || String(error)}`;
          sources.push({
            name: 'attachments_vision_error',
            priority: 60,
            tokenWeight: Math.ceil(msg.length / 4),
            content: msg,
            category: 'system',
          });
          logger.warn(msg);
        }
      }
    }

    // Optional: auto metro doctor for .metro files
    const metroAttachments = attachments.filter((att: any) =>
      typeof att.name === 'string' ? att.name.toLowerCase().endsWith('.metro') : false
    );
    const autoMetro =
      (process.env.AUTO_METRO_DOCTOR || 'true').toLowerCase() !== 'false' &&
      processMetroAttachment !== null;

    if (autoMetro && metroAttachments.length > 0) {
      const first = metroAttachments[0];
      const url = first.url || first.proxyUrl;
      if (url) {
        try {
          const result = await processMetroAttachment!(url);

          const MAX_METRO_CHARS = 2000;
          const trimmed =
            result.stdout.length > MAX_METRO_CHARS
              ? result.stdout.slice(0, MAX_METRO_CHARS) + '\n…[truncated]'
              : result.stdout;

          const content = [
            '🩺 Metro savefile doctor (auto)',
            `File: ${first.name || first.id || url}`,
            trimmed,
            result.stderr ? `Stderr: ${result.stderr.slice(0, 500)}` : '',
          ]
            .filter(Boolean)
            .join('\n');

          sources.push({
            name: 'metro_doctor',
            priority: 88, // below vision/link previews, above memory
            tokenWeight: Math.ceil(content.length / 4),
            content,
            category: 'evidence',
          });
        } catch (error: any) {
          const msg = `Metro doctor failed: ${error?.message || String(error)}`;
          sources.push({
            name: 'metro_doctor_error',
            priority: 60,
            tokenWeight: Math.ceil(msg.length / 4),
            content: msg,
            category: 'system',
          });
          logger.warn(msg);
        }
      }
    }

    // URLs from recent Discord context (non-attachments)
    if (recentUrls.length > 0) {
      const urlList = recentUrls.slice(0, 3);
      const lines = ['🔗 Recent URLs:', ...urlList.map((u: any) => `- ${u}`)];
      const content = lines.join('\n');
      sources.push({
        name: 'recent_urls',
        priority: 85,
        tokenWeight: Math.ceil(content.length / 4),
        content,
        category: 'evidence',
      });

      const autoLinkFetch =
        (process.env.AUTO_LINK_FETCH || 'true').toLowerCase() !== 'false';

      if (autoLinkFetch) {
        const previews: string[] = [];
        for (const url of urlList) {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 4000);
            const resp = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);

            const contentType = resp.headers.get('content-type') || '';
            if (!resp.ok) {
              previews.push(`🔗 ${url}\n⚠️ Fetch failed: ${resp.status} ${resp.statusText}`);
              continue;
            }
            if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
              previews.push(`🔗 ${url}\n(ignored non-text content-type: ${contentType})`);
              continue;
            }

            const text = await resp.text();
            const MAX_CHARS = 2000;
            const trimmed = text.slice(0, MAX_CHARS);

            const titleMatch = trimmed.match(/<title>([^<]{0,200})<\/title>/i);
            const title = titleMatch ? titleMatch[1].trim() : '';

            const plain = trimmed
              .replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 600);

            const summary = title
              ? `Title: ${title}\nPreview: ${plain || '(empty)'}`
              : `Preview: ${plain || '(empty)'}`;

            previews.push(`🔗 ${url}\n${summary}`);
          } catch (error: any) {
            previews.push(`🔗 ${url}\n⚠️ Fetch failed: ${error?.message || String(error)}`);
          }
        }

        if (previews.length > 0) {
          const content = ['🔎 Auto link previews (recent URLs):', ...previews].join('\n\n');
          sources.push({
            name: 'recent_urls_auto',
            priority: 84, // just below the URL list
            tokenWeight: Math.ceil(content.length / 4),
            content,
            category: 'evidence',
          });
        }
      }
    }
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
   * Add channel vibes - the social context of the room
   * Helps the LLM understand channel activity, type, and adjust response style
   * Works for both Discord and Slack
   */
  private async addChannelVibes(
    message: IncomingMessage,
    sources: ContextSource[]
  ): Promise<void> {
    try {
      // Only for Discord or Slack messages with context
      const messageContext = message.context;
      if (!messageContext || (message.source !== 'discord' && message.source !== 'slack' && messageContext.platform !== 'slack')) {
        return;
      }

      // Import database for recent activity check
      const { database } = await import('./database.js');

      const channelId = messageContext.channelId;
      const channelName = messageContext.channelName || messageContext.channelId || 'unknown';
      const channelType = messageContext.channelType || 'text';
      const platform = message.source === 'slack' || messageContext.platform === 'slack' ? 'Slack' : 'Discord';

      // Get recent activity in this channel (last 10 minutes)
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const recentActivity = await database.all(
        `SELECT COUNT(*) as count FROM messages
         WHERE channel_id = ? AND created_at > ?`,
        [channelId, tenMinutesAgo]
      );

      // Get Artie's recent usage in this channel (last hour)
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const artieUsage = await database.all(
        `SELECT COUNT(*) as count FROM messages
         WHERE channel_id = ? AND created_at > ? AND user_id = 'artie'`,
        [channelId, oneHourAgo]
      );

      const messageCount = recentActivity[0]?.count || 0;
      const artieCount = artieUsage[0]?.count || 0;

      // Determine channel activity level
      let activityLevel = 'quiet';
      if (messageCount > 20) activityLevel = 'very busy';
      else if (messageCount > 10) activityLevel = 'busy';
      else if (messageCount > 3) activityLevel = 'moderate';

      // Build vibes context (ONLY dynamic channel-specific info)
      // Static delivery instructions belong in PROMPT_SYSTEM database prompt
      const vibes = [
        `CHANNEL CONTEXT:`,
        `- Platform: ${platform}`,
        `- Name: ${channelName}`,
        `- Type: ${channelType}`,
        `- Activity: ${activityLevel} (${messageCount} msgs in last 10 min)`,
        `- Your recent usage: ${artieCount} responses in last hour`
      ];

      const content = vibes.join('\n');

      sources.push({
        name: 'channel_vibes',
        priority: 95, // High priority - affects response style
        tokenWeight: Math.ceil(content.length / 4),
        content,
        category: 'user_state',
      });

      if (DEBUG) {
        logger.info(`│ ✅ Channel vibes (${platform}): ${channelName} (${activityLevel}, ${messageCount} recent msgs)`);
      }
    } catch (error) {
      logger.warn('Failed to add channel vibes:', error);
      // Graceful degradation - continue without vibes
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
      // Enhance search query with capability context for tool-specific memories
      let searchQuery = message.message;
      if (capabilityContext && capabilityContext.length > 0) {
        const capabilityHints = capabilityContext.join(' ');
        searchQuery = `${message.message} [capabilities: ${capabilityHints}]`;
        if (DEBUG) {
          logger.info(`🔧 Enhanced memory search with capability context: ${capabilityHints}`);
        }
      }

      // Calculate available token budget for memory context
      const contextSize = parseInt(process.env.CONTEXT_WINDOW_SIZE || '32000', 10);
      const maxTokensForMemory = Math.max(800, Math.floor(contextSize * 0.15)); // Minimum 800, scales with context

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
          logger.info(
            `🧠 Memory search: ${memoryResult.memoryCount} memories found in ${searchTime}ms (confidence:${(memoryResult.confidence * 100).toFixed(1)}%, categories:${memoryResult.categories.join(',')})`
          );
        }
      } else {
        if (DEBUG) {
          logger.info('🧠 Memory search: no relevant memories found');
        }
      }
    } catch (error) {
      logger.warn('Failed to add relevant memories:', error);
      // Graceful degradation - continue without memory context
    }
  }

  /**
   * Add capability-specific learnings when using capabilities
   * Retrieves reflections from past tool usage to improve execution
   */
  private async addCapabilityLearnings(
    message: IncomingMessage,
    sources: ContextSource[],
    capabilityNames?: string[]
  ): Promise<void> {
    try {
      // Only fetch capability learnings if we know which capabilities are being used
      if (!capabilityNames || capabilityNames.length === 0) {
        return;
      }

      const { MemoryService } = await import('../capabilities/memory.js');
      const memoryService = MemoryService.getInstance();

      // Retrieve memories tagged with capability names
      const tags = [...capabilityNames, 'capability-reflection'];
      const capabilityMemories = await memoryService.recallByTags(message.userId, tags, 5);

      if (capabilityMemories.length > 0) {
        // Format capability learnings for context
        const learningsContent = `📚 Capability Learnings (from past usage):

${capabilityMemories
  .map(
    (memory, i) =>
      `${i + 1}. [${memory.tags.filter((t) => t !== 'capability-reflection').join(', ')}] ${memory.content}`
  )
  .join('\n\n')}

💡 Use these learnings to improve your capability usage. Remember what worked, what didn't, and apply those lessons!`;

        sources.push({
          name: 'capability_learnings',
          priority: 85, // High priority - directly relevant to task execution
          tokenWeight: Math.ceil(learningsContent.length / 4),
          content: learningsContent,
          category: 'memory',
        });

        if (DEBUG) {
          logger.info(
            `🔧 Capability learnings: ${capabilityMemories.length} found for ${capabilityNames.join(',')}`
          );
        }
      } else {
        if (DEBUG) {
          logger.info(
            `🔧 Capability learnings: none found for ${capabilityNames.join(',')} (first time?)`
          );
        }
      }
    } catch (error) {
      logger.warn('Failed to add capability learnings:', error);
      // Graceful degradation - continue without capability learnings
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
      // Use DISCORD_HEALTH_URL env var, fallback to localhost for local dev, docker hostname for containers
      const discordHealthUrl = process.env.DISCORD_HEALTH_URL ||
        (process.env.DOCKER_ENV ? 'http://discord:47319/health' : 'http://localhost:47319/health');
      const response = await fetch(discordHealthUrl);
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
   * Only includes Discord UI modality rules when message source is 'discord'
   */
  private async assembleMessageChain(
    baseSystemPrompt: string,
    userMessage: string,
    contextSources: ContextSource[],
    existingMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [],
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [],
    source?: string
  ): Promise<Array<{ role: 'system' | 'user' | 'assistant'; content: string }>> {
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

    // Add UI modality rules for Discord messages (from database)
    if (source === 'discord') {
      try {
        const { promptManager } = await import('./prompt-manager.js');
        const uiPrompt = await promptManager.getPrompt('PROMPT_DISCORD_UI_MODALITY');
        const uiRules = uiPrompt?.content || UI_MODALITY_RULES_FALLBACK;
        systemContent += `\n\n${uiRules}`;
      } catch (error) {
        logger.warn('Failed to load Discord UI modality prompt, using fallback');
        systemContent += `\n\n${UI_MODALITY_RULES_FALLBACK}`;
      }
    }

    // Add UI modality rules for Slack messages (from database)
    if (source === 'slack') {
      try {
        const { promptManager } = await import('./prompt-manager.js');
        const slackPrompt = await promptManager.getPrompt('PROMPT_SLACK_UI_MODALITY');
        const slackRules = slackPrompt?.content || SLACK_UI_MODALITY_RULES_FALLBACK;
        systemContent += `\n\n${slackRules}`;
        if (DEBUG) {
          logger.info('│ ✅ Added Slack UI modality rules to system prompt');
        }
      } catch (error) {
        logger.warn('Failed to load Slack UI modality prompt, using fallback');
        systemContent += `\n\n${SLACK_UI_MODALITY_RULES_FALLBACK}`;
      }
    }

    messages.push({ role: 'system', content: systemContent.trim() });

    // 2. Add contextual information as system message (cleaner than fake user messages!)
    if (
      contextByCategory.memory.length > 0 ||
      contextByCategory.goals.length > 0 ||
      contextByCategory.user_state.length > 0
    ) {
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
