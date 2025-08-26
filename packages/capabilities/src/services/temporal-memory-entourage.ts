import { logger } from '@coachartie/shared';
import { MemoryEntourageInterface, MemoryEntourageResult } from './memory-entourage-interface.js';
import { MemoryService } from '../capabilities/memory.js';

/**
 * TemporalMemoryEntourage - Time-aware memory search layer
 * 
 * This layer adds temporal intelligence to memory recall by:
 * 1. Prioritizing recent memories for current context
 * 2. Finding memories from similar times of day/week
 * 3. Detecting temporal patterns in user behavior
 * 4. Surfacing historically relevant memories
 */
export class TemporalMemoryEntourage implements MemoryEntourageInterface {
  private memoryService: MemoryService;

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
      logger.info('⏰ TemporalMemoryEntourage: Starting temporal pattern analysis');
      
      // Get recent memories directly from the database (more reliable than recall with empty string)
      const recentMemories = await this.memoryService.getRecentMemories(userId, 50);
      const memories = recentMemories.map(memory => ({
        content: memory.content,
        importance: memory.importance,
        date: memory.timestamp,
        tags: memory.tags
      }));
      
      logger.info(`⏰ TemporalMemoryEntourage: Retrieved ${memories.length} memories for temporal analysis`);
      
      if (memories.length === 0) {
        return {
          content: '',
          confidence: 0.0,
          memoryCount: 0,
          categories: ['no_memories'],
          memoryIds: []
        };
      }

      // Apply temporal intelligence
      const temporalMatches = this.findTemporalPatterns(userMessage, memories, options);
      
      if (temporalMatches.length === 0) {
        return {
          content: '',
          confidence: 0.0,
          memoryCount: 0,
          categories: ['no_temporal_patterns'],
          memoryIds: []
        };
      }

      // Format with temporal context
      const formattedContent = this.formatTemporalMemories(temporalMatches, userMessage, options.maxTokens);
      const confidence = this.calculateTemporalConfidence(temporalMatches);
      const categories = this.detectTemporalCategories(temporalMatches);

      logger.info(`⏰ TemporalMemoryEntourage found ${temporalMatches.length} temporal patterns (confidence: ${confidence.toFixed(2)})`);

      // 🔍 Get memory IDs from temporal matches (using dummy IDs for now)
      const memoryIds = temporalMatches.map((_, index) => `temporal_${index}`);
      
      return {
        content: formattedContent,
        confidence,
        memoryCount: temporalMatches.length,
        categories,
        memoryIds
      };

    } catch (error) {
      logger.error('❌ TemporalMemoryEntourage failed:', error);
      
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
   * Find temporal patterns in memories based on current context
   */
  private findTemporalPatterns(
    userMessage: string,
    memories: Array<{content: string, importance: number, date: string, tags: string[]}>,
    options: any
  ): Array<{content: string, importance: number, date: string, tags: string[], temporalScore: number, temporalType: string}> {
    const now = new Date();
    const matches: Array<{content: string, importance: number, date: string, tags: string[], temporalScore: number, temporalType: string}> = [];

    for (const memory of memories) {
      const memoryDate = this.parseMemoryDate(memory.date);
      if (!memoryDate) continue;

      const temporalAnalysis = this.analyzeTemporalRelevance(userMessage, memory, memoryDate, now);
      
      // Debug logging for temporal scores
      if (memories.indexOf(memory) < 3) { // Log first few for debugging
        logger.info(`⏰ Memory "${memory.content.substring(0, 30)}..." from ${memory.date} scored ${temporalAnalysis.score.toFixed(3)} (${temporalAnalysis.type})`);
      }
      
      if (temporalAnalysis.score > 0.05) {
        matches.push({
          ...memory,
          temporalScore: temporalAnalysis.score,
          temporalType: temporalAnalysis.type
        });
      }
    }

    // Sort by temporal relevance
    matches.sort((a, b) => b.temporalScore - a.temporalScore);
    
    const limit = this.getTemporalLimit(options);
    return matches.slice(0, limit);
  }

  /**
   * Analyze temporal relevance of a memory to current context
   * SIMPLIFIED: Focus on recent memories (24-48 hours) for reliable results
   */
  private analyzeTemporalRelevance(
    userMessage: string,
    memory: any,
    memoryDate: Date,
    currentDate: Date
  ): {score: number, type: string} {
    const timeDelta = currentDate.getTime() - memoryDate.getTime();
    const hoursDelta = timeDelta / (1000 * 60 * 60);
    const daysDelta = timeDelta / (1000 * 60 * 60 * 24);
    
    // SIMPLE RECENT MEMORY SCORING - focus on last 24-48 hours
    let recentScore = 0;
    let type = 'general';
    
    if (hoursDelta <= 6) {
      // Very recent - last 6 hours
      recentScore = 0.9;
      type = 'very_recent';
    } else if (hoursDelta <= 24) {
      // Recent - last 24 hours  
      recentScore = 0.7;
      type = 'recent';
    } else if (daysDelta <= 2) {
      // Past 2 days
      recentScore = 0.5;
      type = 'recent';
    } else if (daysDelta <= 7) {
      // Past week
      recentScore = 0.3;
      type = 'week_old';
    } else {
      // Older memories get minimal score unless they have contextual relevance
      recentScore = 0.1;
      type = 'old';
    }
    
    // Simple contextual boost for temporal keywords
    const temporalKeywords = this.extractTemporalKeywords(userMessage);
    if (temporalKeywords.length > 0) {
      const contextualBoost = this.getSimpleContextualBoost(memory.content, temporalKeywords);
      recentScore += contextualBoost;
    }
    
    // Cap the score at 1.0
    const finalScore = Math.min(recentScore, 1.0);
    
    return { score: finalScore, type };
  }

  /**
   * Simple contextual boost for temporal keywords (replaces complex matchTemporalContext)
   */
  private getSimpleContextualBoost(memoryContent: string, temporalKeywords: string[]): number {
    if (temporalKeywords.length === 0) return 0;
    
    const contentLower = memoryContent.toLowerCase();
    let boost = 0;
    
    for (const keyword of temporalKeywords) {
      if (contentLower.includes(keyword.toLowerCase())) {
        boost += 0.1; // Small boost per matching keyword
      }
    }
    
    // Special boosts for high-relevance temporal words
    if (temporalKeywords.some(kw => ['today', 'recently', 'now', 'just'].includes(kw.toLowerCase()))) {
      boost += 0.2;
    }
    
    return Math.min(boost, 0.4); // Cap contextual boost
  }

  /**
   * Extract temporal keywords from user message
   */
  private extractTemporalKeywords(message: string): string[] {
    const temporalPatterns = [
      // Time references
      /\b(today|yesterday|tomorrow|now|recently|lately|earlier|later)\b/gi,
      /\b(morning|afternoon|evening|night|dawn|dusk)\b/gi,
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
      /\b(weekend|weekday|week|month|year)\b/gi,
      // Seasonal/cyclical
      /\b(spring|summer|fall|autumn|winter|holiday|birthday)\b/gi,
      // Temporal modifiers
      /\b(always|usually|often|sometimes|rarely|never|before|after|during|since)\b/gi
    ];
    
    const keywords: string[] = [];
    for (const pattern of temporalPatterns) {
      const matches = message.match(pattern);
      if (matches) {
        keywords.push(...matches.map(m => m.toLowerCase()));
      }
    }
    
    return [...new Set(keywords)]; // Remove duplicates
  }

  /**
   * Match temporal context between query and memory
   */
  private matchTemporalContext(
    memoryContent: string,
    temporalKeywords: string[],
    memoryDate: Date,
    currentDate: Date
  ): number {
    if (temporalKeywords.length === 0) return 0;
    
    let score = 0;
    const contentLower = memoryContent.toLowerCase();
    
    for (const keyword of temporalKeywords) {
      if (contentLower.includes(keyword)) {
        score += 0.1;
      }
      
      // Contextual temporal matching
      if (keyword === 'recently' && this.isRecent(memoryDate, currentDate, 7)) score += 0.2;
      if (keyword === 'yesterday' && this.isDaysAgo(memoryDate, currentDate, 1)) score += 0.3;
      if (keyword === 'today' && this.isToday(memoryDate, currentDate)) score += 0.4;
      if (keyword === 'weekend' && this.isWeekend(memoryDate)) score += 0.2;
      if (keyword === 'morning' && this.isMorning(memoryDate)) score += 0.15;
      if (keyword === 'evening' && this.isEvening(memoryDate)) score += 0.15;
    }
    
    return Math.min(score, 0.8); // Cap contextual score
  }

  /**
   * Detect historical significance (anniversaries, patterns)
   */
  private detectHistoricalSignificance(memory: any, memoryDate: Date, currentDate: Date): number {
    // Anniversary detection (same day, different year)
    if (memoryDate.getMonth() === currentDate.getMonth() && 
        memoryDate.getDate() === currentDate.getDate() &&
        memoryDate.getFullYear() !== currentDate.getFullYear()) {
      return 0.6; // Strong historical relevance
    }
    
    // Monthly patterns (same day of month)
    if (memoryDate.getDate() === currentDate.getDate()) {
      return 0.2;
    }
    
    // Important content markers
    const content = memory.content.toLowerCase();
    const importantMarkers = ['birthday', 'anniversary', 'graduation', 'wedding', 'promotion', 'milestone'];
    for (const marker of importantMarkers) {
      if (content.includes(marker)) {
        return 0.4;
      }
    }
    
    return 0;
  }

  /**
   * Parse memory date string into Date object
   */
  private parseMemoryDate(dateString: string): Date | null {
    if (!dateString || dateString === '') return null;
    
    try {
      // Handle various date formats
      const date = new Date(dateString);
      return isNaN(date.getTime()) ? null : date;
    } catch {
      return null;
    }
  }

  /**
   * Parse memory service result (reuse existing logic)
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

  // Temporal utility functions
  private isRecent(memoryDate: Date, currentDate: Date, days: number): boolean {
    const timeDelta = currentDate.getTime() - memoryDate.getTime();
    return timeDelta <= (days * 24 * 60 * 60 * 1000);
  }

  private isDaysAgo(memoryDate: Date, currentDate: Date, days: number): boolean {
    const timeDelta = currentDate.getTime() - memoryDate.getTime();
    const daysDelta = timeDelta / (1000 * 60 * 60 * 24);
    return Math.abs(daysDelta - days) < 0.5;
  }

  private isToday(memoryDate: Date, currentDate: Date): boolean {
    return memoryDate.toDateString() === currentDate.toDateString();
  }

  private isWeekend(date: Date): boolean {
    const day = date.getDay();
    return day === 0 || day === 6;
  }

  private isMorning(date: Date): boolean {
    const hour = date.getHours();
    return hour >= 6 && hour < 12;
  }

  private isEvening(date: Date): boolean {
    const hour = date.getHours();
    return hour >= 18 && hour < 22;
  }

  private getTemporalLimit(options: any): number {
    const baseLimits = {
      speed: 2,
      accuracy: 3,
      comprehensive: 5
    };
    
    const priority = options.priority || 'speed';
    let limit = baseLimits[priority as keyof typeof baseLimits];
    
    if (options.maxTokens) {
      const tokenBasedLimit = Math.floor(options.maxTokens / 100);
      limit = Math.min(limit, Math.max(1, tokenBasedLimit));
    }
    
    return limit;
  }

  private formatTemporalMemories(
    matches: Array<{content: string, importance: number, date: string, tags: string[], temporalScore: number, temporalType: string}>,
    userMessage: string,
    maxTokens?: number
  ): string {
    if (matches.length === 0) return '';

    const selectedMemories = this.selectTemporalMemoriesWithVariety(matches, maxTokens);
    
    // SIMPLIFIED FORMATTING: Clear and consistent temporal context
    const memoryTexts = selectedMemories.map(memory => {
      const timeAgo = this.formatRelativeTime(memory.date);
      return `${timeAgo}: ${memory.content}`;
    });
    
    // Simple, clear format that LLMs can easily understand
    if (selectedMemories.length === 1) {
      const memory = selectedMemories[0];
      if (memory.temporalType === 'very_recent' || memory.temporalType === 'recent') {
        return `Recently, you ${memory.content.toLowerCase().replace(/^(remember that )?i? ?/i, '')}`;
      }
      return `From your recent activity: ${memory.content}`;
    } else {
      return `Recent timeline:\n${memoryTexts.join('\n')}`;
    }
  }

  private selectTemporalMemoriesWithVariety(
    matches: Array<{content: string, importance: number, date: string, tags: string[], temporalScore: number, temporalType: string}>,
    maxTokens?: number
  ): Array<{content: string, importance: number, date: string, tags: string[], temporalScore: number, temporalType: string}> {
    if (matches.length <= 2) return matches;
    
    const sorted = [...matches].sort((a, b) => b.temporalScore - a.temporalScore);
    const selected = [sorted[0]]; // Always include highest temporal score
    
    const remaining = sorted.slice(1);
    const maxAdditional = maxTokens ? Math.floor((maxTokens - 100) / 90) : 2;
    
    for (let i = 0; i < Math.min(maxAdditional, remaining.length); i++) {
      // Weight by temporal score and type diversity
      const weights = remaining.map((m, idx) => {
        let weight = m.temporalScore * 10;
        // Boost for temporal type diversity
        const existingTypes = selected.map(s => s.temporalType);
        if (!existingTypes.includes(m.temporalType)) {
          weight += 2;
        }
        return weight;
      });
      
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

  private formatByTemporalStyle(
    memories: Array<{content: string, importance: number, date: string, tags: string[], temporalScore: number, temporalType: string}>,
    style: string,
    userMessage: string
  ): string {
    const memoryTexts = memories.map(m => m.content);
    
    switch (style) {
      case 'temporal_contextual':
        const temporalContext = this.getTemporalContext(memories);
        return `${temporalContext}: ${memoryTexts.join(', and ')}.`;
        
      case 'temporal_chronological':
        // Sort by date and present chronologically
        const sortedByDate = [...memories].sort((a, b) => 
          new Date(a.date).getTime() - new Date(b.date).getTime()
        );
        return `Timeline of memories:\n${sortedByDate.map((m, i) => 
          `${this.formatRelativeTime(m.date)}: ${m.content}`
        ).join('\n')}`;
        
      case 'temporal_pattern':
        const patterns = this.detectTemporalPatterns(memories);
        return `${patterns}: ${memoryTexts.join('. Also, ')}.`;
        
      default:
        return memoryTexts.join('\n');
    }
  }

  private getTemporalContext(memories: Array<{temporalType: string}>): string {
    const types = memories.map(m => m.temporalType);
    if (types.includes('recent')) return 'From recent memory';
    if (types.includes('historical')) return 'Looking back';
    if (types.includes('time_of_day')) return 'Around this time';
    if (types.includes('day_of_week')) return 'Similar to today';
    return 'From what I remember';
  }

  private formatRelativeTime(dateString: string): string {
    const date = new Date(dateString);
    const now = new Date();
    const timeDelta = now.getTime() - date.getTime();
    const daysDelta = Math.floor(timeDelta / (1000 * 60 * 60 * 24));
    
    if (daysDelta === 0) return 'Today';
    if (daysDelta === 1) return 'Yesterday';
    if (daysDelta < 7) return `${daysDelta} days ago`;
    if (daysDelta < 30) return `${Math.floor(daysDelta / 7)} weeks ago`;
    if (daysDelta < 365) return `${Math.floor(daysDelta / 30)} months ago`;
    return `${Math.floor(daysDelta / 365)} years ago`;
  }

  private detectTemporalPatterns(memories: Array<{temporalType: string}>): string {
    const typeCount = new Map<string, number>();
    memories.forEach(m => {
      typeCount.set(m.temporalType, (typeCount.get(m.temporalType) || 0) + 1);
    });
    
    const dominantType = Array.from(typeCount.entries())
      .sort(([,a], [,b]) => b - a)[0]?.[0];
    
    switch (dominantType) {
      case 'recent': return 'From recent patterns';
      case 'historical': return 'From historical patterns';
      case 'time_of_day': return 'From similar times';
      case 'day_of_week': return 'From similar days';
      default: return 'From temporal patterns';
    }
  }

  private calculateTemporalConfidence(
    matches: Array<{temporalScore: number, importance: number}>
  ): number {
    if (matches.length === 0) return 0.0;
    
    const avgTemporalScore = matches.reduce((sum, m) => sum + m.temporalScore, 0) / matches.length;
    const avgImportance = matches.reduce((sum, m) => sum + m.importance, 0) / matches.length;
    
    // Temporal score is primary, importance is secondary
    const confidence = (avgTemporalScore * 0.8) + ((avgImportance / 5) * 0.2);
    
    return Math.max(0.1, Math.min(1.0, confidence));
  }

  private detectTemporalCategories(
    matches: Array<{temporalType: string, date: string}>
  ): string[] {
    const categories = new Set<string>();
    categories.add('temporal');
    
    const types = matches.map(m => m.temporalType);
    types.forEach(type => categories.add(type));
    
    // Add time-based categories
    const now = new Date();
    const hasRecent = matches.some(m => this.isRecent(new Date(m.date), now, 7));
    if (hasRecent) categories.add('recent_activity');
    
    const hasHistorical = matches.some(m => {
      const memDate = new Date(m.date);
      return now.getTime() - memDate.getTime() > (365 * 24 * 60 * 60 * 1000);
    });
    if (hasHistorical) categories.add('long_term');
    
    return Array.from(categories);
  }
}