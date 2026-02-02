/**
 * Model Harness Registry
 * 
 * Central registry for all model harnesses.
 * Use getHarness() to get a specific harness, or listHarnesses() to see available options.
 */

import { logger } from '@coachartie/shared';
import type { ModelHarness } from './types.js';
import { openaiResearchHarness } from './openai-research.js';

// Registry of all harnesses
const harnesses = new Map<string, ModelHarness>();

// Register built-in harnesses
harnesses.set('openai-deep-research', openaiResearchHarness);

/**
 * Get a harness by name
 */
export function getHarness(name: string): ModelHarness | undefined {
  return harnesses.get(name);
}

/**
 * Get a harness, throw if not found
 */
export function requireHarness(name: string): ModelHarness {
  const harness = harnesses.get(name);
  if (!harness) {
    throw new Error(`Harness not found: ${name}. Available: ${listHarnessNames().join(', ')}`);
  }
  return harness;
}

/**
 * Register a new harness
 */
export function registerHarness(harness: ModelHarness): void {
  harnesses.set(harness.name, harness);
  logger.info(`🔌 Registered harness: ${harness.name} (${harness.type})`);
}

/**
 * List all registered harness names
 */
export function listHarnessNames(): string[] {
  return Array.from(harnesses.keys());
}

/**
 * List all harnesses with availability status
 */
export function listHarnesses(): Array<{
  name: string;
  type: string;
  description: string;
  available: boolean;
}> {
  return Array.from(harnesses.values()).map(h => ({
    name: h.name,
    type: h.type,
    description: h.description,
    available: h.isAvailable(),
  }));
}

/**
 * Get the best available harness for a task type
 */
export function getHarnessForTask(taskType: 'chat' | 'research' | 'code'): ModelHarness | undefined {
  switch (taskType) {
    case 'research':
      // Prefer deep research if available
      if (openaiResearchHarness.isAvailable()) {
        return openaiResearchHarness;
      }
      // Fallback to OpenRouter (would need to wrap it)
      return undefined;
    
    case 'chat':
    case 'code':
    default:
      // Would return OpenRouter harness here
      return undefined;
  }
}

// Export types
export * from './types.js';
export { openaiResearchHarness } from './openai-research.js';
