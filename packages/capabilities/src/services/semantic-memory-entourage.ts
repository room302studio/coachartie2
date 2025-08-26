import { logger } from '@coachartie/shared';
import { MemoryEntourageInterface, MemoryEntourageResult } from './memory-entourage-interface.js';
import { MemoryService } from '../capabilities/memory.js';

/**
 * SemanticMemoryEntourage - Adds semantic similarity to memory search
 * 
 * This layer complements BasicKeywordMemoryEntourage by finding memories
 * that are semantically related even without keyword matches.
 * Uses lightweight TF-IDF similarity for now (can upgrade to vectors later).
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
        memoryIds: []
      };
    }

    try {
      logger.info('🧠 SemanticMemoryEntourage: Starting semantic similarity search');
      
      // Get all memories for the user using getRecentMemories (more reliable than empty query)
      const recentMemories = await this.memoryService.getRecentMemories(userId, 50);
      const memories = recentMemories.map(memory => ({
        content: memory.content,
        importance: memory.importance,
        date: memory.timestamp,
        tags: memory.tags
      }));
      
      logger.info(`🧠 SemanticMemoryEntourage: Retrieved ${memories.length} memories for semantic analysis`);
      if (memories.length > 0) {
        logger.info(`🧠 First few memories: ${memories.slice(0, 3).map(m => m.content.substring(0, 40) + '...').join(', ')}`);
      }
      
      if (memories.length === 0) {
        logger.info('🧠 SemanticMemoryEntourage: No memories found to analyze');
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

      logger.info(`🧠 SemanticMemoryEntourage found ${semanticMatches.length} semantic matches (confidence: ${confidence.toFixed(2)})`);

      // 🔍 Get memory IDs from semantic matches - get actual memory IDs from recent memories
      const memoryIds = semanticMatches.map((match) => {
        // Find the original memory by content to get its real ID
        const originalMemory = recentMemories.find(mem => mem.content === match.content);
        return originalMemory ? String(originalMemory.id) : `semantic_unknown`;
      });
      
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
      
      // Only include memories with meaningful semantic similarity (lowered threshold for better recall)
      if (similarity > 0.02) {
        matches.push({
          ...memory,
          semanticScore: similarity
        });
        logger.info(`🧠 Added semantic match: "${memory.content.substring(0, 30)}..." (score: ${similarity.toFixed(3)})`);
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
    // Get all unique terms from both vectors
    const allTerms = new Set([...vectorA.keys(), ...vectorB.keys()]);
    
    if (allTerms.size === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    // Calculate dot product using all terms (0 for missing terms)
    for (const term of allTerms) {
      const valA = vectorA.get(term) || 0;
      const valB = vectorB.get(term) || 0;
      dotProduct += valA * valB;
    }

    // Calculate norms using all terms
    for (const val of vectorA.values()) {
      normA += val * val;
    }
    for (const val of vectorB.values()) {
      normB += val * val;
    }

    if (normA === 0 || normB === 0) return 0;

    const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    
    // Debug logging for similarity calculation
    if (similarity > 0.05) {
      logger.info(`🧠 Semantic similarity: ${similarity.toFixed(3)} (${Math.sqrt(normA).toFixed(2)} × ${Math.sqrt(normB).toFixed(2)} = ${(Math.sqrt(normA) * Math.sqrt(normB)).toFixed(2)})`);
    }
    
    return similarity;
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
    if (matches.length === 0) return '';

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
    if (matches.length <= 2) return matches;
    
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
    if (matches.length === 0) return 0.0;
    
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
}