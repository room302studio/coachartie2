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

import { logger } from '../../shared/logger.js';
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
 * Determine minimum memory importance based on complexity
 */
function importanceMinForComplexity(complexity: string): number {
  if (complexity === 'complex') {
    return 5;
  }
  return 3;
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

    // The estimate becomes a hard max_tokens, and it's an 8B model's guess from the first
    // 300 chars (reasoning models spend part of the cap thinking, too). Let it raise the cap,
    // never lower it below 1000: the micro-LLM's revival on 2026-10-23 cut Artie off
    // mid-sentence on a ~600-token guess. Brownout still tapers on top of this.
    const responseTokens = Math.max(tokensResult.result, 1000);
    const result: PreflightAnalysis = {
      responseTokens,
      responseTier: tokensTier(responseTokens),
      memoryKeywords: [], // Could add keyword extraction here
      memoryImportanceMin: importanceMinForComplexity(complexityResult.result),
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
  // For very short messages, skip the micro-LLM entirely — a one-liner never needs
  // Opus-level reasoning, and this is the bulk of busy-channel banter. Classifying it
  // 'moderate' (the old default) sent every "lol nice" to the smart model.
  if (message.length < 20) {
    return {
      ...getDefaultAnalysis(),
      complexity: 'simple',
      responseTokens: 300,
      responseTier: 'short',
    };
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
