import { MemoryService } from '../src/capabilities/memory.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('Memory Capability', () => {
  let memoryService: MemoryService;
  const testUserId = 'test-user-memory';

  beforeEach(() => {
    memoryService = MemoryService.getInstance();
  });

  describe('Tag Extraction', () => {
    it('should extract food-related tags from pizza preference', async () => {
      const result = await memoryService.remember(
        testUserId,
        'User likes pizza with pineapple',
        '',
        5
      );

      expect(result).toContain('food');
      expect(result).toContain('preferences');
      expect(result).toContain('pizza');
    });

    it('should extract preference-related tags from preference statements', async () => {
      const result = await memoryService.remember(testUserId, 'I prefer tea over coffee', '', 5);

      expect(result).toContain('preferences');
      expect(result).toContain('food');
    });
  });

  describe('Memory Recall', () => {
    beforeEach(async () => {
      // Store a test memory with food preferences
      await memoryService.remember(testUserId, 'User likes pizza with pineapple', '', 8);
    });

    it('should find food memory when searching for "food preferences"', async () => {
      const result = await memoryService.recall(testUserId, 'food preferences', 5);

      expect(result).toContain('User likes pizza with pineapple');
      expect(result).toContain('full-text search');
    });

    it('should find food memory when searching for "dietary preferences"', async () => {
      const result = await memoryService.recall(testUserId, 'dietary preferences', 5);

      expect(result).toContain('User likes pizza with pineapple');
    });

    it('should find food memory when searching for "what I like to eat"', async () => {
      const result = await memoryService.recall(testUserId, 'what I like to eat', 5);

      expect(result).toContain('User likes pizza with pineapple');
    });

    it('should handle multi-word queries correctly', async () => {
      const result = await memoryService.recall(testUserId, 'pineapple on pizza', 5);

      expect(result).toContain('User likes pizza with pineapple');
    });

    it('should return helpful message when no memories found', async () => {
      const result = await memoryService.recall(testUserId, 'completely unrelated query xyz', 5);

      expect(result).toContain('No memories found');
      expect(result).toContain('Try a different search term');
    });
  });

  describe('FTS Query Processing', () => {
    it('should split multi-word queries into OR terms', async () => {
      // This tests the improved FTS query logic internally
      const result = await memoryService.recall(testUserId, 'food eating preferences', 5);

      // Should use OR logic to find matches for any of the terms
      expect(result).not.toContain('No memories found');
    });
  });
});
