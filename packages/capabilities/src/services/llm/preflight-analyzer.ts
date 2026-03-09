/**
 * Preflight Analyzer - "Think before the think"
 *
 * Uses a fast, cheap model to analyze the incoming message and determine:
 * 1. Response length (tokens needed)
 * 2. Memory search keywords
 * 3. Response style/tone
 * 4. Complexity level
 *
 * NO REGEX HEURISTICS - Uses micro LLM for smart decisions.
 */

import { logger } from '@coachartie/shared';
import { microLLM } from './micro-llm.js';

export interface PreflightAnalysis {
  // Response sizing
  responseTokens: number;
  responseTier: 'minimal' | 'short' | 'medium' | 'long' | 'extended';

  // Memory retrieval hints
  memoryKeywords: string[];
  memoryImportanceMin: number;
  needsRecentMemories: boolean;

  // Response style
  tone: 'casual' | 'helpful' | 'technical' | 'formal' | 'playful';
  format: 'chat' | 'list' | 'explanation' | 'tutorial' | 'creative';

  // Complexity
  complexity: 'simple' | 'moderate' | 'complex';
  requiresReasoning: boolean;

  // Source
  source: 'micro-llm' | 'default';
}

/**
 * Convert token count to tier
 */
function tokensTier(tokens: number): PreflightAnalysis['responseTier'] {
  if (tokens <= 200) return 'minimal';
  if (tokens <= 500) return 'short';
  if (tokens <= 1000) return 'medium';
  if (tokens <= 2000) return 'long';
  return 'extended';
}

/**
 * Default analysis - generous defaults that let the LLM decide
 */
export function getDefaultAnalysis(): PreflightAnalysis {
  return {
    responseTokens: 1000, // Generous default - LLM will use what it needs
    responseTier: 'medium',
    memoryKeywords: [],
    memoryImportanceMin: 3,
    needsRecentMemories: true,
    tone: 'helpful',
    format: 'chat',
    complexity: 'moderate',
    requiresReasoning: false,
    source: 'default',
  };
}

/**
 * Quick preflight using micro LLM
 * Makes fast, cheap decisions instead of regex heuristics
 */
export async function quickAnalysis(message: string): Promise<PreflightAnalysis> {
  const defaults = getDefaultAnalysis();

  try {
    // Parallel micro LLM calls for speed
    const [tokensResult, toneResult, formatResult, complexityResult] = await Promise.all([
      microLLM.estimateResponseLength(message),
      microLLM.pickOne(
        'What tone should the response have?',
        message.substring(0, 200),
        ['casual', 'helpful', 'technical', 'formal', 'playful'] as const,
        'helpful'
      ),
      microLLM.pickOne(
        'What format should the response be?',
        message.substring(0, 200),
        ['chat', 'list', 'explanation', 'tutorial', 'creative'] as const,
        'chat'
      ),
      microLLM.pickOne(
        'How complex is this request?',
        message.substring(0, 200),
        ['simple', 'moderate', 'complex'] as const,
        'moderate'
      ),
    ]);

    const result: PreflightAnalysis = {
      responseTokens: tokensResult.result,
      responseTier: tokensTier(tokensResult.result),
      memoryKeywords: [], // Could add keyword extraction here
      memoryImportanceMin: complexityResult.result === 'complex' ? 5 : 3,
      needsRecentMemories: true,
      tone: toneResult.result,
      format: formatResult.result,
      complexity: complexityResult.result,
      requiresReasoning: complexityResult.result === 'complex',
      source: 'micro-llm',
    };

    logger.info(
      `[preflight] micro-llm: ${result.responseTier} (${result.responseTokens} tokens), ` +
        `tone=${result.tone}, format=${result.format}, complexity=${result.complexity}`
    );

    return result;
  } catch (error) {
    logger.warn('[preflight] Micro LLM failed, using defaults:', error);
    return defaults;
  }
}

/**
 * Main entry point - uses micro LLM for smart analysis
 */
export async function analyze(
  message: string,
  options?: {
    useMicroLLM?: boolean;
  }
): Promise<PreflightAnalysis> {
  // For very short messages, just use defaults (not worth the API call)
  if (message.length < 20) {
    return getDefaultAnalysis();
  }

  // Use micro LLM for smart analysis
  if (options?.useMicroLLM !== false) {
    return quickAnalysis(message);
  }

  // Fallback to defaults
  return getDefaultAnalysis();
}

export const preflightAnalyzer = {
  analyze,
  quick: quickAnalysis,
  default: getDefaultAnalysis,
};
