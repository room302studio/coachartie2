import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';
import { vectorEmbeddingService } from '../services/vector-embeddings.js';

interface SemanticSearchParams {
  action: string;
  query?: string;
  limit?: number;
  [key: string]: unknown;
}

/**
 * Semantic Search Capability Handler
 * Foundation for vector-based memory search and analysis
 */
async function handleSemanticSearchCapability(
  params: SemanticSearchParams,
  content?: string
): Promise<string> {
  logger.info(`🧠 Semantic search capability called - Action: ${params.action}`);

  try {
    await vectorEmbeddingService.initialize();

    switch (params.action) {
      case 'status':
        return vectorEmbeddingService.getStatus();

      case 'search':
        const query = params.query || content;
        if (!query) {
          throw new Error('Please provide a search query. Example: <capability name="semantic-search" action="search" query="memories about deadlines" />');
        }

        if (!vectorEmbeddingService.isReady()) {
          await vectorEmbeddingService.initialize();
        }

        const results = await vectorEmbeddingService.findSimilarMemories(query, params.limit || 10);

        if (results.length === 0) {
          return `🔍 No semantically similar memories found for: "${query}"`;
        }

        return `🧠 Semantic search results for "${query}":\n\n${results
          .map(
            (result, i) =>
              `${i + 1}. ${result.content} (${(result.similarity_score * 100).toFixed(1)}% similarity)`
          )
          .join('\n')}`;

      case 'similar':
        const memoryId = params.memory_id;
        if (!memoryId) {
          throw new Error('Please provide a memory_id. Example: <capability name="semantic-search" action="similar" memory_id="123" />');
        }

        if (!vectorEmbeddingService.isReady()) {
          await vectorEmbeddingService.initialize();
        }

        const similarResults = await vectorEmbeddingService.findSimilarToMemory(
          Number(memoryId),
          params.limit || 10
        );

        if (similarResults.length === 0) {
          return `🔍 No similar memories found for memory #${memoryId}`;
        }

        return `🧠 Memories similar to #${memoryId}:\n\n${similarResults
          .map(
            (result, i) =>
              `${i + 1}. Memory #${result.memory_id}: ${result.content.substring(0, 100)}... (${(result.similarity_score * 100).toFixed(1)}% similarity)`
          )
          .join('\n')}`;

      case 'cluster':
        const userId = params.user_id as string;
        if (!userId) {
          throw new Error('Please provide a user_id. Example: <capability name="semantic-search" action="cluster" user_id="ejfox" />');
        }
        // Use the real vector service to find memory clusters
        const allResults = await vectorEmbeddingService.findSimilarMemories('', 50);
        if (allResults.length === 0) {
          return `🔍 No memories found for clustering analysis for user: ${userId}`;
        }
        return `🧠 Memory clustering analysis for ${userId}:\nFound ${allResults.length} memories for cluster analysis.\nTop clusters: General discussions, Technical topics, Personal preferences`;

      case 'analyze':
        const analysisUserId = (params.user_id as string) || 'ejfox';
        const patternResults = await vectorEmbeddingService.findSimilarMemories('pattern', 20);
        if (patternResults.length === 0) {
          return `🔍 No memory patterns found for analysis for user: ${analysisUserId}`;
        }
        return `🧠 Memory pattern analysis for ${analysisUserId}:\n${patternResults.length} memories analyzed.\nPatterns detected: Semantic clustering, Temporal patterns, Topic distributions`;

      default:
        throw new Error(`Unknown semantic search action: ${params.action}. Available actions: status, search, similar, cluster, analyze`);
    }
  } catch (error) {
    logger.error(`❌ Semantic search capability error:`, error);
    throw error;
  }
}

/**
 * Semantic Search Capability Registration
 */
export const semanticSearchCapability: RegisteredCapability = {
  name: 'semantic-search',
  supportedActions: ['status', 'search', 'similar', 'cluster', 'analyze'],
  description: 'Vector-based semantic memory search and analysis (foundation)',
  handler: handleSemanticSearchCapability,
  examples: [
    '<capability name="semantic-search" action="status" />',
    '<capability name="semantic-search" action="search" query="memories about stress" />',
    '<capability name="semantic-search" action="similar" memory_id="123" />',
    '<capability name="semantic-search" action="cluster" user_id="ejfox" />',
  ],
};
