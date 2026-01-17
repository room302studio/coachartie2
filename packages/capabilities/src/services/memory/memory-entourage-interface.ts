/**
 * Memory Entourage Interface for Context Alchemy Integration
 *
 * This defines the minimal contract between Memory Entourage and Context Alchemy.
 * Context Alchemy only needs to know how to get formatted memory context.
 */

export interface MemoryEntourageResult {
  content: string; // Formatted context string ready for LLM
  confidence: number; // 0-1 confidence in the recall quality
  memoryCount: number; // Number of memories included
  categories: string[]; // Types of memories found ['temporal', 'direct', 'semantic']
  memoryIds: string[]; // Array of memory IDs that were included for debugging
}

export interface MemoryEntourageInterface {
  /**
   * Get formatted memory context for Context Alchemy
   * @param userMessage The user's current message
   * @param userId User identifier
   * @param options Optional parameters for recall behavior
   * @returns Formatted memory context ready to insert into prompt
   */
  getMemoryContext(
    userMessage: string,
    userId: string,
    options?: {
      maxTokens?: number; // Token budget constraint from Context Alchemy
      priority?: 'speed' | 'accuracy' | 'comprehensive';
      minimal?: boolean; // Match Context Alchemy's minimal mode
    }
  ): Promise<MemoryEntourageResult>;
}

// SimpleMemoryEntourage removed - placeholder cancer eliminated
// Use CombinedMemoryEntourage for real memory functionality
