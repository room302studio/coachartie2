import { logger } from '@coachartie/shared';
import { MemoryEntourageInterface, MemoryEntourageResult } from './memory-entourage-interface.js';
import { MemoryService } from '../capabilities/memory.js';
import { openRouterService } from './openrouter.js';

/**
 * BasicKeywordMemoryEntourage - Semantic stochastic expansion with cosine similarity
 * 
 * Enhanced with:
 * - Multi-vector semantic expansion
 * - NLP entity extraction for SQL query hacking  
 * - Stochastic variance for exploratory search
 * - Colinear concept mapping
 */
export class BasicKeywordMemoryEntourage implements MemoryEntourageInterface {
  private memoryService: MemoryService;
  private conceptCache = new Map<string, string[]>();
  private entityPatterns: Record<string, RegExp[]>;

  constructor() {
    this.memoryService = MemoryService.getInstance();
    
    // Pre-compiled entity extraction patterns for SQL query hacking
    this.entityPatterns = {
      FOOD: [
        /\b(pizza|burger|taco|sandwich|salad|pasta|sushi|ramen|curry|steak|coffee|tea|beer|wine)\b/gi,
        /\b(restaurant|cafe|bar|diner|bakery|brewery|kitchen|food|cooking|recipe)\b/gi
      ],
      PLACE: [
        /\b([A-Z][a-z]+ (?:Street|Ave|Road|Drive|Boulevard))\b/g,
        /\b([A-Z][a-z]+, [A-Z]{2})\b/g,
        /\b(NYC|LA|SF|Boston|Chicago|Seattle|Portland|Austin|Miami|Atlanta|Fishkill)\b/gi
      ],
      ACTIVITY: [
        /\b(coding|debugging|testing|building|designing|writing|reading|hiking|cooking|working)\b/gi,
        /\b(meeting|project|deadline|sprint|demo|presentation|episode|creative)\b/gi
      ],
      TIME: [
        /\b(\d{4}|yesterday|today|tomorrow|last week|next month)\b/gi,
        /\b(morning|afternoon|evening|night|weekend)\b/gi
      ]
    };
    
    logger.info('🧬 Enhanced BasicKeywordMemoryEntourage with semantic expansion engine');
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
      // 🧬 SEMANTIC STOCHASTIC EXPANSION ENGINE
      const keywords = this.extractKeywords(userMessage);
      const entities = this.extractEntities(userMessage);
      const expandedTerms = await this.semanticExpansion(userMessage, keywords, options.priority);
      
      const allSearchTerms = [...keywords, ...expandedTerms];
      
      if (allSearchTerms.length === 0) {
        logger.debug('📝 No search terms extracted, skipping memory search');
        return {
          content: '',
          confidence: 0.0,
          memoryCount: 0,
          categories: ['no_keywords'],
          memoryIds: []
        };
      }

      // Multi-vector search with entity-enhanced SQL queries
      const searchLimit = this.calculateSearchLimit(options.priority, options.maxTokens);
      const searchQueries = this.buildEnhancedSearchQueries(allSearchTerms, entities, options.priority);
      
      logger.info(`🔍 Enhanced search: ${keywords.length} keywords + ${expandedTerms.length} expanded + ${entities.length} entities`);
      
      // Execute parallel searches for maximum recall
      const memoryResults = await this.executeParallelSearches(userId, searchQueries, searchLimit);
      
      // Parse the enhanced memory service response
      const parsedMemories = this.parseMemoryResult(memoryResults);
      
      if (parsedMemories.length === 0) {
        return {
          content: '',
          confidence: 0.0,
          memoryCount: 0,
          categories: ['no_matches'],
          memoryIds: []
        };
      }

      // Apply stochastic variety and format for context
      const formattedContent = this.formatMemoriesWithVariety(parsedMemories, userMessage, options.maxTokens);
      const confidence = this.calculateConfidence(parsedMemories, keywords);
      const categories = this.detectMemoryCategories(parsedMemories);

      logger.info(`🧠 BasicKeywordMemoryEntourage found ${parsedMemories.length} memories (confidence: ${confidence.toFixed(2)})`);

      // 🔍 Get memory IDs from the memory service
      const memoryIds = this.memoryService.lastRecallMemoryIds || [];
      
      return {
        content: formattedContent,
        confidence,
        memoryCount: parsedMemories.length,
        categories,
        memoryIds
      };

    } catch (error) {
      logger.error('❌ BasicKeywordMemoryEntourage failed:', error);
      
      // Graceful degradation
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
   * Extract meaningful keywords from user message for memory search
   */
  private extractKeywords(message: string): string[] {
    const words = message.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length >= 3);

    // Remove common stop words
    const stopWords = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 
      'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 
      'how', 'its', 'may', 'new', 'now', 'old', 'see', 'two', 'way', 'who',
      'what', 'when', 'where', 'why', 'how', 'tell', 'me', 'about', 'do',
      'does', 'did', 'will', 'would', 'could', 'should', 'like', 'want'
    ]);

    const keywords = words.filter(word => !stopWords.has(word));
    
    // Prioritize longer, more specific words
    keywords.sort((a, b) => b.length - a.length);
    
    return keywords.slice(0, 5); // Limit to top 5 keywords
  }

  /**
   * 🧬 Extract entities using NLP patterns for SQL query hacking
   */
  private extractEntities(message: string): Array<{text: string, type: string, confidence: number}> {
    const entities: Array<{text: string, type: string, confidence: number}> = [];

    for (const [entityType, patterns] of Object.entries(this.entityPatterns)) {
      for (const pattern of patterns) {
        const matches = message.match(pattern);
        if (matches) {
          for (const match of matches) {
            entities.push({
              text: match.trim(),
              type: entityType,
              confidence: this.calculateEntityConfidence(match, entityType)
            });
          }
        }
      }
    }

    // Deduplicate and sort by confidence
    return entities
      .filter((entity, index, arr) => 
        arr.findIndex(e => e.text.toLowerCase() === entity.text.toLowerCase()) === index
      )
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 8); // Top 8 entities
  }

  /**
   * 🚀 Semantic expansion using LLM for colinear concept mapping
   */
  private async semanticExpansion(
    userMessage: string, 
    baseKeywords: string[], 
    priority: 'speed' | 'accuracy' | 'comprehensive' = 'speed'
  ): Promise<string[]> {
    const cacheKey = baseKeywords.join('|');
    if (this.conceptCache.has(cacheKey)) {
      return this.conceptCache.get(cacheKey)!;
    }

    // Skip LLM expansion for speed mode
    if (priority === 'speed') {
      return this.fastSemanticExpansion(baseKeywords);
    }

    try {
      const expansionPrompt = `Query: "${userMessage}"
Key terms: ${baseKeywords.join(', ')}

Find 3-5 related memory search terms that could help recall similar experiences, topics, or contexts. Focus on:
- Synonyms and related concepts
- Activities or contexts that might be associated
- Emotional or experiential connections

Return only the search terms, comma-separated:`;

      const response = await openRouterService.generateFromMessageChain([{
        role: 'user', content: expansionPrompt
      }], 'system');
      
      // Parse LLM response
      const expandedTerms = response
        .toLowerCase()
        .split(/[,\n]/)
        .map((term: string) => term.trim())
        .filter((term: string) => term.length >= 3 && term.length <= 20)
        .slice(0, 8);

      // Cache for future use
      this.conceptCache.set(cacheKey, expandedTerms);
      
      logger.debug(`🧬 LLM expanded: ${baseKeywords} → ${expandedTerms}`);
      return expandedTerms;

    } catch (error) {
      logger.warn('LLM semantic expansion failed, using fallback:', error);
      return this.fastSemanticExpansion(baseKeywords);
    }
  }

  /**
   * Fast semantic expansion using pre-defined mappings
   */
  private fastSemanticExpansion(baseKeywords: string[]): string[] {
    const expansionMap: Record<string, string[]> = {
      pizza: ['food', 'restaurant', 'italian', 'cooking', 'meal', 'atlanta', 'episode'],
      coding: ['programming', 'development', 'debugging', 'tech', 'project'],
      meeting: ['work', 'discussion', 'team', 'project', 'collaboration'],
      travel: ['trip', 'vacation', 'location', 'visit', 'journey'],
      debugging: ['testing', 'fixing', 'coding', 'problem', 'system']
    };

    const expanded: string[] = [];
    for (const keyword of baseKeywords) {
      const related = expansionMap[keyword.toLowerCase()];
      if (related) {
        // Stochastic selection for variety
        const selected = related.sort(() => Math.random() - 0.5).slice(0, 3);
        expanded.push(...selected);
      }
    }

    return [...new Set(expanded)]; // Deduplicate
  }

  /**
   * 💥 Build enhanced search queries with entity SQL hacking
   */
  private buildEnhancedSearchQueries(
    searchTerms: string[], 
    entities: Array<{text: string, type: string, confidence: number}>, 
    priority: 'speed' | 'accuracy' | 'comprehensive' = 'speed'
  ): string[] {
    const queries: string[] = [];

    // Primary keyword searches
    for (const term of searchTerms.slice(0, 5)) {
      queries.push(term);
    }

    // Entity-based searches for high-confidence entities
    for (const entity of entities.filter(e => e.confidence > 0.6).slice(0, 3)) {
      queries.push(entity.text);
    }

    // Combination searches for comprehensive mode
    if (priority === 'comprehensive' && searchTerms.length >= 2) {
      for (let i = 0; i < Math.min(3, searchTerms.length - 1); i++) {
        queries.push(`${searchTerms[i]} ${searchTerms[i + 1]}`);
      }
    }

    return queries.slice(0, 8); // Limit total queries
  }

  /**
   * 🔄 Execute parallel searches for maximum memory recall
   */
  private async executeParallelSearches(
    userId: string, 
    queries: string[], 
    limit: number
  ): Promise<string> {
    try {
      // Execute searches in parallel for speed
      const searchPromises = queries.map(query => 
        this.memoryService.recall(userId, query, Math.ceil(limit / queries.length))
      );

      const results = await Promise.all(searchPromises);
      
      // Combine and deduplicate results
      const allMemories = results.join('\n\n').trim();
      
      logger.debug(`🔄 Parallel search executed: ${queries.length} queries, found memories: ${allMemories.length > 0}`);
      
      return allMemories;

    } catch (error) {
      logger.warn('Parallel search failed, falling back to single query:', error);
      
      // Fallback to single best query
      const bestQuery = queries[0] || '';
      return await this.memoryService.recall(userId, bestQuery, limit);
    }
  }

  /**
   * Calculate entity confidence based on pattern strength
   */
  private calculateEntityConfidence(match: string, entityType: string): number {
    let confidence = 0.5;
    
    // Boost for length and specific patterns
    if (match.length > 5) {confidence += 0.2;}
    if (match.length > 10) {confidence += 0.1;}
    
    // Type-specific boosts
    if (entityType === 'FOOD' && /pizza|atlanta|restaurant/.test(match.toLowerCase())) {
      confidence += 0.3;
    }
    
    return Math.min(1.0, confidence);
  }

  /**
   * Build search query based on keywords and priority
   */
  private buildSearchQuery(keywords: string[], priority: 'speed' | 'accuracy' | 'comprehensive' = 'speed'): string {
    if (keywords.length === 0) {return '';}
    
    switch (priority) {
      case 'speed':
        // Fast: Use primary keyword only
        return keywords[0];
        
      case 'accuracy':
        // Balanced: Use top 2-3 keywords
        return keywords.slice(0, 3).join(' ');
        
      case 'comprehensive':
        // Thorough: Use all keywords with OR logic
        return keywords.join(' OR ');
        
      default:
        return keywords[0];
    }
  }

  /**
   * Calculate search limit based on priority and token constraints
   */
  private calculateSearchLimit(priority: 'speed' | 'accuracy' | 'comprehensive' = 'speed', maxTokens?: number): number {
    const baseLimits = {
      speed: 3,
      accuracy: 5,
      comprehensive: 8
    };
    
    let limit = baseLimits[priority];
    
    // Adjust based on token budget
    if (maxTokens) {
      // Rough estimate: each memory ~100 tokens
      const tokenBasedLimit = Math.floor(maxTokens / 100);
      limit = Math.min(limit, Math.max(1, tokenBasedLimit));
    }
    
    return limit;
  }

  /**
   * Parse memory service result into structured format
   */
  private parseMemoryResult(memoryResult: string): Array<{content: string, importance: number, date: string, tags: string[]}> {
    const memories: Array<{content: string, importance: number, date: string, tags: string[]}> = [];
    
    if (!memoryResult || memoryResult.includes('No memories found')) {
      return memories;
    }

    // Parse the formatted memory response
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
          importance: memoryMatch[2].length, // Count stars
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
    
    // Add the last memory
    if (currentMemory) {
      memories.push(currentMemory);
    }
    
    return memories;
  }

  /**
   * Format memories with stochastic variety for natural context
   */
  private formatMemoriesWithVariety(
    memories: Array<{content: string, importance: number, date: string, tags: string[]}>, 
    userMessage: string, 
    maxTokens?: number
  ): string {
    if (memories.length === 0) {return '';}

    // Apply stochastic selection for variety
    const selectedMemories = this.selectMemoriesWithVariety(memories, maxTokens);
    
    // Random variation in formatting style
    const styles = [
      'contextual',
      'direct', 
      'conversational'
    ];
    const style = styles[Math.floor(Math.random() * styles.length)];
    
    return this.formatMemoriesByStyle(selectedMemories, style, userMessage);
  }

  /**
   * Select memories with stochastic variety to avoid repetitive patterns
   */
  private selectMemoriesWithVariety(
    memories: Array<{content: string, importance: number, date: string, tags: string[]}>,
    maxTokens?: number
  ): Array<{content: string, importance: number, date: string, tags: string[]}> {
    if (memories.length <= 2) {return memories;}
    
    // Always include the highest importance memory
    const sorted = [...memories].sort((a, b) => b.importance - a.importance);
    const selected = [sorted[0]];
    
    // Stochastically select additional memories
    const remaining = sorted.slice(1);
    const maxAdditional = maxTokens ? Math.floor((maxTokens - 100) / 80) : 2; // ~80 tokens per additional memory
    
    for (let i = 0; i < Math.min(maxAdditional, remaining.length); i++) {
      // Weighted random selection (higher importance = higher chance)
      const weights = remaining.map(m => m.importance + 1); // +1 to avoid zero weights
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
      weights.splice(selectedIndex, 1);
    }
    
    return selected;
  }

  /**
   * Format memories using different style variations
   */
  private formatMemoriesByStyle(
    memories: Array<{content: string, importance: number, date: string, tags: string[]}>,
    style: string,
    userMessage: string
  ): string {
    const memoryTexts = memories.map(m => m.content);
    
    switch (style) {
      case 'contextual':
        return `Based on what I remember: ${memoryTexts.join(', and ')}`;
        
      case 'direct':
        return `Relevant memories:\n${memoryTexts.map((text, i) => `• ${text}`).join('\n')}`;
        
      case 'conversational':
        const connector = memories.length > 1 ? 'I recall a few things: ' : 'I remember that ';
        return `${connector}${memoryTexts.join('. Also, ')}.`;
        
      default:
        return memoryTexts.join('\n');
    }
  }

  /**
   * Calculate confidence score based on keyword matching and memory quality
   */
  private calculateConfidence(
    memories: Array<{content: string, importance: number, date: string, tags: string[]}>,
    keywords: string[]
  ): number {
    if (memories.length === 0) {return 0.0;}
    
    let totalScore = 0;
    let maxScore = 0;
    
    for (const memory of memories) {
      const content = memory.content.toLowerCase();
      const tags = memory.tags.map(tag => tag.toLowerCase());
      
      let matchScore = 0;
      
      // Score for keyword matches in content
      for (const keyword of keywords) {
        if (content.includes(keyword)) {
          matchScore += 1;
        }
      }
      
      // Score for keyword matches in tags
      for (const keyword of keywords) {
        for (const tag of tags) {
          if (tag.includes(keyword)) {
            matchScore += 0.5;
          }
        }
      }
      
      // Weight by importance
      const weightedScore = matchScore * (memory.importance / 5);
      totalScore += weightedScore;
      maxScore += keywords.length * (memory.importance / 5);
    }
    
    const confidence = maxScore > 0 ? Math.min(1.0, totalScore / maxScore) : 0.0;
    return Math.max(0.1, confidence); // Minimum confidence for found memories
  }

  /**
   * Detect categories of memories found
   */
  private detectMemoryCategories(
    memories: Array<{content: string, importance: number, date: string, tags: string[]}>
  ): string[] {
    const categories = new Set<string>();
    
    for (const memory of memories) {
      // Check content patterns
      const content = memory.content.toLowerCase();
      
      if (content.includes('like') || content.includes('prefer') || content.includes('favorite')) {
        categories.add('preferences');
      }
      
      if (content.includes('food') || content.includes('eat') || content.includes('taste')) {
        categories.add('food');
      }
      
      if (content.includes('work') || content.includes('job') || content.includes('project')) {
        categories.add('work');
      }
      
      // Check tags
      for (const tag of memory.tags) {
        const tagLower = tag.toLowerCase();
        if (['preference', 'like', 'favorite'].includes(tagLower)) {
          categories.add('preferences');
        }
        if (['food', 'cooking', 'restaurant'].includes(tagLower)) {
          categories.add('food');
        }
        if (['work', 'project', 'task'].includes(tagLower)) {
          categories.add('work');
        }
      }
    }
    
    if (categories.size === 0) {
      categories.add('general');
    }
    
    return Array.from(categories);
  }
}