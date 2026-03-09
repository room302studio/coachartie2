/**
 * Model Router Service
 *
 * n8nClaw-inspired tiered model selection based on task complexity.
 * Routes requests to the most cost-effective model that can handle the task.
 *
 * Tiers:
 * - Tier 1 (Simple): Haiku - Quick responses, simple tasks
 * - Tier 2 (Medium): Sonnet - Normal conversation, moderate complexity
 * - Tier 3 (Complex): Opus - Deep reasoning, complex analysis
 */

import { logger } from '@coachartie/shared';

export type ModelTier = 'simple' | 'medium' | 'complex';

export interface ModelConfig {
  tier: ModelTier;
  model: string;
  maxTokens: number;
  description: string;
}

// Model configurations by tier
export const MODEL_TIERS: Record<ModelTier, ModelConfig> = {
  simple: {
    tier: 'simple',
    model: 'anthropic/claude-3-5-haiku',
    maxTokens: 1024,
    description: 'Quick responses, simple tasks, lookups',
  },
  medium: {
    tier: 'medium',
    model: 'anthropic/claude-sonnet-4',
    maxTokens: 4096,
    description: 'Normal conversation, moderate complexity',
  },
  complex: {
    tier: 'complex',
    model: 'anthropic/claude-opus-4',
    maxTokens: 8192,
    description: 'Deep reasoning, complex analysis, creative work',
  },
};

// Keywords that suggest different complexity levels
const COMPLEXITY_SIGNALS = {
  simple: [
    'what is', 'who is', 'when', 'where', 'how much', 'how many',
    'define', 'list', 'show', 'status', 'check', 'remind',
    'weather', 'time', 'date', 'convert', 'calculate',
  ],
  complex: [
    'analyze', 'explain why', 'compare', 'evaluate', 'design',
    'architecture', 'strategy', 'recommend', 'optimize', 'debug',
    'refactor', 'review', 'plan', 'implement', 'write code',
    'complex', 'detailed', 'comprehensive', 'in-depth',
    'research', 'investigate', 'synthesize',
  ],
};

// Capability actions that map to specific tiers
const CAPABILITY_TIERS: Record<string, ModelTier> = {
  // Simple tier - quick lookups and status checks
  'memory.recall': 'simple',
  'quests.status': 'simple',
  'quests.list': 'simple',
  'task-status.list': 'simple',
  'trend-watcher.hackernews': 'simple',
  'calculator.calculate': 'simple',
  'environment.get': 'simple',

  // Medium tier - normal operations
  'quests.start': 'medium',
  'quests.complete': 'medium',
  'memory.store': 'medium',
  'trend-watcher.overview': 'medium',
  'morning-briefing.show': 'medium',
  'shell.execute': 'medium',

  // Complex tier - analysis and creation
  'deep_research.research': 'complex',
  'quests.create': 'complex', // Custom quest creation needs more thought
  'edit.apply': 'complex',
  'github.review': 'complex',
};

/**
 * Analyze message complexity based on content
 */
function analyzeMessageComplexity(message: string): ModelTier {
  const lowerMessage = message.toLowerCase();
  const wordCount = message.split(/\s+/).length;

  // Check for complex signals
  const hasComplexSignals = COMPLEXITY_SIGNALS.complex.some(
    signal => lowerMessage.includes(signal)
  );

  // Check for simple signals
  const hasSimpleSignals = COMPLEXITY_SIGNALS.simple.some(
    signal => lowerMessage.includes(signal)
  );

  // Long messages with complex signals -> complex
  if (hasComplexSignals && wordCount > 50) {
    return 'complex';
  }

  // Complex signals without simple signals -> complex
  if (hasComplexSignals && !hasSimpleSignals) {
    return 'complex';
  }

  // Short messages with simple signals -> simple
  if (hasSimpleSignals && wordCount < 20) {
    return 'simple';
  }

  // Default to medium
  return 'medium';
}

/**
 * Get recommended model tier for a capability action
 */
export function getTierForCapability(
  capabilityName: string,
  action: string
): ModelTier {
  const key = `${capabilityName}.${action}`;
  return CAPABILITY_TIERS[key] || 'medium';
}

/**
 * Route a message to the appropriate model tier
 */
export function routeMessage(
  message: string,
  context?: {
    hasActiveQuest?: boolean;
    recentCapabilities?: string[];
    conversationLength?: number;
  }
): ModelConfig {
  // Analyze base complexity from message
  let tier = analyzeMessageComplexity(message);

  // Boost complexity if conversation is long (more context needed)
  if (context?.conversationLength && context.conversationLength > 10) {
    if (tier === 'simple') tier = 'medium';
  }

  // Check recent capabilities for complexity hints
  if (context?.recentCapabilities) {
    const recentTiers = context.recentCapabilities.map(cap => {
      const [name, action] = cap.split('.');
      return getTierForCapability(name, action);
    });

    // If recent work was complex, stay complex
    if (recentTiers.includes('complex')) {
      tier = 'complex';
    }
  }

  const config = MODEL_TIERS[tier];
  logger.debug(`Model router: "${message.slice(0, 50)}..." -> ${tier} (${config.model})`);

  return config;
}

/**
 * Get model for a specific task type
 */
export function getModelForTask(taskType: string): ModelConfig {
  switch (taskType) {
    // Worker 1 equivalent - simple tasks
    case 'reminder':
    case 'status-check':
    case 'lookup':
    case 'format':
      return MODEL_TIERS.simple;

    // Worker 2 equivalent - medium tasks
    case 'summarize':
    case 'respond':
    case 'process':
    case 'update':
      return MODEL_TIERS.medium;

    // Worker 3 equivalent - complex tasks
    case 'analyze':
    case 'research':
    case 'create':
    case 'debug':
    case 'review':
      return MODEL_TIERS.complex;

    default:
      return MODEL_TIERS.medium;
  }
}

/**
 * Estimate cost for a model tier (rough approximation)
 */
export function estimateCost(
  tier: ModelTier,
  inputTokens: number,
  outputTokens: number
): number {
  // Rough pricing per 1M tokens (as of 2025)
  const pricing: Record<ModelTier, { input: number; output: number }> = {
    simple: { input: 0.25, output: 1.25 }, // Haiku
    medium: { input: 3.0, output: 15.0 },  // Sonnet
    complex: { input: 15.0, output: 75.0 }, // Opus
  };

  const { input, output } = pricing[tier];
  return (inputTokens * input + outputTokens * output) / 1_000_000;
}

/**
 * Log model selection decision for observability
 */
export function logModelDecision(
  message: string,
  selectedTier: ModelTier,
  reason: string
): void {
  logger.info(`Model selection: ${selectedTier} - ${reason}`, {
    messagePreview: message.slice(0, 100),
    model: MODEL_TIERS[selectedTier].model,
  });
}
