import { logger } from '@coachartie/shared';
import { capabilityRegistry, RegisteredCapability } from './capability-registry.js';
import { openRouterService } from '../llm/openrouter.js';

/**
 * Capability Selector - Two-tier capability triage system
 *
 * PROBLEM: Presenting ALL capabilities to the LLM causes choice overload
 * → LLM says it invoked a capability without actually doing it
 * → Poor capability selection decisions
 *
 * SOLUTION: Use cheap/fast model to nominate relevant capabilities
 * 1. FAST_MODEL (Gemini Flash): Sees ALL capabilities, nominates 3-5 relevant ones
 * 2. SMART_MODEL (Claude): Sees only nominated capabilities, makes better decisions
 *
 * Cost comparison:
 * - Without selector: Every message pays SMART_MODEL price for full capability list
 * - With selector: Small FAST_MODEL fee (~$0.00005) + SMART_MODEL sees smaller context
 */

interface CapabilityNomination {
  capability: RegisteredCapability;
  relevanceScore: number;
  reason: string;
}

export class CapabilitySelector {
  private readonly MAX_NOMINATIONS = 5; // Top-k capabilities to nominate
  private readonly MIN_RELEVANCE_SCORE = 0.3; // Minimum score to include

  /**
   * Select relevant capabilities for a user message using FAST_MODEL triage
   *
   * @param userMessage - The user's message
   * @param conversationContext - Recent conversation history (optional)
   * @returns Array of nominated capabilities (3-5 most relevant)
   */
  async selectRelevantCapabilities(
    userMessage: string,
    conversationContext?: string[]
  ): Promise<RegisteredCapability[]> {
    const startTime = Date.now();

    // Get ALL capabilities from registry
    const allCapabilities = capabilityRegistry.list();

    logger.info(
      `🔍 Capability Selector: Triaging ${allCapabilities.length} capabilities for message: "${userMessage.slice(0, 50)}..."`
    );

    // Build capability list for triage
    const capabilityList = allCapabilities
      .map((cap) => {
        const actions = cap.supportedActions.join(', ');
        const desc = cap.description || 'No description';
        return `- ${cap.name}: ${desc} (actions: ${actions})`;
      })
      .join('\n');

    // Build triage prompt
    const triagePrompt = this.buildTriagePrompt(userMessage, capabilityList, conversationContext);

    try {
      // Use FAST_MODEL for cheap triage
      const fastModel = openRouterService.selectFastModel();

      logger.info(`🚀 Using FAST_MODEL (${fastModel}) for capability triage`);

      const triageResponse = await openRouterService.generateFromMessageChain(
        [
          {
            role: 'system',
            content: triagePrompt,
          },
          {
            role: 'user',
            content: `User message: "${userMessage}"\n\nWhich capabilities (if any) are relevant?`,
          },
        ],
        'capability-selector',
        undefined,
        fastModel // Use specific fast model
      );

      // Parse nominations from triage response
      const nominations = this.parseNominations(triageResponse, allCapabilities);

      const duration = Date.now() - startTime;

      logger.info(
        `✅ Capability Selector: Nominated ${nominations.length} capabilities in ${duration}ms:`,
        nominations
          .map((n) => `${n.capability.name} (score: ${n.relevanceScore.toFixed(2)})`)
          .join(', ')
      );

      // Return top capabilities
      return nominations
        .sort((a, b) => b.relevanceScore - a.relevanceScore)
        .slice(0, this.MAX_NOMINATIONS)
        .map((n) => n.capability);
    } catch (error) {
      logger.error('❌ Capability Selector failed, falling back to ALL capabilities:', error);
      // Fallback: return ALL capabilities if triage fails
      return allCapabilities;
    }
  }

  /**
   * Build the triage prompt for FAST_MODEL
   */
  private buildTriagePrompt(
    userMessage: string,
    capabilityList: string,
    conversationContext?: string[]
  ): string {
    const contextSection =
      conversationContext && conversationContext.length > 0
        ? `\nRecent conversation:\n${conversationContext.slice(-3).join('\n')}\n`
        : '';

    return `You are a capability triage system. Your job is to quickly identify which capabilities (if any) are relevant to the user's request.

AVAILABLE CAPABILITIES:
${capabilityList}

${contextSection}

INSTRUCTIONS:
1. Read the user's message carefully
2. Identify which capabilities (if any) would be useful to fulfill the request
3. Score each relevant capability from 0.0 to 1.0 based on relevance
4. Return ONLY the relevant capabilities, not all of them
5. If no capabilities are needed (simple conversation), return "NONE"

RESPONSE FORMAT:
For each relevant capability, output one line:
CAPABILITY: <name> | SCORE: <0.0-1.0> | REASON: <brief explanation>

Example:
CAPABILITY: calculator | SCORE: 0.95 | REASON: User asks to calculate a percentage
CAPABILITY: remember | SCORE: 0.80 | REASON: User wants to store the result

If no capabilities needed:
NONE

Be selective - only nominate capabilities that are actually useful for this specific request.`;
  }

  /**
   * Parse capability nominations from triage response
   */
  private parseNominations(
    triageResponse: string,
    allCapabilities: RegisteredCapability[]
  ): CapabilityNomination[] {
    const nominations: CapabilityNomination[] = [];

    // Check if response is "NONE"
    if (triageResponse.trim().toUpperCase().includes('NONE')) {
      logger.info('🚫 Capability Selector: No capabilities needed');
      return [];
    }

    // Parse capability nominations
    const lines = triageResponse.split('\n');

    for (const line of lines) {
      if (line.includes('CAPABILITY:')) {
        try {
          // Extract name
          const nameMatch = line.match(/CAPABILITY:\s*([^\|]+)/);
          const name = nameMatch ? nameMatch[1].trim() : null;

          // Extract score
          const scoreMatch = line.match(/SCORE:\s*([\d.]+)/);
          const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0.5;

          // Extract reason
          const reasonMatch = line.match(/REASON:\s*(.+)/);
          const reason = reasonMatch ? reasonMatch[1].trim() : 'Selected by triage';

          if (name) {
            // Find matching capability
            const capability = allCapabilities.find((cap) => cap.name === name);

            if (capability && score >= this.MIN_RELEVANCE_SCORE) {
              nominations.push({
                capability,
                relevanceScore: score,
                reason,
              });
            }
          }
        } catch (error) {
          logger.warn(`⚠️ Failed to parse nomination line: ${line}`);
        }
      }
    }

    return nominations;
  }

  /**
   * Generate instructions for ONLY the nominated capabilities (not all)
   * This replaces the bloated generateInstructions() that shows everything
   */
  generateNominatedInstructions(nominations: RegisteredCapability[]): string {
    if (nominations.length === 0) {
      return `No specific capabilities are needed for this request. Respond naturally without using any capabilities.`;
    }

    let instructions = `CRITICAL CAPABILITY FORMAT RULES:

When you need to execute a capability, you MUST use this EXACT XML format:
<capability name="capability-name" action="action-name" data='{"param":"value"}' />

RELEVANT CAPABILITIES FOR THIS REQUEST:
`;

    // List ONLY nominated capabilities with examples
    for (const capability of nominations) {
      instructions += `\n- ${capability.name}: ${capability.description || 'No description'}`;
      instructions += `\n  Actions: ${capability.supportedActions.join(', ')}`;
      if (capability.examples && capability.examples.length > 0) {
        instructions += `\n  Example: ${capability.examples[0]}`;
      }
    }

    instructions += `\n\nIMPORTANT: These are the ONLY capabilities available for this request. Use them if needed, or respond without capabilities if appropriate.`;

    return instructions;
  }

  /**
   * Check if a message likely needs capabilities (quick heuristic)
   * Used to skip expensive triage for obviously simple messages
   */
  likelyNeedsCapabilities(userMessage: string): boolean {
    const message = userMessage.toLowerCase();

    // Keywords that suggest capability needs
    const capabilityKeywords = [
      'calculate',
      'remember',
      'recall',
      'search',
      'find',
      'web',
      'look up',
      'save',
      'store',
      'todo',
      'goal',
      'variable',
      'set',
      'get',
      'create',
      'delete',
      'update',
      'list',
      'show me',
      // Laptop/shell/code-related keywords
      'laptop',
      'code',
      'file',
      'edit',
      'run',
      'execute',
      'script',
      'terminal',
      'shell',
      'command',
      'git',
      'npm',
      'python',
      'node',
      'grep',
      'install',
      'error',
      'diagnose',
      'debug',
      'logs',
      'branch',
      'commit',
      'diff',
      'status',
      'think',
      'plan',
      'reasoning',
      'scratchpad',
      'context',
      'where',
      'directory',
      // Scheduler-related keywords
      'remind',
      'reminder',
      'alert',
      'notification',
      'later',
      'schedule',
      'recurring',
      'repeat',
      'daily',
      'weekly',
      'monthly',
      'yearly',
      'cron',
      'every',
      'each',
      'soon',
      'send me a reminder',
    ];

    // Check simple keywords
    if (capabilityKeywords.some((keyword) => message.includes(keyword))) {
      return true;
    }

    // Check temporal keywords with word boundaries to avoid false matches
    // (e.g., "at" in "what", "in" in "doing")
    const temporalPatterns = [
      /\bat\s+\d+\s*(am|pm|o'clock)/i, // "at 9 AM", "at 2 PM"
      /\bin\s+(\d+\s*(minutes?|hours?|days?|weeks?|seconds?|months?)|a\s+(few|couple))/i, // "in 5 minutes", "in a day"
    ];

    return temporalPatterns.some((pattern) => pattern.test(message));
  }
}

// Export singleton
export const capabilitySelector = new CapabilitySelector();
