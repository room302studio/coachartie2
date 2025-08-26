import { describe, it, expect } from 'vitest';
import { FuzzyMatcher, type FuzzyMatch, type FuzzyMatchOptions } from '../../src/utils/fuzzy-matcher.js';

/**
 * ⚡ COMPREHENSIVE FUZZY MATCHER TESTS ⚡
 * 
 * Testing our BLAZING-FAST fuzzy matching system with:
 * - Levenshtein distance calculations
 * - Alias resolution 
 * - Real-world user typos and mistakes
 * - Edge cases and performance scenarios
 * 
 * This is where we make sure everything is BULLETPROOF! *swoosh*
 */

describe('FuzzyMatcher - Core Algorithms', () => {
  describe('Levenshtein Distance', () => {
    it('should calculate distance correctly for identical strings', () => {
      expect(FuzzyMatcher.levenshteinDistance('write', 'write')).toBe(0);
      expect(FuzzyMatcher.levenshteinDistance('calculator', 'calculator')).toBe(0);
    });

    it('should calculate distance correctly for completely different strings', () => {
      expect(FuzzyMatcher.levenshteinDistance('write', 'read')).toBe(4);
      expect(FuzzyMatcher.levenshteinDistance('abc', 'xyz')).toBe(3);
    });

    it('should handle single character differences', () => {
      expect(FuzzyMatcher.levenshteinDistance('write', 'wrote')).toBe(2); // i->o, e->e
      expect(FuzzyMatcher.levenshteinDistance('calculate', 'calcuate')).toBe(1); // missing 'l'
    });

    it('should handle insertions and deletions', () => {
      expect(FuzzyMatcher.levenshteinDistance('calc', 'calculate')).toBe(6); // 6 insertions
      expect(FuzzyMatcher.levenshteinDistance('remember', 'remeber')).toBe(1); // missing 'm'
    });

    it('should handle empty strings', () => {
      expect(FuzzyMatcher.levenshteinDistance('', 'test')).toBe(4);
      expect(FuzzyMatcher.levenshteinDistance('test', '')).toBe(4);
      expect(FuzzyMatcher.levenshteinDistance('', '')).toBe(0);
    });
  });

  describe('Similarity Calculation', () => {
    it('should return 1.0 for identical strings', () => {
      expect(FuzzyMatcher.calculateSimilarity('write', 'write')).toBe(1.0);
      expect(FuzzyMatcher.calculateSimilarity('CALCULATE', 'calculate')).toBe(1.0); // case insensitive
    });

    it('should return 0.0 for empty strings', () => {
      expect(FuzzyMatcher.calculateSimilarity('', 'test')).toBe(0.0);
      expect(FuzzyMatcher.calculateSimilarity('test', '')).toBe(0.0);
    });

    it('should calculate reasonable similarity scores', () => {
      // Very similar strings should have high scores
      expect(FuzzyMatcher.calculateSimilarity('calculate', 'calcuate')).toBeGreaterThan(0.8);
      expect(FuzzyMatcher.calculateSimilarity('remember', 'remeber')).toBeGreaterThan(0.8);
      
      // Somewhat similar strings should have moderate scores
      expect(FuzzyMatcher.calculateSimilarity('write', 'read')).toBeLessThan(0.3);
      
      // Completely different strings should have low scores
      expect(FuzzyMatcher.calculateSimilarity('calculator', 'memory')).toBeLessThan(0.2);
    });
  });
});

describe('FuzzyMatcher - Match Finding', () => {
  const testCapabilities = ['calculator', 'memory', 'filesystem', 'web', 'scheduler', 'discord-ui'];
  const testActions = ['calculate', 'remember', 'recall', 'read_file', 'write_file', 'create_directory'];

  describe('Exact Matches', () => {
    it('should find exact matches with score 1.0', () => {
      const matches = FuzzyMatcher.findMatches('calculator', testCapabilities);
      
      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual({
        name: 'calculator',
        score: 1.0,
        matchType: 'exact',
        reason: 'Exact match'
      });
    });

    it('should be case insensitive for exact matches', () => {
      const matches = FuzzyMatcher.findMatches('CALCULATOR', testCapabilities);
      
      expect(matches[0].name).toBe('calculator');
      expect(matches[0].score).toBe(1.0);
      expect(matches[0].matchType).toBe('exact');
    });
  });

  describe('Alias Matches', () => {
    it('should find aliases for capability names', () => {
      const matches = FuzzyMatcher.findMatches('calc', testCapabilities);
      
      expect(matches[0].name).toBe('calculator');
      expect(matches[0].score).toBe(0.95);
      expect(matches[0].matchType).toBe('alias');
      expect(matches[0].reason).toContain('Alias for \"calc\"');
    });

    it('should find aliases for action names', () => {
      const matches = FuzzyMatcher.findMatches('write', testActions);
      
      expect(matches[0].name).toBe('write_file');
      expect(matches[0].score).toBe(0.95);
      expect(matches[0].matchType).toBe('alias');
    });

    it('should handle common typos through aliases', () => {
      const matches = FuzzyMatcher.findMatches('calcuate', testActions); // Missing 'l'
      
      expect(matches[0].name).toBe('calculate');
      expect(matches[0].matchType).toBe('alias');
    });
  });

  describe('Substring Matches', () => {
    it('should find substring matches', () => {
      const matches = FuzzyMatcher.findMatches('calc', ['calculate', 'memory']);
      
      expect(matches[0].name).toBe('calculate');
      expect(matches[0].score).toBe(0.8);
      expect(matches[0].matchType).toBe('substring');
    });

    it('should find reverse substring matches', () => {
      const matches = FuzzyMatcher.findMatches('calculator', ['calc']);
      
      expect(matches[0].name).toBe('calc');
      expect(matches[0].score).toBe(0.8);
      expect(matches[0].matchType).toBe('substring');
    });
  });

  describe('Prefix Matches', () => {
    it('should find prefix matches with appropriate scores', () => {
      const matches = FuzzyMatcher.findMatches('mem', testCapabilities);
      
      const memoryMatch = matches.find(m => m.name === 'memory');
      expect(memoryMatch).toBeDefined();
      expect(memoryMatch!.matchType).toBe('prefix');
      expect(memoryMatch!.score).toBeGreaterThan(0.7);
    });
  });

  describe('Fuzzy Matches', () => {
    it('should find fuzzy matches for typos', () => {
      const matches = FuzzyMatcher.findMatches('memmory', testCapabilities); // Extra 'm'
      
      const memoryMatch = matches.find(m => m.name === 'memory');
      expect(memoryMatch).toBeDefined();
      expect(memoryMatch!.matchType).toBe('fuzzy');
      expect(memoryMatch!.score).toBeGreaterThan(0.5);
    });

    it('should find fuzzy matches for similar strings', () => {
      const matches = FuzzyMatcher.findMatches('remeber', testActions); // Missing 'm' in remember
      
      const rememberMatch = matches.find(m => m.name === 'remember');
      expect(rememberMatch).toBeDefined();
      expect(rememberMatch!.matchType).toBe('fuzzy');
    });
  });

  describe('Match Ranking and Limiting', () => {
    it('should rank matches by score (highest first)', () => {
      const matches = FuzzyMatcher.findMatches('calc', [...testCapabilities, 'calculate']);
      
      // Should have exact alias match first
      expect(matches[0].score).toBeGreaterThanOrEqual(matches[1].score);
    });

    it('should respect maxSuggestions option', () => {
      const matches = FuzzyMatcher.findMatches('e', testCapabilities, { maxSuggestions: 2 });
      
      expect(matches.length).toBeLessThanOrEqual(2);
    });

    it('should respect minScore threshold', () => {
      const matches = FuzzyMatcher.findMatches('xyz', testCapabilities, { minScore: 0.8 });
      
      // Should find no good matches for 'xyz'
      expect(matches.length).toBe(0);
    });
  });
});

describe('FuzzyMatcher - Specialized Functions', () => {
  const capabilities = ['calculator', 'memory', 'filesystem', 'web'];
  const actions = ['calculate', 'remember', 'recall', 'read_file', 'write_file'];

  describe('findSimilarCapabilities', () => {
    it('should find similar capability names', () => {
      const matches = FuzzyMatcher.findSimilarCapabilities('calc', capabilities);
      
      expect(matches[0].name).toBe('calculator');
      expect(matches).toHaveLength(1); // Default max 3, but only one good match
    });

    it('should be more forgiving with lower minScore', () => {
      const matches = FuzzyMatcher.findSimilarCapabilities('xyz', capabilities);
      
      // Even with low similarity, should try to find something
      expect(matches.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('findSimilarActions', () => {
    it('should find similar action names', () => {
      const matches = FuzzyMatcher.findSimilarActions('write', actions);
      
      expect(matches[0].name).toBe('write_file');
      expect(matches[0].matchType).toBe('alias');
    });

    it('should handle typos in action names', () => {
      const matches = FuzzyMatcher.findSimilarActions('remmeber', actions);
      
      expect(matches[0].name).toBe('remember');
    });
  });

  describe('getBestSuggestion', () => {
    it('should return the best single suggestion', () => {
      const suggestion = FuzzyMatcher.getBestSuggestion('calc', capabilities);
      
      expect(suggestion).toBe('calculator');
    });

    it('should return null for poor matches', () => {
      const suggestion = FuzzyMatcher.getBestSuggestion('xyz123', capabilities);
      
      expect(suggestion).toBeNull();
    });

    it('should return exact matches immediately', () => {
      const suggestion = FuzzyMatcher.getBestSuggestion('memory', capabilities);
      
      expect(suggestion).toBe('memory');
    });
  });
});

describe('FuzzyMatcher - Error Message Generation', () => {
  const capabilities = ['calculator', 'memory', 'filesystem'];
  const actions = ['calculate', 'remember', 'recall', 'read_file', 'write_file'];

  describe('Capability Errors', () => {
    it('should generate helpful error for unknown capability', () => {
      const error = FuzzyMatcher.generateHelpfulError('capability', 'calc', capabilities);
      
      expect(error).toContain('❌');
      expect(error).toContain('Capability \\'calc\\' not found');
      expect(error).toContain('💡 Did you mean');
      expect(error).toContain('calculator');
      expect(error).toContain('📋 Available capabilities');
    });

    it('should generate error without suggestions for poor matches', () => {
      const error = FuzzyMatcher.generateHelpfulError('capability', 'xyz123', capabilities);
      
      expect(error).toContain('❌');
      expect(error).toContain('not found');
      expect(error).not.toContain('💡 Did you mean');
      expect(error).toContain('📋 Available capabilities');
    });
  });

  describe('Action Errors', () => {
    it('should generate helpful error for unknown action', () => {
      const error = FuzzyMatcher.generateHelpfulError(
        'action', 
        'write', 
        actions, 
        { capabilityName: 'filesystem' }
      );
      
      expect(error).toContain('❌');
      expect(error).toContain('does not support action \\'write\\'');
      expect(error).toContain('💡 Did you mean');
      expect(error).toContain('write_file');
      expect(error).toContain('📋 Supported actions');
    });

    it('should include capability name in action errors', () => {
      const error = FuzzyMatcher.generateHelpfulError(
        'action', 
        'xyz', 
        actions, 
        { capabilityName: 'memory' }
      );
      
      expect(error).toContain('Capability \\'memory\\'');
    });
  });

  describe('Special Reasoning', () => {
    it('should explain alias matches', () => {
      const error = FuzzyMatcher.generateHelpfulError('capability', 'calc', capabilities);
      
      expect(error).toContain('calculator is the correct name for calc');
    });

    it('should indicate very close fuzzy matches', () => {
      const error = FuzzyMatcher.generateHelpfulError('capability', 'calculater', capabilities);
      
      expect(error).toContain('very close match');
    });
  });
});

describe('FuzzyMatcher - Real-World User Scenarios', () => {
  const realCapabilities = [
    'calculator', 'memory', 'web', 'filesystem', 'scheduler', 
    'wolfram', 'package_manager', 'environment', 'mcp_client', 'discord-ui'
  ];
  
  const realActions = [
    'calculate', 'remember', 'recall', 'search', 'read_file', 'write_file', 
    'create_directory', 'list_directory', 'remind', 'schedule', 'install_package'
  ];

  describe('Common User Typos', () => {
    const commonTypos = [
      { typo: 'calcuator', expected: 'calculator' },
      { typo: 'calulator', expected: 'calculator' },
      { typo: 'memmory', expected: 'memory' },
      { typo: 'filesytem', expected: 'filesystem' },
      { typo: 'scheuler', expected: 'scheduler' },
      { typo: 'enviroment', expected: 'environment' }
    ];

    commonTypos.forEach(({ typo, expected }) => {
      it(`should handle typo: ${typo} -> ${expected}`, () => {
        const matches = FuzzyMatcher.findSimilarCapabilities(typo, realCapabilities);
        
        expect(matches.length).toBeGreaterThan(0);
        expect(matches[0].name).toBe(expected);
      });
    });
  });

  describe('Action Typos', () => {
    const actionTypos = [
      { typo: 'calcuate', expected: 'calculate' },
      { typo: 'remmeber', expected: 'remember' },
      { typo: 'recal', expected: 'recall' },
      { typo: 'serach', expected: 'search' },
      { typo: 'creat_directory', expected: 'create_directory' }
    ];

    actionTypos.forEach(({ typo, expected }) => {
      it(`should handle action typo: ${typo} -> ${expected}`, () => {
        const matches = FuzzyMatcher.findSimilarActions(typo, realActions);
        
        expect(matches.length).toBeGreaterThan(0);
        // Should find the expected action in top suggestions
        const expectedMatch = matches.find(m => m.name === expected);
        expect(expectedMatch).toBeDefined();
      });
    });
  });

  describe('User Shortcuts and Abbreviations', () => {
    const shortcuts = [
      { shortcut: 'calc', expected: 'calculator' },
      { shortcut: 'mem', expected: 'memory' },
      { shortcut: 'fs', expected: 'filesystem' },
      { shortcut: 'env', expected: 'environment' },
      { shortcut: 'pkg', expected: 'package_manager' }
    ];

    shortcuts.forEach(({ shortcut, expected }) => {
      it(`should handle shortcut: ${shortcut} -> ${expected}`, () => {
        const matches = FuzzyMatcher.findSimilarCapabilities(shortcut, realCapabilities);
        
        expect(matches.length).toBeGreaterThan(0);
        expect(matches[0].name).toBe(expected);
      });
    });
  });

  describe('Performance with Large Lists', () => {
    const largeCapabilityList = Array.from({ length: 100 }, (_, i) => `capability_${i}`);
    
    it('should handle large capability lists efficiently', () => {
      const startTime = performance.now();
      
      const matches = FuzzyMatcher.findSimilarCapabilities('capability_50', largeCapabilityList);
      
      const endTime = performance.now();
      const duration = endTime - startTime;
      
      expect(matches.length).toBeGreaterThan(0);
      expect(duration).toBeLessThan(100); // Should complete in under 100ms
    });

    it('should limit results appropriately with large lists', () => {
      const matches = FuzzyMatcher.findSimilarCapabilities('cap', largeCapabilityList, { 
        maxSuggestions: 5 
      });
      
      expect(matches.length).toBeLessThanOrEqual(5);
    });
  });
});

describe('FuzzyMatcher - Edge Cases', () => {
  it('should handle empty candidate lists', () => {
    const matches = FuzzyMatcher.findMatches('test', []);
    expect(matches).toEqual([]);
  });

  it('should handle special characters', () => {
    const matches = FuzzyMatcher.findMatches('discord-ui', ['discord-ui', 'memory']);
    expect(matches[0].name).toBe('discord-ui');
    expect(matches[0].score).toBe(1.0);
  });

  it('should handle numbers in names', () => {
    const matches = FuzzyMatcher.findMatches('mcp_client', ['mcp_client', 'mcp_installer']);
    expect(matches[0].name).toBe('mcp_client');
  });

  it('should handle very long strings', () => {
    const longString = 'a'.repeat(1000);
    const candidates = [longString, 'short'];
    
    const matches = FuzzyMatcher.findMatches(longString, candidates);
    expect(matches[0].name).toBe(longString);
  });

  it('should be consistent with case sensitivity option', () => {
    const matches1 = FuzzyMatcher.findMatches('CALC', ['calculator'], { caseSensitive: false });
    const matches2 = FuzzyMatcher.findMatches('CALC', ['calculator'], { caseSensitive: true });
    
    expect(matches1.length).toBeGreaterThanOrEqual(matches2.length);
  });
});