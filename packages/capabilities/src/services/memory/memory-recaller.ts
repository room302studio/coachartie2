import { logger } from '@coachartie/shared';
import { MemoryEntourageInterface, MemoryEntourageResult } from './memory-entourage-interface.js';
import { MemoryService } from '../../capabilities/memory/memory.js';
import { hybridDataLayer } from '../../runtime/hybrid-data-layer.js';

/**
 * MemoryRecaller - unified semantic + temporal memory recall.
 *
 * Replaces the former CombinedMemoryEntourage / SemanticMemoryEntourage /
 * TemporalMemoryEntourage trio. Both signals are preserved faithfully:
 *   • Semantic: TF-IDF cosine similarity to the user's message (lexical relevance).
 *   • Temporal: recency decay + time-of-day / day-of-week / historical patterns.
 * The previous design fetched the candidate set twice and selected results with
 * random "fusion pattern" theater; this fetches once and selects deterministic
 * top-K, but keeps the exact scoring math, thresholds, confidence and fusion.
 */

interface Candidate {
  content: string;
  importance: number;
  date: string;
  tags: string[];
}
type SemanticMatch = Candidate & { semanticScore: number };
type TemporalMatch = Candidate & { temporalScore: number; temporalType: string };

interface RecallOptions {
  maxTokens?: number;
  priority?: 'speed' | 'accuracy' | 'comprehensive';
  minimal?: boolean;
  guildId?: string;
}

const empty = (categories: string[], confidence = 0): MemoryEntourageResult => ({
  content: '',
  confidence,
  memoryCount: 0,
  categories,
  memoryIds: [],
});

export class MemoryRecaller implements MemoryEntourageInterface {
  private memoryService: MemoryService;

  constructor() {
    this.memoryService = MemoryService.getInstance();
    logger.info('🧠 MemoryRecaller: unified semantic + temporal recall initialized');
  }

  async getMemoryContext(
    userMessage: string,
    userId: string,
    options: RecallOptions = {}
  ): Promise<MemoryEntourageResult> {
    if (options.minimal) {
      return empty(['minimal'], 1.0);
    }

    try {
      const budget = this.tokenBudget(options.maxTokens, !!options.guildId);
      const candidates = await this.fetchCandidates(userId);

      const semantic =
        candidates.length > 0
          ? this.semanticLayer(userMessage, candidates, options.priority, budget.semantic)
          : empty(['no_memories']);
      const temporal =
        candidates.length > 0
          ? this.temporalLayer(userMessage, candidates, options.priority, budget.temporal)
          : empty(['no_memories']);
      const guild = options.guildId
        ? await this.guildLayer(options.guildId, budget.guild)
        : undefined;

      return this.fuse(semantic, temporal, guild);
    } catch (error) {
      logger.error('❌ MemoryRecaller failed:', error);
      return empty(['error']);
    }
  }

  // --------------------------------------------------------------------------
  // Candidate fetch (single pass — superset of what the old two layers pulled)
  // --------------------------------------------------------------------------
  private async fetchCandidates(userId: string): Promise<Candidate[]> {
    const userMemories = await this.memoryService.getRecentMemories(userId, 60);

    let artieMemories: any[] = [];
    if (userId !== 'artie-social') {
      const allArtie = await this.memoryService.getRecentMemories('artie-social', 150);
      const highImportance = allArtie.filter((m) => (m.importance || 5) >= 7);
      const recent = allArtie.filter((m) => (m.importance || 5) < 7).slice(0, 20);
      artieMemories = [...highImportance, ...recent];
    }

    return [...userMemories, ...artieMemories].map((m) => ({
      content: m.content,
      importance: m.importance || 5,
      date: m.timestamp || new Date().toISOString(),
      tags: Array.isArray(m.tags) ? m.tags : [],
    }));
  }

  private tokenBudget(
    maxTokens?: number,
    includeGuild?: boolean
  ): { semantic: number; temporal: number; guild: number } {
    const total = maxTokens || 800;
    if (includeGuild) {
      // 45% semantic, 30% temporal, 25% guild
      return {
        semantic: Math.floor(total * 0.45),
        temporal: Math.floor(total * 0.3),
        guild: Math.floor(total * 0.25),
      };
    }
    // 60% semantic, 40% temporal
    return { semantic: Math.floor(total * 0.6), temporal: Math.floor(total * 0.4), guild: 0 };
  }

  private layerLimit(
    priority: RecallOptions['priority'],
    maxTokens: number | undefined,
    base: { speed: number; accuracy: number; comprehensive: number },
    tokensPerMemory: number
  ): number {
    let limit = base[priority || 'speed'];
    if (maxTokens) {
      const tokenBasedLimit = Math.floor(maxTokens / tokensPerMemory);
      limit = Math.min(limit, Math.max(1, tokenBasedLimit));
    }
    return limit;
  }

  /** Shared confidence formula: avg score weighted 0.8, avg importance 0.2. */
  private confidence(scores: number[], importances: number[]): number {
    if (scores.length === 0) {
      return 0;
    }
    const avgScore = scores.reduce((s, v) => s + v, 0) / scores.length;
    const avgImportance = importances.reduce((s, v) => s + v, 0) / importances.length;
    return Math.max(0.1, Math.min(1.0, avgScore * 0.8 + (avgImportance / 5) * 0.2));
  }

  // --------------------------------------------------------------------------
  // Semantic layer (TF-IDF cosine similarity)
  // --------------------------------------------------------------------------
  private semanticLayer(
    userMessage: string,
    candidates: Candidate[],
    priority: RecallOptions['priority'],
    maxTokens: number
  ): MemoryEntourageResult {
    const queryVector = this.tfidfVector(userMessage);
    const matches: SemanticMatch[] = [];

    for (const memory of candidates) {
      const similarity = this.cosineSimilarity(queryVector, this.tfidfVector(memory.content));
      const threshold = memory.importance >= 7 ? 0.02 : 0.08;
      if (similarity > threshold) {
        matches.push({ ...memory, semanticScore: similarity });
      }
    }

    matches.sort(
      (a, b) =>
        b.semanticScore + this.importanceBoost(b.importance) -
        (a.semanticScore + this.importanceBoost(a.importance))
    );

    const limit = this.layerLimit(
      priority,
      maxTokens,
      { speed: 3, accuracy: 4, comprehensive: 6 },
      120
    );
    const top = matches.slice(0, limit);
    if (top.length === 0) {
      return empty(['no_semantic_matches']);
    }

    const content = `This reminds me of: ${top.map((m) => m.content).join(', and also ')}.`;
    return {
      content,
      confidence: this.confidence(
        top.map((m) => m.semanticScore),
        top.map((m) => m.importance)
      ),
      memoryCount: top.length,
      categories: this.semanticCategories(top),
      memoryIds: top.map((_, i) => `tfidf_${i}`),
    };
  }

  private importanceBoost(importance: number): number {
    return importance >= 7 ? 0.3 : importance >= 5 ? 0.1 : 0;
  }

  private tfidfVector(text: string): Map<string, number> {
    const words = text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 3);

    const stopWords = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was',
      'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'may', 'new',
      'now', 'old', 'see', 'two', 'way', 'who', 'what', 'when', 'where', 'why', 'tell',
      'about', 'said', 'each', 'which',
    ]);

    const filteredWords = words.filter((word) => !stopWords.has(word));
    const termFreq = new Map<string, number>();
    filteredWords.forEach((word) => termFreq.set(word, (termFreq.get(word) || 0) + 1));

    if (termFreq.size === 0) {
      return termFreq;
    }
    const maxFreq = Math.max(...termFreq.values());
    const vector = new Map<string, number>();
    termFreq.forEach((freq, term) => vector.set(term, freq / maxFreq));
    return vector;
  }

  private cosineSimilarity(vectorA: Map<string, number>, vectorB: Map<string, number>): number {
    const commonTerms = new Set([...vectorA.keys()].filter((term) => vectorB.has(term)));
    if (commonTerms.size === 0) {
      return 0;
    }

    let dotProduct = 0;
    for (const term of commonTerms) {
      dotProduct += (vectorA.get(term) || 0) * (vectorB.get(term) || 0);
    }

    let normA = 0;
    for (const val of vectorA.values()) {
      normA += val * val;
    }
    let normB = 0;
    for (const val of vectorB.values()) {
      normB += val * val;
    }
    if (normA === 0 || normB === 0) {
      return 0;
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private semanticCategories(matches: SemanticMatch[]): string[] {
    const categories = new Set<string>(['semantic']);
    if (matches.some((m) => m.semanticScore > 0.3)) {
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

  // --------------------------------------------------------------------------
  // Temporal layer (recency + time-of-day / day-of-week / historical patterns)
  // --------------------------------------------------------------------------
  private temporalLayer(
    userMessage: string,
    candidates: Candidate[],
    priority: RecallOptions['priority'],
    maxTokens: number
  ): MemoryEntourageResult {
    const now = new Date();
    const matches: TemporalMatch[] = [];

    for (const memory of candidates) {
      const memoryDate = this.parseDate(memory.date);
      if (!memoryDate) {
        continue;
      }
      const analysis = this.temporalRelevance(userMessage, memory, memoryDate, now);
      if (analysis.score > 0.1) {
        matches.push({ ...memory, temporalScore: analysis.score, temporalType: analysis.type });
      }
    }

    matches.sort((a, b) => b.temporalScore - a.temporalScore);

    const limit = this.layerLimit(
      priority,
      maxTokens,
      { speed: 2, accuracy: 3, comprehensive: 5 },
      100
    );
    const top = matches.slice(0, limit);
    if (top.length === 0) {
      return empty(['no_temporal_patterns']);
    }

    const content = `${this.temporalFraming(top)}: ${top.map((m) => m.content).join(', and ')}.`;
    return {
      content,
      confidence: this.confidence(
        top.map((m) => m.temporalScore),
        top.map((m) => m.importance)
      ),
      memoryCount: top.length,
      categories: this.temporalCategories(top, now),
      memoryIds: top.map((_, i) => `temporal_${i}`),
    };
  }

  private temporalRelevance(
    userMessage: string,
    memory: Candidate,
    memoryDate: Date,
    currentDate: Date
  ): { score: number; type: string } {
    const daysDelta =
      (currentDate.getTime() - memoryDate.getTime()) / (1000 * 60 * 60 * 24);

    // Recent memory boost (exponential decay — strong for the last week)
    const recentScore = Math.exp(-daysDelta / 7) * 0.5;

    // Time-of-day similarity
    const hourDiff = Math.min(
      Math.abs(currentDate.getHours() - memoryDate.getHours()),
      24 - Math.abs(currentDate.getHours() - memoryDate.getHours())
    );
    const timeOfDayScore = ((6 - hourDiff) / 6) * 0.3;

    // Day-of-week match
    const dayOfWeekScore = currentDate.getDay() === memoryDate.getDay() ? 0.2 : 0;

    // Contextual temporal keywords in the query
    const contextualScore = this.matchTemporalContext(
      memory.content,
      this.extractTemporalKeywords(userMessage),
      memoryDate,
      currentDate
    );

    // Historical significance (anniversaries / milestones)
    const historicalScore = this.historicalSignificance(memory, memoryDate, currentDate);

    const totalScore = Math.max(
      recentScore,
      timeOfDayScore,
      dayOfWeekScore,
      contextualScore,
      historicalScore
    );

    let type = 'general';
    if (recentScore === totalScore) {
      type = 'recent';
    } else if (timeOfDayScore === totalScore) {
      type = 'time_of_day';
    } else if (dayOfWeekScore === totalScore) {
      type = 'day_of_week';
    } else if (contextualScore === totalScore) {
      type = 'contextual';
    } else if (historicalScore === totalScore) {
      type = 'historical';
    }

    return { score: totalScore, type };
  }

  private extractTemporalKeywords(message: string): string[] {
    const patterns = [
      /\b(today|yesterday|tomorrow|now|recently|lately|earlier|later)\b/gi,
      /\b(morning|afternoon|evening|night|dawn|dusk)\b/gi,
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
      /\b(weekend|weekday|week|month|year)\b/gi,
      /\b(spring|summer|fall|autumn|winter|holiday|birthday)\b/gi,
      /\b(always|usually|often|sometimes|rarely|never|before|after|during|since)\b/gi,
    ];
    const keywords: string[] = [];
    for (const pattern of patterns) {
      const found = message.match(pattern);
      if (found) {
        keywords.push(...found.map((m) => m.toLowerCase()));
      }
    }
    return [...new Set(keywords)];
  }

  private matchTemporalContext(
    memoryContent: string,
    keywords: string[],
    memoryDate: Date,
    currentDate: Date
  ): number {
    if (keywords.length === 0) {
      return 0;
    }
    let score = 0;
    const content = memoryContent.toLowerCase();
    for (const keyword of keywords) {
      if (content.includes(keyword)) {
        score += 0.1;
      }
      if (keyword === 'recently' && this.daysBetween(memoryDate, currentDate) <= 7) {
        score += 0.2;
      }
      if (keyword === 'yesterday' && Math.abs(this.daysBetween(memoryDate, currentDate) - 1) < 0.5) {
        score += 0.3;
      }
      if (keyword === 'today' && memoryDate.toDateString() === currentDate.toDateString()) {
        score += 0.4;
      }
      if (keyword === 'weekend' && (memoryDate.getDay() === 0 || memoryDate.getDay() === 6)) {
        score += 0.2;
      }
      if (keyword === 'morning' && memoryDate.getHours() >= 6 && memoryDate.getHours() < 12) {
        score += 0.15;
      }
      if (keyword === 'evening' && memoryDate.getHours() >= 18 && memoryDate.getHours() < 22) {
        score += 0.15;
      }
    }
    return Math.min(score, 0.8);
  }

  private historicalSignificance(
    memory: Candidate,
    memoryDate: Date,
    currentDate: Date
  ): number {
    // Anniversary (same month + day, different year)
    if (
      memoryDate.getMonth() === currentDate.getMonth() &&
      memoryDate.getDate() === currentDate.getDate() &&
      memoryDate.getFullYear() !== currentDate.getFullYear()
    ) {
      return 0.6;
    }
    // Same day of month
    if (memoryDate.getDate() === currentDate.getDate()) {
      return 0.2;
    }
    const content = memory.content.toLowerCase();
    for (const marker of ['birthday', 'anniversary', 'graduation', 'wedding', 'promotion', 'milestone']) {
      if (content.includes(marker)) {
        return 0.4;
      }
    }
    return 0;
  }

  private temporalFraming(matches: TemporalMatch[]): string {
    const types = matches.map((m) => m.temporalType);
    if (types.includes('recent')) {
      return 'From recent memory';
    }
    if (types.includes('historical')) {
      return 'Looking back';
    }
    if (types.includes('time_of_day')) {
      return 'Around this time';
    }
    if (types.includes('day_of_week')) {
      return 'Similar to today';
    }
    return 'From what I remember';
  }

  private temporalCategories(matches: TemporalMatch[], now: Date): string[] {
    const categories = new Set<string>(['temporal']);
    matches.forEach((m) => categories.add(m.temporalType));
    if (matches.some((m) => this.daysBetween(new Date(m.date), now) <= 7)) {
      categories.add('recent_activity');
    }
    if (matches.some((m) => now.getTime() - new Date(m.date).getTime() > 365 * 24 * 60 * 60 * 1000)) {
      categories.add('long_term');
    }
    return Array.from(categories);
  }

  private parseDate(dateString: string): Date | null {
    if (!dateString) {
      return null;
    }
    const date = new Date(dateString);
    return isNaN(date.getTime()) ? null : date;
  }

  private daysBetween(a: Date, b: Date): number {
    return (b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24);
  }

  // --------------------------------------------------------------------------
  // Guild layer (community knowledge)
  // --------------------------------------------------------------------------
  private async guildLayer(guildId: string, _maxTokens: number): Promise<MemoryEntourageResult> {
    try {
      const guildMemories = await hybridDataLayer.getGuildMemories(guildId, 5);
      if (guildMemories.length === 0) {
        return empty(['guild']);
      }
      const formatted = guildMemories.map((m) => {
        const bracketEnd = m.content.indexOf('] ');
        const content = bracketEnd > 0 ? m.content.substring(bracketEnd + 2) : m.content;
        return content.substring(0, 300) + (content.length > 300 ? '...' : '');
      });
      return {
        content: `🏠 Community knowledge:\n${formatted.map((m) => `• ${m}`).join('\n')}`,
        confidence: 0.8,
        memoryCount: guildMemories.length,
        categories: ['guild', 'community'],
        memoryIds: guildMemories.map((m) => String(m.id)),
      };
    } catch (error) {
      logger.warn('Failed to get guild memories:', error);
      return empty(['guild', 'error']);
    }
  }

  // --------------------------------------------------------------------------
  // Fusion (concat layers, weighted confidence, merge categories/ids)
  // --------------------------------------------------------------------------
  private fuse(
    semantic: MemoryEntourageResult,
    temporal: MemoryEntourageResult,
    guild?: MemoryEntourageResult
  ): MemoryEntourageResult {
    const totalCount = semantic.memoryCount + temporal.memoryCount + (guild?.memoryCount || 0);
    if (totalCount === 0) {
      return empty(['no_matches']);
    }

    const active: Array<{ name: string; result: MemoryEntourageResult }> = [];
    if (semantic.memoryCount > 0) {
      active.push({ name: 'semantic', result: semantic });
    }
    if (temporal.memoryCount > 0) {
      active.push({ name: 'temporal', result: temporal });
    }
    if (guild && guild.memoryCount > 0) {
      active.push({ name: 'guild', result: guild });
    }

    if (active.length === 1) {
      return {
        ...active[0].result,
        categories: [...active[0].result.categories, `${active[0].name}_only`],
      };
    }

    const content = active
      .map((a) => a.result.content)
      .filter((c) => c)
      .join('\n\n');

    // Weighted confidence: semantic 0.4, temporal 0.3, guild 0.3 (normalized over active).
    const weights: Record<string, number> = { semantic: 0.4, temporal: 0.3, guild: 0.3 };
    let weightedConfidence = 0;
    let totalWeight = 0;
    for (const { name, result } of active) {
      weightedConfidence += result.confidence * weights[name];
      totalWeight += weights[name];
    }

    const categories = new Set<string>(['multi_layer_fusion']);
    const memoryIds: string[] = [];
    for (const { result } of active) {
      result.categories.forEach((c) => categories.add(c));
      memoryIds.push(...result.memoryIds);
    }

    return {
      content,
      confidence: totalWeight > 0 ? weightedConfidence / totalWeight : 0,
      memoryCount: totalCount,
      categories: Array.from(categories),
      memoryIds,
    };
  }
}

export const memoryRecaller = new MemoryRecaller();
