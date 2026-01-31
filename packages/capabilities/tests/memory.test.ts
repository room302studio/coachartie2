import { MemoryService } from '../src/capabilities/memory/memory';
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('Memory Capability', () => {
  let memoryService: MemoryService;
  const testUserId = 'test-user-memory';

  beforeEach(() => {
    memoryService = MemoryService.getInstance();
  });

  describe('Remember Operation', () => {
    it('should store memory and return confirmation', async () => {
      const result = await memoryService.remember(
        testUserId,
        'User likes pizza with pineapple',
        '',
        5
      );

      // Should return a confirmation message with the content
      expect(result).toContain('Remembered');
      expect(result).toContain('pizza');
      expect(result).toContain('pineapple');
    });

    it('should include explicit tags when provided', async () => {
      const result = await memoryService.remember(
        testUserId,
        'I prefer tea over coffee',
        '',
        5,
        undefined,
        ['beverage', 'preferences']
      );

      expect(result).toContain('Remembered');
      expect(result).toContain('beverage');
      expect(result).toContain('preferences');
    });

    it('should include importance level', async () => {
      const result = await memoryService.remember(
        testUserId,
        'Important meeting tomorrow',
        '',
        8
      );

      expect(result).toContain('importance: 8/10');
    });
  });

  describe('Recall Operation', () => {
    it('should return helpful message when no memories found', async () => {
      const result = await memoryService.recall('nonexistent-user', 'completely unrelated query xyz', 5);

      expect(result).toContain('No memories found');
      expect(result).toContain('Try a different search term');
    });
  });
});
