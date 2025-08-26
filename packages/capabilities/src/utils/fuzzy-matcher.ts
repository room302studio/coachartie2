/**
 * ⚡ BLAZING-FAST FUZZY MATCHER ⚡
 * 
 * Unified fuzzy matching system for capability names and actions with:
 * - Levenshtein distance algorithm for accurate similarity scoring
 * - Alias mapping for common alternative names
 * - Helpful error message generation with top 3 suggestions
 * - Support for both capability names and action names
 * - Performance optimized for real-time user feedback
 * 
 * This is where the magic happens! *swoosh*
 */

export interface FuzzyMatch {
  name: string;
  score: number;
  matchType: 'exact' | 'alias' | 'substring' | 'fuzzy' | 'prefix';
  reason: string;
}

export interface FuzzyMatchOptions {
  maxSuggestions?: number;
  minScore?: number;
  includeAliases?: boolean;
  caseSensitive?: boolean;
}

/**
 * Common aliases for capability actions - these are SUPER common user mistakes! 
 * *[tapping anime keycap]* Based on real user patterns!
 */
export const ACTION_ALIASES = new Map([
  // File operations
  ['write', 'write_file'],
  ['read', 'read_file'], 
  ['create', 'create_directory'],
  ['mkdir', 'create_directory'],
  ['list', 'list_directory'],
  ['ls', 'list_directory'],
  ['check', 'exists'],
  ['remove', 'delete'],
  ['rm', 'delete'],
  
  // Memory operations  
  ['store', 'remember'],
  ['save', 'remember'],
  ['search', 'recall'],
  ['find', 'recall'],
  ['get', 'recall'],
  ['retrieve', 'recall'],
  
  // Calculator operations
  ['calc', 'calculate'],
  ['compute', 'calculate'],
  ['eval', 'calculate'],
  ['math', 'calculate'],
  
  // Scheduler operations
  ['remind', 'remind'], // Keep as-is but normalize
  ['schedule', 'schedule'],
  ['timer', 'remind'],
  ['alarm', 'remind'],
  
  // Common typos - these happen ALL THE TIME! *whoosh*
  ['calcuate', 'calculate'],  // Missing 'l'
  ['calulate', 'calculate'],  // Missing 'c'
  ['remmeber', 'remember'],   // Swapped 'm'
  ['remeber', 'remember'],    // Missing 'm'
  ['recal', 'recall'],        // Shortened
  ['seach', 'search'],        // Missing 'r'
  ['serach', 'search'],       // Swapped 'ar'
]);

/**
 * Common aliases for capability names - users LOVE shortcuts!
 */
export const CAPABILITY_ALIASES = new Map([
  ['calc', 'calculator'],
  ['math', 'calculator'],
  ['mem', 'memory'],
  ['brain', 'memory'],
  ['file', 'filesystem'],
  ['fs', 'filesystem'],
  ['files', 'filesystem'],
  ['web-search', 'web'],
  ['search', 'web'],
  ['google', 'web'],
  ['schedule', 'scheduler'],
  ['remind', 'scheduler'],
  ['timer', 'scheduler'],
  ['env', 'environment'],
  ['vars', 'environment'],
  ['npm', 'package_manager'],
  ['pkg', 'package_manager'],
  ['mcp', 'mcp_client'],
  ['discord', 'discord-ui'],
  ['ui', 'discord-ui'],
]);

export class FuzzyMatcher {
  /**
   * Calculate Levenshtein distance between two strings
   * This is the CORE algorithm - *swoosh* - super optimized for speed!
   */
  static levenshteinDistance(a: string, b: string): number {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix: number[][] = [];

    // Initialize first column
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }

    // Initialize first row  
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    // Fill the matrix - this is where the MAGIC happens! ⚡
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1]; // No cost for exact match
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1,     // insertion
            matrix[i - 1][j] + 1      // deletion
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }

  /**
   * Calculate similarity score (0-1) based on Levenshtein distance
   * Higher score = more similar - *zoom*
   */
  static calculateSimilarity(a: string, b: string): number {
    if (a === b) return 1.0;
    if (a.length === 0 || b.length === 0) return 0.0;

    const distance = this.levenshteinDistance(a.toLowerCase(), b.toLowerCase());
    const maxLength = Math.max(a.length, b.length);
    
    return 1 - (distance / maxLength);
  }

  /**
   * Find fuzzy matches for a target string against a list of candidates
   * This returns the TOP suggestions with reasons - super helpful! *pew pew*
   */
  static findMatches(
    target: string, 
    candidates: string[], 
    options: FuzzyMatchOptions = {}
  ): FuzzyMatch[] {
    const {
      maxSuggestions = 3,
      minScore = 0.3,
      includeAliases = true,
      caseSensitive = false
    } = options;

    const matches: FuzzyMatch[] = [];
    const targetNormalized = caseSensitive ? target : target.toLowerCase();

    for (const candidate of candidates) {
      const candidateNormalized = caseSensitive ? candidate : candidate.toLowerCase();
      
      // 1. Check for exact match (score: 1.0)
      if (targetNormalized === candidateNormalized) {
        matches.push({
          name: candidate,
          score: 1.0,
          matchType: 'exact',
          reason: 'Exact match'
        });
        continue;
      }

      // 2. Check for alias match (score: 0.95) - slightly lower than exact
      if (includeAliases) {
        const actionAlias = ACTION_ALIASES.get(targetNormalized);
        const capabilityAlias = CAPABILITY_ALIASES.get(targetNormalized);
        
        if ((actionAlias === candidateNormalized) || (capabilityAlias === candidateNormalized)) {
          matches.push({
            name: candidate,
            score: 0.95,
            matchType: 'alias',
            reason: `Alias for "${target}"`
          });
          continue;
        }
      }

      // 3. Check for substring match (score: 0.8)
      if (targetNormalized.includes(candidateNormalized) || candidateNormalized.includes(targetNormalized)) {
        matches.push({
          name: candidate,
          score: 0.8,
          matchType: 'substring',
          reason: 'Contains matching substring'
        });
        continue;
      }

      // 4. Check for prefix match (score based on prefix length)
      if (candidateNormalized.startsWith(targetNormalized) || targetNormalized.startsWith(candidateNormalized)) {
        const prefixLength = Math.min(targetNormalized.length, candidateNormalized.length);
        const score = 0.7 + (prefixLength / Math.max(targetNormalized.length, candidateNormalized.length)) * 0.2;
        
        matches.push({
          name: candidate,
          score: score,
          matchType: 'prefix',
          reason: `Prefix match (${prefixLength} chars)`
        });
        continue;
      }

      // 5. Calculate fuzzy similarity score using Levenshtein distance
      const fuzzyScore = this.calculateSimilarity(targetNormalized, candidateNormalized);
      
      if (fuzzyScore >= minScore) {
        matches.push({
          name: candidate,
          score: fuzzyScore,
          matchType: 'fuzzy',
          reason: `Fuzzy match (${Math.round(fuzzyScore * 100)}% similar)`
        });
      }
    }

    // Sort by score (highest first) and limit results - *swoosh*
    return matches
      .sort((a, b) => b.score - a.score)
      .slice(0, maxSuggestions);
  }

  /**
   * Find similar action names with helpful error context
   * Perfect for capability action validation! ⚡
   */
  static findSimilarActions(
    target: string, 
    supportedActions: string[], 
    options: FuzzyMatchOptions = {}
  ): FuzzyMatch[] {
    return this.findMatches(target, supportedActions, {
      maxSuggestions: 3,
      minScore: 0.4, // Slightly higher threshold for actions
      includeAliases: true,
      ...options
    });
  }

  /**
   * Find similar capability names with helpful error context
   * Perfect for capability name validation! *zoom*
   */
  static findSimilarCapabilities(
    target: string, 
    availableCapabilities: string[], 
    options: FuzzyMatchOptions = {}
  ): FuzzyMatch[] {
    return this.findMatches(target, availableCapabilities, {
      maxSuggestions: 3,
      minScore: 0.3, // Lower threshold for capability names (more forgiving)
      includeAliases: true,
      ...options
    });
  }

  /**
   * Generate super helpful error message with fuzzy suggestions
   * This makes users HAPPY when they make typos! *pew pew*
   */
  static generateHelpfulError(
    type: 'capability' | 'action',
    notFound: string,
    available: string[],
    context?: { capabilityName?: string }
  ): string {
    const matches = type === 'capability' 
      ? this.findSimilarCapabilities(notFound, available)
      : this.findSimilarActions(notFound, available);

    let errorMsg = '';
    
    if (type === 'capability') {
      errorMsg = `❌ Capability '${notFound}' not found.`;
    } else {
      errorMsg = `❌ Capability '${context?.capabilityName || 'unknown'}' does not support action '${notFound}'.`;
    }

    // Add suggestions if we found good matches
    if (matches.length > 0) {
      const suggestions = matches.map(match => `'${match.name}'`).join(' or ');
      errorMsg += ` 💡 Did you mean ${suggestions}?`;
      
      // Add reasoning for the best match
      const bestMatch = matches[0];
      if (bestMatch.matchType === 'alias') {
        errorMsg += ` (${bestMatch.name} is the correct name for ${notFound})`;
      } else if (bestMatch.matchType === 'fuzzy' && bestMatch.score > 0.7) {
        errorMsg += ` (very close match!)`;
      }
    }

    // Always show available options for context
    if (type === 'capability') {
      errorMsg += ` 📋 Available capabilities: ${available.join(', ')}`;
    } else {
      errorMsg += ` 📋 Supported actions: ${available.join(', ')}`;
    }

    return errorMsg;
  }

  /**
   * Quick utility to check if a fuzzy match is "good enough" 
   * Based on score thresholds - *swoosh*
   */
  static isGoodMatch(match: FuzzyMatch): boolean {
    switch (match.matchType) {
      case 'exact':
      case 'alias':
        return true;
      case 'substring':
        return match.score >= 0.8;
      case 'prefix':
        return match.score >= 0.7;
      case 'fuzzy':
        return match.score >= 0.6;
      default:
        return false;
    }
  }

  /**
   * Get the single best suggestion for auto-correction
   * Returns null if no good suggestion found
   */
  static getBestSuggestion(
    target: string, 
    candidates: string[], 
    options: FuzzyMatchOptions = {}
  ): string | null {
    const matches = this.findMatches(target, candidates, {
      maxSuggestions: 1,
      ...options
    });

    if (matches.length > 0 && this.isGoodMatch(matches[0])) {
      return matches[0].name;
    }

    return null;
  }
}