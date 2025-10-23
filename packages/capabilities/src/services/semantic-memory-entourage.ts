import { logger } from '@coachartie/shared';
import { MemoryEntourageInterface, MemoryEntourageResult } from './memory-entourage-interface.js';
import { MemoryService } from '../capabilities/memory.js';
import { vectorEmbeddingService } from './vector-embeddings.js';

/**
 * SemanticMemoryEntourage - Real OpenAI vector-based semantic memory search
 *
 * This layer uses OpenAI's text-embedding-3-small model to find memories
 * that are semantically related through cosine similarity of embeddings.
 * Falls back to TF-IDF when OpenAI API is unavailable.
 */
export class SemanticMemoryEntourage implements MemoryEntourageInterface {
  private memoryService: MemoryService;
  private semanticCache = new Map<string, number[]>();

  constructor() {
    this.memoryService = MemoryService.getInstance();
    // Initialize vector service on construction
    vectorEmbeddingService.initialize().catch(err =>
      logger.warn('🚧 SemanticMemoryEntourage: Vector service init failed, will use TF-IDF fallback')
    );
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
        memoryIds: []
      };
    }

    try {
      // Try real vector search first if available
      if (vectorEmbeddingService.isReady()) {
        logger.info('🧠 SemanticMemoryEntourage: Using real OpenAI vector search');

        const limit = this.getSemanticLimit(options);
        const vectorResults = await vectorEmbeddingService.findSimilarMemories(
          userMessage,
          limit,
          0.5 // Lower threshold for semantic relevance
        );

        if (vectorResults.length > 0) {
          // Format vector search results
          const formattedContent = this.formatVectorResults(vectorResults, userMessage);
          const confidence = this.calculateVectorConfidence(vectorResults);
          const memoryIds = vectorResults.map(r => r.memory_id.toString());

          logger.info(`🧠 SemanticMemoryEntourage: Found ${vectorResults.length} vector matches (avg similarity: ${(confidence * 100).toFixed(1)}%)`);

          return {
            content: formattedContent,
            confidence,
            memoryCount: vectorResults.length,
            categories: ['semantic', 'vector_based', 'openai_embeddings'],
            memoryIds
          };
        }
      }

      // Fall back to TF-IDF if vector search unavailable or no results
      logger.info('🧠 SemanticMemoryEntourage: Using TF-IDF fallback for semantic search');

      // Get all memories for the user (we need to analyze them semantically)
      const allMemoriesResult = await this.memoryService.recall(userId, '', 50); // Get more for analysis
      const memories = this.parseMemoryResult(allMemoriesResult);

      if (memories.length === 0) {
        return {
          content: '',
          confidence: 0.0,
          memoryCount: 0,
          categories: ['no_memories'],
          memoryIds: []
        };
      }

      // Calculate semantic similarity scores
      const semanticMatches = await this.findSemanticMatches(userMessage, memories, options);

      if (semanticMatches.length === 0) {
        return {
          content: '',
          confidence: 0.0,
          memoryCount: 0,
          categories: ['no_semantic_matches'],
          memoryIds: []
        };
      }

      // Format results with stochastic variety
      const formattedContent = this.formatSemanticMemories(semanticMatches, userMessage, options.maxTokens);
      const confidence = this.calculateSemanticConfidence(semanticMatches);
      const categories = this.detectSemanticCategories(semanticMatches);

      logger.info(`🧠 SemanticMemoryEntourage: Found ${semanticMatches.length} TF-IDF matches (confidence: ${confidence.toFixed(2)})`);

      // 🔍 Get memory IDs from semantic matches (using dummy IDs for TF-IDF)
      const memoryIds = semanticMatches.map((_, index) => `tfidf_${index}`);

      return {
        content: formattedContent,
        confidence,
        memoryCount: semanticMatches.length,
        categories,
        memoryIds
      };

    } catch (error) {
      logger.error('❌ SemanticMemoryEntourage failed:', error);
      
      return {
        content: '',
        confidence: 0.0,
        memoryCount: 0,
        categories: ['error'],
        memoryIds: []
      };
    }
  }

  /**
   * Find memories with semantic similarity using TF-IDF approach
   */
  private async findSemanticMatches(
    userMessage: string,
    memories: Array<{content: string, importance: number, date: string, tags: string[]}>,
    options: any
  ): Promise<Array<{content: string, importance: number, date: string, tags: string[], semanticScore: number}>> {
    const queryVector = this.createTfIdfVector(userMessage);
    const matches: Array<{content: string, importance: number, date: string, tags: string[], semanticScore: number}> = [];

    for (const memory of memories) {
      const memoryVector = this.createTfIdfVector(memory.content);
      const similarity = this.calculateCosineSimilarity(queryVector, memoryVector);
      
      // Only include memories with meaningful semantic similarity
      if (similarity > 0.1) {
        matches.push({
          ...memory,
          semanticScore: similarity
        });
      }
    }

    // Sort by semantic score and apply limits
    matches.sort((a, b) => b.semanticScore - a.semanticScore);
    
    const limit = this.getSemanticLimit(options);
    return matches.slice(0, limit);
  }

  /**
   * Create TF-IDF vector for text (lightweight semantic representation)
   */
  private createTfIdfVector(text: string): Map<string, number> {
    const cacheKey = text.toLowerCase().slice(0, 100); // Cache shorter version
    
    if (this.semanticCache.has(cacheKey)) {
      return new Map(this.semanticCache.get(cacheKey)!.map((val, idx) => [`term_${idx}`, val]));
    }

    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length >= 3);

    // Remove common stop words
    const stopWords = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
      'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his',
      'how', 'its', 'may', 'new', 'now', 'old', 'see', 'two', 'way', 'who',
      'what', 'when', 'where', 'why', 'tell', 'about', 'said', 'each', 'which'
    ]);

    const filteredWords = words.filter(word => !stopWords.has(word));
    
    // Calculate term frequency
    const termFreq = new Map<string, number>();
    filteredWords.forEach(word => {
      termFreq.set(word, (termFreq.get(word) || 0) + 1);
    });

    // Normalize by document length (simple TF)
    const maxFreq = Math.max(...termFreq.values());
    const normalizedVector = new Map<string, number>();
    
    termFreq.forEach((freq, term) => {
      normalizedVector.set(term, freq / maxFreq);
    });

    return normalizedVector;
  }

  /**
   * Calculate cosine similarity between two TF-IDF vectors
   */
  private calculateCosineSimilarity(vectorA: Map<string, number>, vectorB: Map<string, number>): number {
    const termsA = new Set(vectorA.keys());
    const termsB = new Set(vectorB.keys());
    const commonTerms = new Set([...termsA].filter(term => termsB.has(term)));

    if (commonTerms.size === 0) {return 0;}

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    // Calculate dot product and norms
    for (const term of commonTerms) {
      const valA = vectorA.get(term) || 0;
      const valB = vectorB.get(term) || 0;
      dotProduct += valA * valB;
    }

    // Calculate norms
    for (const val of vectorA.values()) {
      normA += val * val;
    }
    for (const val of vectorB.values()) {
      normB += val * val;
    }

    if (normA === 0 || normB === 0) {return 0;}

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Parse memory service result (reuse logic from BasicKeywordMemoryEntourage)
   */
  private parseMemoryResult(memoryResult: string): Array<{content: string, importance: number, date: string, tags: string[]}> {
    const memories: Array<{content: string, importance: number, date: string, tags: string[]}> = [];
    
    if (!memoryResult || memoryResult.includes('No memories found')) {
      return memories;
    }

    const lines = memoryResult.split('\n');
    let currentMemory: any = null;
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Match memory entries (1. **content** ⭐⭐⭐)
      const memoryMatch = trimmed.match(/^\d+\.\s*\*\*(.*?)\*\*\s*(⭐*)/);
      if (memoryMatch) {
        if (currentMemory) {
          memories.push(currentMemory);
        }
        
        currentMemory = {
          content: memoryMatch[1],
          importance: memoryMatch[2].length,
          date: '',
          tags: []
        };
        continue;
      }
      
      // Match metadata lines (📅 date | 🏷️ tags)
      const metaMatch = trimmed.match(/📅\s*(.*?)\s*\|\s*🏷️\s*(.*?)(?:\s*\|\s*📝|$)/);
      if (metaMatch && currentMemory) {
        currentMemory.date = metaMatch[1];
        const tagString = metaMatch[2];
        if (tagString && tagString !== 'no tags') {
          currentMemory.tags = tagString.split(',').map(tag => tag.trim());
        }
      }
    }
    
    if (currentMemory) {
      memories.push(currentMemory);
    }
    
    return memories;
  }

  /**
   * Get semantic search limit based on options
   */
  private getSemanticLimit(options: any): number {
    const baseLimits = {
      speed: 3,
      accuracy: 4,
      comprehensive: 6
    };
    
    const priority = options.priority || 'speed';
    let limit = baseLimits[priority as keyof typeof baseLimits];
    
    // Adjust for token budget
    if (options.maxTokens) {
      const tokenBasedLimit = Math.floor(options.maxTokens / 120); // ~120 tokens per semantic memory
      limit = Math.min(limit, Math.max(1, tokenBasedLimit));
    }
    
    return limit;
  }

  /**
   * Format semantic memories with contextual variety
   */
  private formatSemanticMemories(
    matches: Array<{content: string, importance: number, date: string, tags: string[], semanticScore: number}>,
    userMessage: string,
    maxTokens?: number
  ): string {
    if (matches.length === 0) {return '';}

    // Apply stochastic selection
    const selectedMemories = this.selectSemanticMemoriesWithVariety(matches, maxTokens);
    
    // Format with semantic context
    const styles = [
      'semantic_contextual',
      'semantic_direct',
      'semantic_analytical'
    ];
    const style = styles[Math.floor(Math.random() * styles.length)];
    
    return this.formatBySemanticStyle(selectedMemories, style, userMessage);
  }

  /**
   * Select semantic memories with stochastic variety
   */
  private selectSemanticMemoriesWithVariety(
    matches: Array<{content: string, importance: number, date: string, tags: string[], semanticScore: number}>,
    maxTokens?: number
  ): Array<{content: string, importance: number, date: string, tags: string[], semanticScore: number}> {
    if (matches.length <= 2) {return matches;}
    
    // Always include highest semantic score
    const sorted = [...matches].sort((a, b) => b.semanticScore - a.semanticScore);
    const selected = [sorted[0]];
    
    // Stochastically select additional matches
    const remaining = sorted.slice(1);
    const maxAdditional = maxTokens ? Math.floor((maxTokens - 120) / 100) : 2;
    
    for (let i = 0; i < Math.min(maxAdditional, remaining.length); i++) {
      // Weight by semantic score and importance
      const weights = remaining.map(m => (m.semanticScore * 10) + (m.importance / 5));
      const totalWeight = weights.reduce((sum, w) => sum + w, 0);
      
      let random = Math.random() * totalWeight;
      let selectedIndex = 0;
      
      for (let j = 0; j < weights.length; j++) {
        random -= weights[j];
        if (random <= 0) {
          selectedIndex = j;
          break;
        }
      }
      
      selected.push(remaining[selectedIndex]);
      remaining.splice(selectedIndex, 1);
    }
    
    return selected;
  }

  /**
   * Format memories by semantic style
   */
  private formatBySemanticStyle(
    memories: Array<{content: string, importance: number, date: string, tags: string[], semanticScore: number}>,
    style: string,
    userMessage: string
  ): string {
    const memoryTexts = memories.map(m => m.content);
    
    switch (style) {
      case 'semantic_contextual':
        return `This reminds me of: ${memoryTexts.join(', and also ')}.`;
        
      case 'semantic_direct':
        return `Related memories:\n${memoryTexts.map((text, i) => 
          `• ${text} (${(memories[i].semanticScore * 100).toFixed(0)}% relevance)`
        ).join('\n')}`;
        
      case 'semantic_analytical':
        const avgScore = memories.reduce((sum, m) => sum + m.semanticScore, 0) / memories.length;
        return `Based on semantic patterns (${(avgScore * 100).toFixed(0)}% relevance): ${memoryTexts.join('. Additionally, ')}.`;
        
      default:
        return memoryTexts.join('\n');
    }
  }

  /**
   * Calculate confidence based on semantic scores
   */
  private calculateSemanticConfidence(
    matches: Array<{content: string, importance: number, date: string, tags: string[], semanticScore: number}>
  ): number {
    if (matches.length === 0) {return 0.0;}
    
    const avgSemanticScore = matches.reduce((sum, m) => sum + m.semanticScore, 0) / matches.length;
    const avgImportance = matches.reduce((sum, m) => sum + m.importance, 0) / matches.length;
    
    // Combine semantic score with importance (semantic score is primary)
    const confidence = (avgSemanticScore * 0.8) + ((avgImportance / 5) * 0.2);
    
    return Math.max(0.1, Math.min(1.0, confidence));
  }

  /**
   * Detect semantic categories from matches
   */
  private detectSemanticCategories(
    matches: Array<{content: string, importance: number, date: string, tags: string[], semanticScore: number}>
  ): string[] {
    const categories = new Set<string>();
    categories.add('semantic');

    // Add based on semantic strength
    const highSemanticMatches = matches.filter(m => m.semanticScore > 0.3);
    if (highSemanticMatches.length > 0) {
      categories.add('high_relevance');
    }

    // Add patterns detected in content
    for (const match of matches) {
      const content = match.content.toLowerCase();

      if (content.includes('feel') || content.includes('emotion') || content.includes('mood')) {
        categories.add('emotional');
      }

      if (content.includes('plan') || content.includes('goal') || content.includes('want')) {
        categories.add('planning');
      }

      if (content.includes('learn') || content.includes('understand') || content.includes('know')) {
        categories.add('learning');
      }
    }

    return Array.from(categories);
  }

  /**
   * Format vector search results with variety
   */
  private formatVectorResults(
    results: Array<{memory_id: number, similarity_score: number, content: string}>,
    userMessage: string
  ): string {
    if (results.length === 0) return '';

    // Apply stochastic formatting
    const styles = [
      'vector_contextual',
      'vector_similarity',
      'vector_narrative'
    ];
    const style = styles[Math.floor(Math.random() * styles.length)];

    switch (style) {
      case 'vector_contextual':
        return `Based on deep semantic understanding: ${results.map(r => r.content).join('. Also relevant: ')}.`;

      case 'vector_similarity':
        return results.map(r =>
          `${r.content} (${(r.similarity_score * 100).toFixed(0)}% semantic match)`
        ).join('\n');

      case 'vector_narrative':
        const avgSimilarity = results.reduce((sum, r) => sum + r.similarity_score, 0) / results.length;
        return `Semantically related (${(avgSimilarity * 100).toFixed(0)}% avg relevance): ${results.map(r => r.content).join(', and ')}.`;

      default:
        return results.map(r => r.content).join('\n');
    }
  }

  /**
   * Calculate confidence from vector similarity scores
   */
  private calculateVectorConfidence(
    results: Array<{memory_id: number, similarity_score: number, content: string}>
  ): number {
    if (results.length === 0) return 0.0;

    // Average similarity score represents confidence
    const avgSimilarity = results.reduce((sum, r) => sum + r.similarity_score, 0) / results.length;

    // Boost confidence if we have multiple high-quality matches
    const highQualityMatches = results.filter(r => r.similarity_score > 0.7).length;
    const boost = Math.min(0.2, highQualityMatches * 0.05);

    return Math.min(1.0, avgSimilarity + boost);
  }
}