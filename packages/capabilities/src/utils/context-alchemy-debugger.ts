import { logger } from '@coachartie/shared';

/**
 * Context Alchemy Debugger
 *
 * Provides detailed debugging output for understanding how Context Alchemy
 * assembles context and affects responses. Can be toggled via environment variable.
 */

export interface ContextDebugInfo {
  userId: string;
  messageLength: number;
  tokensUsed: number;
  tokensAvailable: number;
  sourcesIncluded: string[];
  fusionPattern?: string;
  memoryLayerResults?: {
    keyword: number;
    semantic: number;
    temporal: number;
  };
  messageChain: Array<{
    role: string;
    contentPreview: string;
    length: number;
  }>;
  timings: {
    memorySearch?: number;
    contextAssembly?: number;
    total: number;
  };
}

export class ContextAlchemyDebugger {
  private static instance: ContextAlchemyDebugger;
  private debugMode: boolean;
  private currentSession: ContextDebugInfo | null = null;
  private sessionStartTime: number = 0;

  constructor() {
    // Enable debug mode via environment variable
    this.debugMode = process.env.CONTEXT_ALCHEMY_DEBUG === 'true';
  }

  static getInstance(): ContextAlchemyDebugger {
    if (!ContextAlchemyDebugger.instance) {
      ContextAlchemyDebugger.instance = new ContextAlchemyDebugger();
    }
    return ContextAlchemyDebugger.instance;
  }

  startSession(userId: string, messageLength: number): void {
    if (!this.debugMode) {
      return;
    }

    this.sessionStartTime = Date.now();
    this.currentSession = {
      userId,
      messageLength,
      tokensUsed: 0,
      tokensAvailable: 0,
      sourcesIncluded: [],
      messageChain: [],
      timings: { total: 0 },
    };

    logger.info('╔══════════════════════════════════════════════════════════════════╗');
    logger.info('║             🔬 CONTEXT ALCHEMY DEBUG SESSION START 🔬              ║');
    logger.info('╚══════════════════════════════════════════════════════════════════╝');
  }

  logTokenBudget(used: number, available: number): void {
    if (!this.debugMode || !this.currentSession) {
      return;
    }

    this.currentSession.tokensUsed = used;
    this.currentSession.tokensAvailable = available;

    const percentage = Math.round((used / available) * 100);
    const bar = this.createProgressBar(percentage);

    logger.info('┌─ TOKEN UTILIZATION ───────────────────────────────────────────────┐');
    logger.info(`│ ${bar} ${percentage}% (${used}/${available})                       `);
    logger.info('└───────────────────────────────────────────────────────────────────┘');
  }

  logMemorySearchResults(
    keyword: number,
    semantic: number,
    temporal: number,
    fusionPattern: string
  ): void {
    if (!this.debugMode || !this.currentSession) {
      return;
    }

    this.currentSession.memoryLayerResults = { keyword, semantic, temporal };
    this.currentSession.fusionPattern = fusionPattern;

    logger.info('┌─ MEMORY SEARCH RESULTS ───────────────────────────────────────────┐');
    logger.info(
      `│ 🔍 Keyword:  ${this.padNumber(keyword)} memories found                          │`
    );
    logger.info(
      `│ 🧠 Semantic: ${this.padNumber(semantic)} memories found (TF-IDF)                 │`
    );
    logger.info(
      `│ 📅 Temporal: ${this.padNumber(temporal)} memories found                          │`
    );
    logger.info(`│ 🎲 Fusion:   "${fusionPattern}" pattern selected                     │`);
    logger.info('└───────────────────────────────────────────────────────────────────┘');
  }

  logFinalMessageChain(messages: Array<{ role: string; content: string }>): void {
    if (!this.debugMode || !this.currentSession) {
      return;
    }

    this.currentSession.messageChain = messages.map((msg) => ({
      role: msg.role,
      contentPreview: msg.content.substring(0, 50).replace(/\n/g, ' '),
      length: msg.content.length,
    }));

    logger.info('┌─ FINAL MESSAGE CHAIN TO LLM ──────────────────────────────────────┐');
    messages.forEach((msg, i) => {
      const icon = msg.role === 'system' ? '⚙️' : msg.role === 'user' ? '👤' : '🤖';
      const preview = msg.content.substring(0, 45).replace(/\n/g, ' ');
      logger.info(`│ ${i}. ${icon} ${msg.role.padEnd(9)}: "${preview}..."               │`);
    });
    logger.info('└───────────────────────────────────────────────────────────────────┘');

    // Calculate total tokens in final message chain
    const totalChars = messages.reduce((sum, msg) => sum + msg.content.length, 0);
    const estimatedTokens = Math.ceil(totalChars / 4);
    logger.info(`📊 Total message chain: ${estimatedTokens} estimated tokens`);
  }

  endSession(response?: string): void {
    if (!this.debugMode || !this.currentSession) {
      return;
    }

    const totalTime = Date.now() - this.sessionStartTime;
    this.currentSession.timings.total = totalTime;

    logger.info('╔══════════════════════════════════════════════════════════════════╗');
    logger.info('║                    📋 SESSION SUMMARY 📋                          ║');
    logger.info('╟────────────────────────────────────────────────────────────────────╢');
    logger.info(`║ User:           ${this.currentSession.userId.padEnd(50)} ║`);
    logger.info(
      `║ Input Length:   ${this.padNumber(this.currentSession.messageLength)} characters                                 ║`
    );
    logger.info(
      `║ Tokens Used:    ${this.padNumber(this.currentSession.tokensUsed)}/${this.padNumber(this.currentSession.tokensAvailable)} (${Math.round((this.currentSession.tokensUsed / this.currentSession.tokensAvailable) * 100)}%)                              ║`
    );
    logger.info(`║ Sources:        ${this.currentSession.sourcesIncluded.join(', ').padEnd(50)} ║`);
    logger.info(
      `║ Total Time:     ${this.padNumber(totalTime)}ms                                          ║`
    );

    if (response) {
      logger.info('╟────────────────────────────────────────────────────────────────────╢');
      logger.info(`║ Response Preview: "${response.substring(0, 45)}..."            ║`);
    }

    logger.info('╚══════════════════════════════════════════════════════════════════╝\n');

    this.currentSession = null;
  }

  private createProgressBar(percentage: number): string {
    const filled = Math.floor(percentage / 5);
    const empty = 20 - filled;
    return `[${'\u2588'.repeat(filled)}${'\u2591'.repeat(empty)}]`;
  }

  private padNumber(num: number): string {
    return num.toString().padStart(4, ' ');
  }

  isDebugMode(): boolean {
    return this.debugMode;
  }

  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
    logger.info(`Context Alchemy Debug Mode: ${enabled ? 'ENABLED' : 'DISABLED'}`);
  }
}

// Export singleton instance
export const contextDebugger = ContextAlchemyDebugger.getInstance();
