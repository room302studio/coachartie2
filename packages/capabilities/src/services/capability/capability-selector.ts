import { logger } from '@coachartie/shared';
import { capabilityRegistry, RegisteredCapability } from './capability-registry.js';
import { openRouterService } from '../llm/openrouter.js';

// Cache for CAPABILITY_PROMPT_INTRO to avoid repeated database lookups
let cachedCapabilityIntro: string | null = null;
let introLastFetched = 0;
const INTRO_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Load capability intro from database for consistent decision-making style
 */
async function getCapabilityIntro(): Promise<string> {
  const now = Date.now();
  if (cachedCapabilityIntro && now - introLastFetched < INTRO_CACHE_TTL) {
    return cachedCapabilityIntro;
  }

  try {
    const { promptManager } = await import('../llm/prompt-manager.js');
    const promptData = await promptManager.getPrompt('CAPABILITY_PROMPT_INTRO');
    if (promptData?.content) {
      cachedCapabilityIntro = promptData.content;
      introLastFetched = now;
      return cachedCapabilityIntro;
    }
  } catch (error) {
    logger.warn('Capability selector: Could not load CAPABILITY_PROMPT_INTRO from database');
  }

  return ''; // Empty string if not found - triage works without it
}

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

    // Build triage prompt (now async to load from database)
    const triagePrompt = await this.buildTriagePrompt(
      userMessage,
      capabilityList,
      conversationContext
    );

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
   * Now uses Context Alchemy (CAPABILITY_PROMPT_INTRO) for consistent decision-making
   */
  private async buildTriagePrompt(
    userMessage: string,
    capabilityList: string,
    conversationContext?: string[]
  ): Promise<string> {
    const contextSection =
      conversationContext && conversationContext.length > 0
        ? `\nRecent conversation:\n${conversationContext.slice(-3).join('\n')}\n`
        : '';

    // Load capability intro from database for consistent approach
    const capabilityIntro = await getCapabilityIntro();
    const introSection = capabilityIntro ? `\n${capabilityIntro}\n` : '';

    return `You are a capability triage system. Your job is to quickly identify which capabilities (if any) are relevant to the user's request.${introSection}

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
          const nameMatch = line.match(/CAPABILITY:\s*([^|]+)/);
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
        } catch (_error) {
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

    let instructions = `CAPABILITY FORMAT - USE SIMPLE SHORTCUTS WHEN POSSIBLE:

Simple shortcuts (preferred):
<read>path</read>, <recall>query</recall>, <websearch>query</websearch>, <calc>2+2</calc>, <remember>fact</remember>

Or full format: <capability name="X" action="Y" data='{"param":"value"}' />

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
   * Check if a message likely needs capabilities
   * Uses micro-LLM for smart detection instead of keyword heuristics
   */
  async likelyNeedsCapabilities(userMessage: string): Promise<boolean> {
    // Very short messages rarely need capabilities
    if (userMessage.length < 15) {
      return false;
    }

    try {
      const { microLLM } = await import('../llm/micro-llm.js');
      const result = await microLLM.askYesNo(
        'Does this message need tools like: file operations, web search, memory/recall, calculations, scheduling, or code execution?',
        userMessage.substring(0, 200),
        false // Default to no if micro-LLM fails
      );
      return result.result;
    } catch {
      // If micro-LLM fails, default to true (safer to include capabilities)
      return true;
    }
  }
}

// Export singleton
export const capabilitySelector = new CapabilitySelector();
