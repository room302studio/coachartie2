import { logger } from '../../shared/logger.js';
import { stripInternalMarkup, stripToolCalls } from '../../shared/clean-llm-output.js';
import { MemoryEntourageInterface, MemoryEntourageResult } from './types.js';
import { MemoryService } from '../tools/core/memory.js';
import { hybridDataLayer } from './store.js';
import { isOwner } from '../../shared/config/owner.js';

/**
 * True when `content` names the owner (by Discord id, "ejfox" or the standalone word "EJ").
 * Word-boundary matched the same way privacy-opt-out.ts's mentionsOptedOutUser is, so "EJ"
 * doesn't match inside "reject" etc. Exported for the memory-poisoning test.
 */
export function mentionsOwner(content: string | undefined | null): boolean {
  if (!content) return false;
  return /(^|[^a-z0-9_])(688448399879438340|ejfox|ej)($|[^a-z0-9_])/i.test(content.toLowerCase());
}

/** importance cap applied to the candidate pool for non-owner guild memories that name the
 * owner — keeps them below the >=7 threshold that both lowers the relevance bar (0.08→0.02)
 * and buys a spot in the always-included "high importance" set. */
const UNVERIFIED_OWNER_MENTION_IMPORTANCE_CAP = 6;

/**
 * Security audit 2026-10-26 (sec-abuse.md Critical #2 — memory poisoning): a non-owner's
 * guild memory that names the owner used to join the SAME ranked candidate pool every other
 * user's recall draws from, with no signal that it was never verified and no cap on how
 * "important" (and therefore how likely to surface) it could claim to be. This can't change
 * who it was stored under (execute.ts already force-binds that to the real caller), only how
 * it's framed and weighted once it's a recall candidate — so the ORIGINAL row in storage is
 * untouched; only what gets handed to the model is tagged and capped, and only when someone
 * other than the author is doing the asking.
 */
export function guardGuildMentionOfOwner<
  T extends { user_id: string; content: string; importance?: number },
>(
  memory: T,
  askingUserId: string
): T {
  if (memory.user_id === askingUserId || isOwner(memory.user_id)) {
    return memory; // the author recalling their own words, or the owner's own memory
  }
  if (!mentionsOwner(memory.content)) {
    return memory;
  }
  return {
    ...memory,
    content: `[unverified, said by ${memory.user_id}] ${memory.content}`,
    importance: Math.min(memory.importance ?? 5, UNVERIFIED_OWNER_MENTION_IMPORTANCE_CAP),
  };
}

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
type SemanticMatch = Candidate & {
  semanticScore: number;
  // "Why did this match" fields (Artie's own request, 2026-10-26: "Memory recall still
  // occasionally pulls junk... a 'why did this match' flag would help more"). Computed
  // alongside the score, never used to re-rank — see semanticReason().
  rawSimilarity: number;
  mentionsParticipant: boolean;
  matchedParticipant?: string;
  topTerm?: string;
};
type TemporalMatch = Candidate & { temporalScore: number; temporalType: string };

interface RecallOptions {
  maxTokens?: number;
  priority?: 'speed' | 'accuracy' | 'comprehensive';
  minimal?: boolean;
  guildId?: string;
  participants?: string[]; // lowercased name tokens of people present in the conversation
}

const empty = (categories: string[], confidence = 0): MemoryEntourageResult => ({
  content: '',
  confidence,
  memoryCount: 0,
  categories,
  memoryIds: [],
});

/** Words in a query that make recall weigh time (was six word-list regexes, one per row). */
export const TEMPORAL_KEYWORDS: readonly string[] = [
  ...['today', 'yesterday', 'tomorrow', 'now', 'recently', 'lately', 'earlier', 'later'],
  ...['morning', 'afternoon', 'evening', 'night', 'dawn', 'dusk'],
  ...['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
  ...['weekend', 'weekday', 'week', 'month', 'year'],
  ...['spring', 'summer', 'fall', 'autumn', 'winter', 'holiday', 'birthday'],
  ...['always', 'usually', 'often', 'sometimes', 'rarely', 'never', 'before', 'after', 'during', 'since'],
];
const TEMPORAL_KEYWORD_RE = new RegExp(`\\b(${TEMPORAL_KEYWORDS.join('|')})\\b`, 'gi');

/**
 * The temporal keywords in a message, lowercased, deduped. Order is text order (it was
 * word-group order); matchTemporalContext only sums per keyword, so order doesn't matter.
 */
export function extractTemporalKeywords(message: string): string[] {
  const found = message.match(TEMPORAL_KEYWORD_RE) || [];
  return [...new Set(found.map((m) => m.toLowerCase()))];
}

/**
 * ~200 old memories (Jan–Sep 2026) have raw capability calls baked into the note text.
 * Recalled verbatim, they read as live instructions, so strip them; the surrounding
 * note almost always restates the fact.
 */
export function stripCapabilityTags(text: string): string {
  // 'lazy' = recall's own capability match (to the first "/>" or "</capability>"); the
  // shared stripper keeps it as an explicit option. <recall> loses its tags, not its text.
  return stripInternalMarkup(stripToolCalls(text, { capability: 'lazy' }), ['recall'])
    .replace(/\s{2,}/g, ' ')
    .trim();
}

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
      const budget = this.tokenBudget(options.maxTokens);
      const candidates = await this.fetchCandidates(userId, options.guildId);

      let semantic: MemoryEntourageResult;
      if (candidates.length > 0) {
        semantic = this.semanticLayer(
          userMessage,
          candidates,
          options.priority,
          budget.semantic,
          options.participants
        );
      } else {
        semantic = empty(['no_memories']);
      }

      let temporal: MemoryEntourageResult;
      if (candidates.length > 0) {
        temporal = this.temporalLayer(userMessage, candidates, options.priority, budget.temporal);
      } else {
        temporal = empty(['no_memories']);
      }

      return this.fuse(semantic, temporal);
    } catch (error) {
      logger.error('❌ MemoryRecaller failed:', error);
      return empty(['error']);
    }
  }

  // --------------------------------------------------------------------------
  // Candidate fetch (single pass — superset of what the old two layers pulled)
  // --------------------------------------------------------------------------
  private async fetchCandidates(userId: string, guildId?: string): Promise<Candidate[]> {
    // Scoped to this server when there is one (Artie flagged 2026-10-22 that memories from
    // one server were surfacing in another; the data layer could isolate, nobody asked it to).
    const userMemories = await this.memoryService.getRecentMemories(userId, 60, guildId);

    let artieMemories: any[] = [];
    // Artie's own reflections are mostly unscoped (no guild_id) and name other servers'
    // people and bits, so inside a server only that server's ones are candidates.
    if (userId !== 'artie-social') {
      const allArtie = (await this.memoryService.getRecentMemories('artie-social', 150, guildId)).filter(
        (m: any) => !guildId || m.guildId === guildId
      );
      const highImportance = allArtie.filter((m) => (m.importance || 5) >= 7);
      const recent = allArtie.filter((m) => (m.importance || 5) < 7).slice(0, 20);
      artieMemories = [...highImportance, ...recent];
    }

    // Community/guild memories now join the SAME candidate pool that gets semantically
    // ranked below — that's the whole recall fix. They used to be a separate "5 most
    // recent, no relevance matching" guild layer, so Artie could only ever recall the
    // last 5 things that happened in the server, never the memory that actually matched
    // the question ("who is yellowaquarium?" → couldn't find it). Now they're ranked by
    // TF-IDF relevance like everything else. Pull a recency-bounded window as candidates
    // (same idea as user memories being capped at 60); the top-K selection stays tiny.
    let guildMemories: any[] = [];
    if (guildId) {
      const rawGuildMemories = await hybridDataLayer.getGuildMemories(guildId, 400);
      // Security audit 2026-10-26 (sec-abuse.md Critical #2): only the shared guild pool
      // needs this — userMemories is already scoped to the asker, and artieMemories are
      // Artie's own, not a third party's claim about the owner.
      guildMemories = rawGuildMemories.map((m) => guardGuildMentionOfOwner(m, userId));
    }

    return [...userMemories, ...artieMemories, ...guildMemories].map((m) => {
      let tags: string[] = [];
      if (Array.isArray(m.tags)) {
        tags = m.tags;
      }
      return {
        content: stripCapabilityTags(m.content),
        importance: m.importance || 5,
        date: m.timestamp || new Date().toISOString(),
        tags,
      };
    });
  }

  private tokenBudget(maxTokens?: number): { semantic: number; temporal: number } {
    const total = maxTokens || 800;
    // 60% semantic, 40% temporal (guild memories now flow through both, no separate slice)
    return { semantic: Math.floor(total * 0.6), temporal: Math.floor(total * 0.4) };
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
    maxTokens: number,
    participants?: string[]
  ): MemoryEntourageResult {
    const queryVector = this.tfidfVector(userMessage);
    const people = (participants || []).filter((p) => p.length >= 4);
    const matches: SemanticMatch[] = [];

    for (const memory of candidates) {
      const memoryVector = this.tfidfVector(memory.content);
      const similarity = this.cosineSimilarity(queryVector, memoryVector);
      // A memory that names one of the people present is relevant to a conversation
      // ABOUT those people (rankings, roasts, "what's X been up to") even when the raw
      // query text barely overlaps it. Pull it in regardless of threshold and rank it up,
      // so recall reflects who's actually here instead of whoever's memory is most generic.
      const mentionsParticipant =
        people.length > 0 && people.some((p) => memory.content.toLowerCase().includes(p));
      let threshold = 0.08;
      if (memory.importance >= 7) {
        threshold = 0.02;
      }
      if (similarity > threshold || mentionsParticipant) {
        let participantBoost = 0;
        if (mentionsParticipant) {
          participantBoost = 0.5;
        }

        let matchedParticipant: string | undefined;
        if (mentionsParticipant) {
          matchedParticipant = people.find((p) => memory.content.toLowerCase().includes(p));
        }

        matches.push({
          ...memory,
          semanticScore: similarity + participantBoost,
          rawSimilarity: similarity,
          mentionsParticipant,
          matchedParticipant,
          topTerm: this.topSharedTerm(queryVector, memoryVector),
        });
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

    const content = `This reminds me of: ${top
      .map((m) => `${m.content}${this.semanticReason(m)}`)
      .join(', and also ')}.`;
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
    if (importance >= 7) {
      return 0.3;
    }
    if (importance >= 5) {
      return 0.1;
    }
    return 0;
  }

  /**
   * "Why did this match" — a few tokens appended per memory, after ranking is settled.
   * Never feeds back into semanticScore/sort; it only explains a choice already made.
   */
  private semanticReason(m: SemanticMatch): string {
    let primary: string;
    if (m.mentionsParticipant && m.matchedParticipant) {
      primary = `mentions ${m.matchedParticipant}`;
    } else if (m.topTerm) {
      primary = `kw:${m.topTerm}`;
    } else {
      primary = `sim ${m.rawSimilarity.toFixed(2)}`;
    }

    let importanceSuffix = '';
    if (m.importance >= 7) {
      importanceSuffix = ', imp';
    }

    return ` [${primary}${importanceSuffix}]`;
  }

  /** The single highest-weighted term the query and this memory share — the thing a
   *  human would point at and say "that's why it matched". Undefined when there's no
   *  overlap (a pure participant-mention match, for instance). */
  private topSharedTerm(a: Map<string, number>, b: Map<string, number>): string | undefined {
    let best: string | undefined;
    let bestScore = 0;
    for (const [term, weight] of a) {
      const bWeight = b.get(term);
      if (bWeight) {
        const score = weight * bWeight;
        if (score > bestScore) {
          bestScore = score;
          best = term;
        }
      }
    }
    return best;
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

    const content = `${this.temporalFraming(top)}: ${top
      .map((m) => `${m.content}${this.temporalReason(m)}`)
      .join(', and ')}.`;
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
    let dayOfWeekScore = 0;
    if (currentDate.getDay() === memoryDate.getDay()) {
      dayOfWeekScore = 0.2;
    }

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
    return extractTemporalKeywords(message);
  }

  /** "Why did this match" for the temporal layer: the same temporalType already computed
   *  for scoring/framing, plus age in days — e.g. " [recent, 2d]" or " [day_of_week, 41d]". */
  private temporalReason(m: TemporalMatch): string {
    const days = Math.max(0, Math.round(this.daysBetween(new Date(m.date), new Date())));
    return ` [${m.temporalType}, ${days}d]`;
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
    if (isNaN(date.getTime())) {
      return null;
    }
    return date;
  }

  private daysBetween(a: Date, b: Date): number {
    return (b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24);
  }

  // --------------------------------------------------------------------------
  // Fusion (concat layers, weighted confidence, merge categories/ids)
  // --------------------------------------------------------------------------
  private fuse(
    semantic: MemoryEntourageResult,
    temporal: MemoryEntourageResult
  ): MemoryEntourageResult {
    const totalCount = semantic.memoryCount + temporal.memoryCount;
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

    // Weighted confidence: semantic 0.4, temporal 0.3 (normalized over active).
    const weights: Record<string, number> = { semantic: 0.4, temporal: 0.3 };
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

    let confidence: number;
    if (totalWeight > 0) {
      confidence = weightedConfidence / totalWeight;
    } else {
      confidence = 0;
    }

    return {
      content,
      confidence,
      memoryCount: totalCount,
      categories: Array.from(categories),
      memoryIds,
    };
  }
}

export const memoryRecaller = new MemoryRecaller();
