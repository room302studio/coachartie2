import { logger } from '@coachartie/shared';
import { MemoryEntourageInterface, MemoryEntourageResult } from './memory-entourage-interface.js';
import { SemanticMemoryEntourage } from './semantic-memory-entourage.js';
import { TemporalMemoryEntourage } from './temporal-memory-entourage.js';
import { hybridDataLayer } from '../../runtime/hybrid-data-layer.js';

/**
 * CombinedMemoryEntourage - Multi-layered memory recall with entourage pattern
 *
 * Implements the "entourage of auto-insertion" philosophy by running multiple
 * memory search strategies in parallel and combining results intelligently.
 *
 * Layers:
 * 1. Semantic similarity (LLM-based contextual understanding)
 * 2. Temporal patterns (time-based relevance)
 *
 * Future layers to add:
 * 3. Relationship mapping (connected memories)
 * 4. Pattern matching (behavioral insights)
 */
export class CombinedMemoryEntourage implements MemoryEntourageInterface {
  private semanticEntourage: SemanticMemoryEntourage;
  private temporalEntourage: TemporalMemoryEntourage;

  constructor() {
    this.semanticEntourage = new SemanticMemoryEntourage();
    this.temporalEntourage = new TemporalMemoryEntourage();
    logger.info('🧠 CombinedMemoryEntourage: Initialized with semantic + temporal layers');
  }

  async getMemoryContext(
    userMessage: string,
    userId: string,
    options: {
      maxTokens?: number;
      priority?: 'speed' | 'accuracy' | 'comprehensive';
      minimal?: boolean;
      guildId?: string;
    } = {}
  ): Promise<MemoryEntourageResult> {
    // Handle minimal mode
    if (options.minimal) {
      return {
        content: '',
        confidence: 1.0,
        memoryCount: 0,
        categories: ['minimal'],
        memoryIds: [],
      };
    }

    try {
      logger.info('│ 🧠 Running MULTI-LAYER PARALLEL SEARCH:');
      logger.info(
        `│ Priority Mode: ${options.priority || 'speed'} | Max Tokens: ${options.maxTokens || 800} | Guild: ${options.guildId || 'none'}`
      );

      // Calculate token budget for each layer
      const tokenBudget = this.calculateLayerTokenBudgets(options.maxTokens, !!options.guildId);
      logger.info(
        `│ Token Split: Semantic=${tokenBudget.semantic}, Temporal=${tokenBudget.temporal}, Guild=${tokenBudget.guild}`
      );

      // Run memory searches in parallel (entourage pattern)
      const startTime = Date.now();
      const searchPromises: Promise<MemoryEntourageResult>[] = [
        this.semanticEntourage.getMemoryContext(userMessage, userId, {
          ...options,
          maxTokens: tokenBudget.semantic,
        }),
        this.temporalEntourage.getMemoryContext(userMessage, userId, {
          ...options,
          maxTokens: tokenBudget.temporal,
        }),
      ];

      // Add guild memory search if guildId provided
      if (options.guildId) {
        searchPromises.push(this.getGuildMemoryContext(options.guildId, tokenBudget.guild));
      }

      const results = await Promise.all(searchPromises);
      const [semanticResult, temporalResult] = results;
      const guildResult = results[2]; // May be undefined
      const parallelTime = Date.now() - startTime;
      logger.info(`│ ⚡ Parallel search completed in ${parallelTime}ms`);

      // Log individual layer results
      logger.info('│ ┌─ LAYER RESULTS ─────────────────────────────────────────┐');
      logger.info(
        `│ │ 🧠 Semantic: ${semanticResult.memoryCount} memories, ${(semanticResult.confidence * 100).toFixed(1)}% confidence`
      );
      logger.info(
        `│ │ 📅 Temporal: ${temporalResult.memoryCount} memories, ${(temporalResult.confidence * 100).toFixed(1)}% confidence`
      );
      if (guildResult) {
        logger.info(
          `│ │ 🏠 Guild: ${guildResult.memoryCount} memories, ${(guildResult.confidence * 100).toFixed(1)}% confidence`
        );
      }
      logger.info('│ └───────────────────────────────────────────────────────────┘');

      // Combine results intelligently
      const combinedResult = this.fuseMemoryResults(
        semanticResult,
        temporalResult,
        userMessage,
        options,
        guildResult
      );

      logger.info(`│ 🎯 FUSION COMPLETE: ${combinedResult.memoryCount} total memories`);
      logger.info(
        `│ Confidence: ${(combinedResult.confidence * 100).toFixed(1)}% | Categories: ${combinedResult.categories.join(', ')}`
      );

      return combinedResult;
    } catch (error) {
      logger.error('❌ CombinedMemoryEntourage failed:', error);

      // Graceful degradation: return empty result
      return {
        content: '',
        confidence: 0.0,
        memoryCount: 0,
        categories: ['error'],
        memoryIds: [],
      };
    }
  }

  /**
   * Calculate token budgets for each memory layer
   */
  private calculateLayerTokenBudgets(maxTokens?: number, includeGuild?: boolean): {
    semantic: number;
    temporal: number;
    guild: number;
  } {
    const totalBudget = maxTokens || 800;

    if (includeGuild) {
      // With guild: 45% semantic, 30% temporal, 25% guild
      return {
        semantic: Math.floor(totalBudget * 0.45),
        temporal: Math.floor(totalBudget * 0.30),
        guild: Math.floor(totalBudget * 0.25),
      };
    }

    // Allocate tokens: Semantic gets priority for better contextual understanding
    // Semantic: 60% (more important for accurate matches)
    // Temporal: 40% (good for context timing)
    return {
      semantic: Math.floor(totalBudget * 0.6),
      temporal: Math.floor(totalBudget * 0.4),
      guild: 0,
    };
  }

  /**
   * Get guild-scoped memories (community knowledge, observations)
   */
  private async getGuildMemoryContext(guildId: string, maxTokens: number): Promise<MemoryEntourageResult> {
    try {
      const guildMemories = await hybridDataLayer.getGuildMemories(guildId, 5);

      if (guildMemories.length === 0) {
        return {
          content: '',
          confidence: 0.0,
          memoryCount: 0,
          categories: ['guild'],
          memoryIds: [],
        };
      }

      // Format guild memories
      const formattedMemories = guildMemories.map((m) => {
        // Extract summary from observational memories (after the bracket prefix)
        const bracketEnd = m.content.indexOf('] ');
        const content = bracketEnd > 0 ? m.content.substring(bracketEnd + 2) : m.content;
        return content.substring(0, 300) + (content.length > 300 ? '...' : '');
      });

      const content = `🏠 Community knowledge:\n${formattedMemories.map(m => `• ${m}`).join('\n')}`;

      return {
        content,
        confidence: 0.8, // Guild memories are reliable community context
        memoryCount: guildMemories.length,
        categories: ['guild', 'community'],
        memoryIds: guildMemories.map((m) => String(m.id)),
      };
    } catch (error) {
      logger.warn('Failed to get guild memories:', error);
      return {
        content: '',
        confidence: 0.0,
        memoryCount: 0,
        categories: ['guild', 'error'],
        memoryIds: [],
      };
    }
  }

  /**
   * Fuse results from multiple memory entourages intelligently
   */
  private fuseMemoryResults(
    semanticResult: MemoryEntourageResult,
    temporalResult: MemoryEntourageResult,
    userMessage: string,
    options: any,
    guildResult?: MemoryEntourageResult
  ): MemoryEntourageResult {
    // Handle case where no layer found memories
    const totalCount = semanticResult.memoryCount + temporalResult.memoryCount + (guildResult?.memoryCount || 0);
    if (totalCount === 0) {
      return {
        content: '',
        confidence: 0.0,
        memoryCount: 0,
        categories: ['no_matches'],
        memoryIds: [],
      };
    }

    // Collect active layers
    const activeLayers: Array<{name: string; result: MemoryEntourageResult}> = [];
    if (semanticResult.memoryCount > 0) {
      activeLayers.push({ name: 'semantic', result: semanticResult });
    }
    if (temporalResult.memoryCount > 0) {
      activeLayers.push({ name: 'temporal', result: temporalResult });
    }
    if (guildResult && guildResult.memoryCount > 0) {
      activeLayers.push({ name: 'guild', result: guildResult });
    }

    if (activeLayers.length === 1) {
      return {
        ...activeLayers[0].result,
        categories: [...activeLayers[0].result.categories, `${activeLayers[0].name}_only`],
      };
    }

    // Multiple layers found memories - intelligent fusion
    const contentParts: string[] = [];
    if (semanticResult.content) contentParts.push(semanticResult.content);
    if (temporalResult.content) contentParts.push(temporalResult.content);
    if (guildResult?.content) contentParts.push(guildResult.content);

    const fusedContent = contentParts.join('\n\n');

    // Calculate weighted confidence
    let totalWeight = 0;
    let weightedConfidence = 0;
    if (semanticResult.memoryCount > 0) {
      weightedConfidence += semanticResult.confidence * 0.4;
      totalWeight += 0.4;
    }
    if (temporalResult.memoryCount > 0) {
      weightedConfidence += temporalResult.confidence * 0.3;
      totalWeight += 0.3;
    }
    if (guildResult && guildResult.memoryCount > 0) {
      weightedConfidence += guildResult.confidence * 0.3;
      totalWeight += 0.3;
    }
    const fusedConfidence = totalWeight > 0 ? weightedConfidence / totalWeight : 0;

    // Merge categories and IDs
    const allCategories = new Set([
      ...semanticResult.categories,
      ...temporalResult.categories,
      ...(guildResult?.categories || []),
      'multi_layer_fusion',
    ]);
    const allMemoryIds = [
      ...semanticResult.memoryIds,
      ...temporalResult.memoryIds,
      ...(guildResult?.memoryIds || []),
    ];

    return {
      content: fusedContent,
      confidence: fusedConfidence,
      memoryCount: totalCount,
      categories: Array.from(allCategories),
      memoryIds: allMemoryIds,
    };
  }

  /**
   * Fuse memory content from multiple sources with variety
   */
  private fuseMemoryContent(
    semanticResult: MemoryEntourageResult,
    temporalResult: MemoryEntourageResult,
    _options: any
  ): string {
    const semanticContent = semanticResult.content.trim();
    const temporalContent = temporalResult.content.trim();

    const contents = [semanticContent, temporalContent].filter((c) => c.length > 0);
    if (contents.length === 0) {
      return '';
    }
    if (contents.length === 1) {
      return contents[0];
    }

    // Apply stochastic fusion patterns for variety
    const fusionPatterns = [
      'layered', // Layer content by type
      'interleaved', // Mix content naturally
      'comparative', // Present as different perspectives
      'synthesized', // Combine into unified narrative
      'temporal_flow', // Organize by temporal context
    ];

    const pattern = fusionPatterns[Math.floor(Math.random() * fusionPatterns.length)];
    logger.info(`│ 🎲 FUSION PATTERN: "${pattern}" (randomly selected for variety)`);

    switch (pattern) {
      case 'layered': {
        let layered = '';
        if (semanticContent) {
          layered += semanticContent;
        }
        if (temporalContent) {
          layered += layered ? `\n\nTiming: ${temporalContent.toLowerCase()}` : temporalContent;
        }
        return layered;
      }

      case 'interleaved':
        return contents.join(' ');

      case 'comparative': {
        let comparative = '';
        if (semanticContent) {
          comparative += `Conceptual: ${semanticContent}`;
        }
        if (temporalContent) {
          comparative += comparative
            ? `\nTemporal: ${temporalContent}`
            : `Temporal: ${temporalContent}`;
        }
        return comparative;
      }

      case 'synthesized':
        return `From what I remember: ${contents.join('. This connects to ')}.`;

      case 'temporal_flow':
        if (temporalContent) {
          const others = [semanticContent].filter((c) => c.length > 0);
          return others.length > 0
            ? `${temporalContent} ${others.join('. Also, ')}.`
            : temporalContent;
        }
        return contents.join('. ');

      default:
        return contents.join('\n');
    }
  }

  /**
   * Fuse confidence scores from multiple sources
   */
  private fuseConfidenceScores(
    semanticResult: MemoryEntourageResult,
    temporalResult: MemoryEntourageResult
  ): number {
    // Weight confidence scores based on reliability and complementarity
    const semanticWeight = 0.6; // Good for conceptual connections
    const temporalWeight = 0.4; // Excellent for context timing

    const fusedConfidence =
      semanticResult.confidence * semanticWeight + temporalResult.confidence * temporalWeight;

    // Boost confidence based on convergent validation (both layers finding memories)
    const activeLayers = [semanticResult, temporalResult].filter((r) => r.memoryCount > 0).length;
    const convergenceBoost =
      {
        1: 0, // Single layer
        2: 0.15, // Both layers agree - highest confidence
      }[activeLayers] || 0;

    return Math.min(1.0, fusedConfidence + convergenceBoost);
  }

  /**
   * Fuse memory IDs from multiple sources
   */
  private fuseMemoryIds(
    semanticResult: MemoryEntourageResult,
    temporalResult: MemoryEntourageResult
  ): string[] {
    // Combine and deduplicate memory IDs from all layers
    const allMemoryIds = new Set([
      ...(semanticResult.memoryIds || []),
      ...(temporalResult.memoryIds || []),
    ]);

    return Array.from(allMemoryIds);
  }

  /**
   * Fuse categories from multiple sources
   */
  private fuseCategories(
    semanticResult: MemoryEntourageResult,
    temporalResult: MemoryEntourageResult
  ): string[] {
    const allCategories = new Set([...semanticResult.categories, ...temporalResult.categories]);

    // Add fusion-specific categories
    allCategories.add('two_layer_combined');

    // Add convergence categories based on which layers found memories
    const activeLayers = [];
    if (semanticResult.memoryCount > 0) {
      activeLayers.push('semantic');
    }
    if (temporalResult.memoryCount > 0) {
      activeLayers.push('temporal');
    }

    if (activeLayers.length === 2) {
      allCategories.add('full_convergence'); // Both methods found memories
      allCategories.add(`${activeLayers.join('_')}_convergence`);
    }

    return Array.from(allCategories);
  }

  /**
   * Get entourage status for debugging and monitoring
   */
  getEntourageStatus(): string {
    return `🧠 CombinedMemoryEntourage Status:
📊 Active Layers: Semantic + Temporal (2-layer system)
🎯 Pattern: Entourage auto-insertion (parallel search)
🎲 Variety: Stochastic fusion patterns (5 fusion modes)
📈 Performance: ~200ms semantic + ~150ms temporal
⚡ Token Budget: 60% semantic, 40% temporal
🔗 Convergence: Full validation between layers
✨ Philosophy: Multiple perspectives > single perfect answer`;
  }
}
