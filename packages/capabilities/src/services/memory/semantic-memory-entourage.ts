import { logger } from '@coachartie/shared';
import { MemoryEntourageInterface, MemoryEntourageResult } from './memory-entourage-interface.js';
import { MemoryService } from '../../capabilities/memory/memory.js';

/**
 * SemanticMemoryEntourage - TF-IDF based semantic memory search
 *
 * Uses term frequency-inverse document frequency to find memories
 * that are semantically related to the user's query.
 * Simple, fast, no external API dependencies.
 */
export class SemanticMemoryEntourage implements MemoryEntourageInterface {
  private memoryService: MemoryService;
  private semanticCache = new Map<string, number[]>();

  constructor() {
    this.memoryService = MemoryService.getInstance();
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
      // Get recent memories for the user AND Artie's own memories (artie-social)
      const userMemories = await this.memoryService.getRecentMemories(userId, 30);

      // For Artie's own memories, get more and prioritize high-importance ones
      let artieMemories: any[] = [];
      if (userId !== 'artie-social') {
        const allArtieMemories = await this.memoryService.getRecentMemories('artie-social', 150);
        // Prioritize high-importance memories (importance >= 7) and include some recent ones
        const highImportance = allArtieMemories.filter(m => (m.importance || 5) >= 7);
        const recent = allArtieMemories.filter(m => (m.importance || 5) < 7).slice(0, 15);
        artieMemories = [...highImportance, ...recent];
      }

      const allMemories = [...userMemories, ...artieMemories];
      const memories = allMemories.map(m => ({
        content: m.content,
        importance: m.importance || 5,
        date: m.timestamp || new Date().toISOString(),
        tags: Array.isArray(m.tags) ? m.tags : []
      }));

      if (memories.length === 0) {
        return {
          content: '',
          confidence: 0.0,
          memoryCount: 0,
          categories: ['no_memories'],
          memoryIds: [],
        };
      }

      // Calculate semantic similarity scores using TF-IDF
      const semanticMatches = await this.findSemanticMatches(userMessage, memories, options);

      if (semanticMatches.length === 0) {
        return {
          content: '',
          confidence: 0.0,
          memoryCount: 0,
          categories: ['no_semantic_matches'],
          memoryIds: [],
        };
      }

      // Format results with stochastic variety
      const formattedContent = this.formatSemanticMemories(
        semanticMatches,
        userMessage,
        options.maxTokens
      );
      const confidence = this.calculateSemanticConfidence(semanticMatches);
      const categories = this.detectSemanticCategories(semanticMatches);

      logger.info(
        `🧠 SemanticMemoryEntourage: Found ${semanticMatches.length} matches (confidence: ${confidence.toFixed(2)})`
      );

      const memoryIds = semanticMatches.map((_, index) => `tfidf_${index}`);

      return {
        content: formattedContent,
        confidence,
        memoryCount: semanticMatches.length,
        categories,
        memoryIds,
      };
    } catch (error) {
      logger.error('❌ SemanticMemoryEntourage failed:', error);

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
   * Find memories with semantic similarity using TF-IDF
   */
  private async findSemanticMatches(
    userMessage: string,
    memories: Array<{ content: string; importance: number; date: string; tags: string[] }>,
    options: any
  ): Promise<
    Array<{
      content: string;
      importance: number;
      date: string;
      tags: string[];
      semanticScore: number;
    }>
  > {
    const queryVector = this.createTfIdfVector(userMessage);
    const matches: Array<{
      content: string;
      importance: number;
      date: string;
      tags: string[];
      semanticScore: number;
    }> = [];

    for (const memory of memories) {
      const memoryVector = this.createTfIdfVector(memory.content);
      const similarity = this.calculateCosineSimilarity(queryVector, memoryVector);

      // Lower threshold for high-importance memories to ensure they're included
      const threshold = memory.importance >= 7 ? 0.02 : 0.08;
      if (similarity > threshold) {
        matches.push({
          ...memory,
          semanticScore: similarity,
        });
      }
    }

    // Sort by weighted score: semantic similarity + importance boost
    // High importance memories (7+) get a significant boost
    matches.sort((a, b) => {
      const importanceBoostA = a.importance >= 7 ? 0.3 : (a.importance >= 5 ? 0.1 : 0);
      const importanceBoostB = b.importance >= 7 ? 0.3 : (b.importance >= 5 ? 0.1 : 0);
      const scoreA = a.semanticScore + importanceBoostA;
      const scoreB = b.semanticScore + importanceBoostB;
      return scoreB - scoreA;
    });

    const limit = this.getSemanticLimit(options);
    return matches.slice(0, limit);
  }

  /**
   * Create TF-IDF vector for text
   */
  private createTfIdfVector(text: string): Map<string, number> {
    const cacheKey = text.toLowerCase().slice(0, 100);

    if (this.semanticCache.has(cacheKey)) {
      return new Map(this.semanticCache.get(cacheKey)!.map((val, idx) => [`term_${idx}`, val]));
    }

    const words = text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 3);

    // Remove common stop words
    const stopWords = new Set([
      'the',
      'and',
      'for',
      'are',
      'but',
      'not',
      'you',
      'all',
      'can',
      'had',
      'her',
      'was',
      'one',
      'our',
      'out',
      'day',
      'get',
      'has',
      'him',
      'his',
      'how',
      'its',
      'may',
      'new',
      'now',
      'old',
      'see',
      'two',
      'way',
      'who',
      'what',
      'when',
      'where',
      'why',
      'tell',
      'about',
      'said',
      'each',
      'which',
    ]);

    const filteredWords = words.filter((word) => !stopWords.has(word));

    // Calculate term frequency
    const termFreq = new Map<string, number>();
    filteredWords.forEach((word) => {
      termFreq.set(word, (termFreq.get(word) || 0) + 1);
    });

    // Normalize by document length
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
  private calculateCosineSimilarity(
    vectorA: Map<string, number>,
    vectorB: Map<string, number>
  ): number {
    const termsA = new Set(vectorA.keys());
    const termsB = new Set(vectorB.keys());
    const commonTerms = new Set([...termsA].filter((term) => termsB.has(term)));

    if (commonTerms.size === 0) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (const term of commonTerms) {
      const valA = vectorA.get(term) || 0;
      const valB = vectorB.get(term) || 0;
      dotProduct += valA * valB;
    }

    for (const val of vectorA.values()) {
      normA += val * val;
    }
    for (const val of vectorB.values()) {
      normB += val * val;
    }

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Parse memory service result
   */
  private parseMemoryResult(
    memoryResult: string
  ): Array<{ content: string; importance: number; date: string; tags: string[] }> {
    const memories: Array<{ content: string; importance: number; date: string; tags: string[] }> =
      [];

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
          tags: [],
        };
        continue;
      }

      // Match metadata lines
      const metaMatch = trimmed.match(/📅\s*(.*?)\s*\|\s*🏷️\s*(.*?)(?:\s*\|\s*📝|$)/);
      if (metaMatch && currentMemory) {
        currentMemory.date = metaMatch[1];
        const tagString = metaMatch[2];
        if (tagString && tagString !== 'no tags') {
          currentMemory.tags = tagString.split(',').map((tag: string) => tag.trim());
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
      comprehensive: 6,
    };

    const priority = options.priority || 'speed';
    let limit = baseLimits[priority as keyof typeof baseLimits];

    if (options.maxTokens) {
      const tokenBasedLimit = Math.floor(options.maxTokens / 120);
      limit = Math.min(limit, Math.max(1, tokenBasedLimit));
    }

    return limit;
  }

  /**
   * Format semantic memories with contextual variety
   */
  private formatSemanticMemories(
    matches: Array<{
      content: string;
      importance: number;
      date: string;
      tags: string[];
      semanticScore: number;
    }>,
    userMessage: string,
    maxTokens?: number
  ): string {
    if (matches.length === 0) {
      return '';
    }

    const selectedMemories = this.selectSemanticMemoriesWithVariety(matches, maxTokens);
    const styles = ['contextual', 'direct', 'analytical'];
    const style = styles[Math.floor(Math.random() * styles.length)];

    return this.formatByStyle(selectedMemories, style);
  }

  /**
   * Select memories with stochastic variety
   */
  private selectSemanticMemoriesWithVariety(
    matches: Array<{
      content: string;
      importance: number;
      date: string;
      tags: string[];
      semanticScore: number;
    }>,
    maxTokens?: number
  ): Array<{
    content: string;
    importance: number;
    date: string;
    tags: string[];
    semanticScore: number;
  }> {
    if (matches.length <= 2) {
      return matches;
    }

    const sorted = [...matches].sort((a, b) => b.semanticScore - a.semanticScore);
    const selected = [sorted[0]];

    const remaining = sorted.slice(1);
    const maxAdditional = maxTokens ? Math.floor((maxTokens - 120) / 100) : 2;

    for (let i = 0; i < Math.min(maxAdditional, remaining.length); i++) {
      const weights = remaining.map((m) => m.semanticScore * 10 + m.importance / 5);
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
   * Format memories by style
   */
  private formatByStyle(
    memories: Array<{
      content: string;
      importance: number;
      date: string;
      tags: string[];
      semanticScore: number;
    }>,
    style: string
  ): string {
    const memoryTexts = memories.map((m) => m.content);

    switch (style) {
      case 'contextual':
        return `This reminds me of: ${memoryTexts.join(', and also ')}.`;

      case 'direct':
        return `Related memories:\n${memoryTexts
          .map(
            (text, i) => `• ${text} (${(memories[i].semanticScore * 100).toFixed(0)}% relevance)`
          )
          .join('\n')}`;

      case 'analytical': {
        const avgScore = memories.reduce((sum, m) => sum + m.semanticScore, 0) / memories.length;
        return `Based on semantic patterns (${(avgScore * 100).toFixed(0)}% relevance): ${memoryTexts.join('. Additionally, ')}.`;
      }

      default:
        return memoryTexts.join('\n');
    }
  }

  /**
   * Calculate confidence based on semantic scores
   */
  private calculateSemanticConfidence(
    matches: Array<{
      content: string;
      importance: number;
      date: string;
      tags: string[];
      semanticScore: number;
    }>
  ): number {
    if (matches.length === 0) {
      return 0.0;
    }

    const avgSemanticScore = matches.reduce((sum, m) => sum + m.semanticScore, 0) / matches.length;
    const avgImportance = matches.reduce((sum, m) => sum + m.importance, 0) / matches.length;

    const confidence = avgSemanticScore * 0.8 + (avgImportance / 5) * 0.2;

    return Math.max(0.1, Math.min(1.0, confidence));
  }

  /**
   * Detect semantic categories from matches
   */
  private detectSemanticCategories(
    matches: Array<{
      content: string;
      importance: number;
      date: string;
      tags: string[];
      semanticScore: number;
    }>
  ): string[] {
    const categories = new Set<string>();
    categories.add('semantic');

    const highSemanticMatches = matches.filter((m) => m.semanticScore > 0.3);
    if (highSemanticMatches.length > 0) {
      categories.add('high_relevance');
    }

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
}
