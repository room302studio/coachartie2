import { logger } from '@coachartie/shared';
import { MemoryEntourageInterface, MemoryEntourageResult } from './memory-entourage-interface.js';
import { SemanticMemoryEntourage } from './semantic-memory-entourage.js';
import { TemporalMemoryEntourage } from './temporal-memory-entourage.js';

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
      logger.info('│ 🧠 Running 2-LAYER PARALLEL SEARCH:');
      logger.info(
        `│ Priority Mode: ${options.priority || 'speed'} | Max Tokens: ${options.maxTokens || 800}`
      );

      // Calculate token budget for each layer (60/40 split: semantic gets more)
      const tokenBudget = this.calculateLayerTokenBudgets(options.maxTokens);
      logger.info(
        `│ Token Split: Semantic=${tokenBudget.semantic}, Temporal=${tokenBudget.temporal}`
      );

      // Run memory searches in parallel (entourage pattern)
      const startTime = Date.now();
      const [semanticResult, temporalResult] = await Promise.all([
        this.semanticEntourage.getMemoryContext(userMessage, userId, {
          ...options,
          maxTokens: tokenBudget.semantic,
        }),
        this.temporalEntourage.getMemoryContext(userMessage, userId, {
          ...options,
          maxTokens: tokenBudget.temporal,
        }),
      ]);
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
      logger.info('│ └───────────────────────────────────────────────────────────┘');

      // Combine results intelligently
      const combinedResult = this.fuseMemoryResults(
        semanticResult,
        temporalResult,
        userMessage,
        options
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
  private calculateLayerTokenBudgets(maxTokens?: number): {
    semantic: number;
    temporal: number;
  } {
    const totalBudget = maxTokens || 800;

    // Allocate tokens: Semantic gets priority for better contextual understanding
    // Semantic: 60% (more important for accurate matches)
    // Temporal: 40% (good for context timing)
    const semanticBudget = Math.floor(totalBudget * 0.6);
    const temporalBudget = Math.floor(totalBudget * 0.4);

    return {
      semantic: semanticBudget,
      temporal: temporalBudget,
    };
  }

  /**
   * Fuse results from multiple memory entourages intelligently
   */
  private fuseMemoryResults(
    : MemoryEntourageResult,
    semanticResult: MemoryEntourageResult,
    temporalResult: MemoryEntourageResult,
    userMessage: string,
    options: any
  ): MemoryEntourageResult {
    // Handle case where no layer found memories
    if (
      .memoryCount === 0 &&
      semanticResult.memoryCount === 0 &&
      temporalResult.memoryCount === 0
    ) {
      return {
        content: '',
        confidence: 0.0,
        memoryCount: 0,
        categories: ['no_matches'],
        memoryIds: [],
      };
    }

    // Handle cases where only one or two layers found memories
    const activeLayers = [];
    if (.memoryCount > 0) {
      activeLayers.push({ name: 'keyword', result:  });
    }
    if (semanticResult.memoryCount > 0) {
      activeLayers.push({ name: 'semantic', result: semanticResult });
    }
    if (temporalResult.memoryCount > 0) {
      activeLayers.push({ name: 'temporal', result: temporalResult });
    }

    if (activeLayers.length === 1) {
      return {
        ...activeLayers[0].result,
        categories: [...activeLayers[0].result.categories, `${activeLayers[0].name}_only`],
      };
    }

    // Multiple layers found memories - intelligent fusion
    const fusedContent = this.fuseMemoryContent(
      
      semanticResult,
      temporalResult,
      options
    );
    const fusedConfidence = this.fuseConfidenceScores(
      
      semanticResult,
      temporalResult
    );
    const fusedCategories = this.fuseCategories( semanticResult, temporalResult);
    const fusedMemoryIds = this.fuseMemoryIds( semanticResult, temporalResult);
    const totalMemoryCount =
      .memoryCount + semanticResult.memoryCount + temporalResult.memoryCount;

    return {
      content: fusedContent,
      confidence: fusedConfidence,
      memoryCount: totalMemoryCount,
      categories: fusedCategories,
      memoryIds: fusedMemoryIds,
    };
  }

  /**
   * Fuse memory content from multiple sources with variety
   */
  private fuseMemoryContent(
    : MemoryEntourageResult,
    semanticResult: MemoryEntourageResult,
    temporalResult: MemoryEntourageResult,
    options: any
  ): string {
    const keywordContent = .content.trim();
    const semanticContent = semanticResult.content.trim();
    const temporalContent = temporalResult.content.trim();

    const contents = [keywordContent, semanticContent, temporalContent].filter((c) => c.length > 0);
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
      case 'layered':
        let layered = '';
        if (keywordContent) {
          layered += keywordContent;
        }
        if (semanticContent) {
          layered += layered ? `\n\nRelated: ${semanticContent.toLowerCase()}` : semanticContent;
        }
        if (temporalContent) {
          layered += layered ? `\n\nTiming: ${temporalContent.toLowerCase()}` : temporalContent;
        }
        return layered;

      case 'interleaved':
        return contents.join(' ');

      case 'comparative':
        let comparative = '';
        if (keywordContent) {
          comparative += `Direct: ${keywordContent}`;
        }
        if (semanticContent) {
          comparative += comparative
            ? `\nConceptual: ${semanticContent}`
            : `Conceptual: ${semanticContent}`;
        }
        if (temporalContent) {
          comparative += comparative
            ? `\nTemporal: ${temporalContent}`
            : `Temporal: ${temporalContent}`;
        }
        return comparative;

      case 'synthesized':
        return `From what I remember: ${contents.join('. This connects to ')}.`;

      case 'temporal_flow':
        if (temporalContent) {
          const others = [keywordContent, semanticContent].filter((c) => c.length > 0);
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
    : MemoryEntourageResult,
    semanticResult: MemoryEntourageResult,
    temporalResult: MemoryEntourageResult
  ): number {
    // Weight confidence scores based on reliability and complementarity
    const keywordWeight = 0.5; // Most reliable for direct matches
    const semanticWeight = 0.3; // Good for conceptual connections
    const temporalWeight = 0.2; // Excellent for context timing

    const fusedConfidence =
      .confidence * keywordWeight +
      semanticResult.confidence * semanticWeight +
      temporalResult.confidence * temporalWeight;

    // Boost confidence based on convergent validation (multiple layers finding memories)
    const activeLayers = [ semanticResult, temporalResult].filter(
      (r) => r.memoryCount > 0
    ).length;
    const convergenceBoost =
      {
        1: 0, // Single layer
        2: 0.1, // Two layers agree
        3: 0.15, // All three layers agree - highest confidence
      }[activeLayers] || 0;

    return Math.min(1.0, fusedConfidence + convergenceBoost);
  }

  /**
   * Fuse memory IDs from multiple sources
   */
  private fuseMemoryIds(
    : MemoryEntourageResult,
    semanticResult: MemoryEntourageResult,
    temporalResult: MemoryEntourageResult
  ): string[] {
    // Combine and deduplicate memory IDs from all layers
    const allMemoryIds = new Set([
      ...(.memoryIds || []),
      ...(semanticResult.memoryIds || []),
      ...(temporalResult.memoryIds || []),
    ]);

    return Array.from(allMemoryIds);
  }

  /**
   * Fuse categories from multiple sources
   */
  private fuseCategories(
    : MemoryEntourageResult,
    semanticResult: MemoryEntourageResult,
    temporalResult: MemoryEntourageResult
  ): string[] {
    const allCategories = new Set([
      ....categories,
      ...semanticResult.categories,
      ...temporalResult.categories,
    ]);

    // Add fusion-specific categories
    allCategories.add('three_layer_combined');

    // Add convergence categories based on which layers found memories
    const activeLayers = [];
    if (.memoryCount > 0) {
      activeLayers.push('keyword');
    }
    if (semanticResult.memoryCount > 0) {
      activeLayers.push('semantic');
    }
    if (temporalResult.memoryCount > 0) {
      activeLayers.push('temporal');
    }

    if (activeLayers.length === 3) {
      allCategories.add('full_convergence'); // All three methods found memories
    } else if (activeLayers.length === 2) {
      allCategories.add('partial_convergence');
      allCategories.add(`${activeLayers.join('_')}_convergence`);
    }

    return Array.from(allCategories);
  }

  /**
   * Get entourage status for debugging and monitoring
   */
  getEntourageStatus(): string {
    return `🧠 CombinedMemoryEntourage Status:
📊 Active Layers: Keyword + Semantic + Temporal (3-layer system)
🎯 Pattern: Entourage auto-insertion (parallel search)
🎲 Variety: Stochastic fusion patterns (5 fusion modes)
📈 Performance: ~100ms keyword + ~200ms semantic + ~150ms temporal
⚡ Token Budget: 50% keyword, 30% semantic, 20% temporal
🔗 Convergence: Full/partial validation between layers
✨ Philosophy: Multiple perspectives > single perfect answer`;
  }
}
