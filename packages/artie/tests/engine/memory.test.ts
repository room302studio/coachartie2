import { MemoryService, memoryCapability } from '../../src/engine/tools/core/memory.js';
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
      const result = await memoryService.remember(testUserId, 'Important meeting tomorrow', '', 8);

      expect(result).toContain('importance: 8/10');
    });
  });

  describe('Recall Operation', () => {
    it('should return helpful message when no memories found', async () => {
      const result = await memoryService.recall(
        'nonexistent-user',
        'completely unrelated query xyz',
        5
      );

      expect(result).toContain('No memories found');
      expect(result).toContain('Try a different search term');
    });
  });

  // 2026-10-26: the memory-zoo collapse. `kind` is just another tag (person/guild/pinned/
  // scratch/goal/...), and `forget` is the new delete action backed by hybridDataLayer's new
  // deleteMemory. Both are loud on failure (throw), not a quiet ❌-prefixed success string.
  describe('Forget operation', () => {
    // storeMemory hands back a temp negative id immediately, then (async, on the write
    // queue) swaps it for the real auto-increment id once cold storage persists it — so
    // reading the id back out of getRecentMemories right before use (instead of parsing it
    // out of remember()'s return string) avoids racing that swap.
    async function latestMemoryId(userId: string): Promise<number> {
      const [latest] = await memoryService.getRecentMemories(userId, 1);
      expect(latest, 'expected at least one recent memory').toBeTruthy();
      return latest.id;
    }

    it('forgets a memory the user owns', async () => {
      await memoryService.remember(testUserId, 'temporary fact to forget', '', 5);
      const id = await latestMemoryId(testUserId);

      const result = await memoryService.forgetMemory(testUserId, id);
      expect(result).toContain('Forgot memory');
    });

    it('throws (loud, not a quiet ❌ string) for a nonexistent id', async () => {
      await expect(memoryService.forgetMemory(testUserId, 999999999)).rejects.toThrow(
        'Memory not found'
      );
    });

    it("throws for someone else's memory instead of silently no-opping", async () => {
      await memoryService.remember(testUserId, 'owned by test user', '', 5);
      const id = await latestMemoryId(testUserId);

      await expect(memoryService.forgetMemory('a-different-user', id)).rejects.toThrow(
        'Unauthorized'
      );
    });
  });

  // `kind` is the memory-zoo collapse's classification axis (person/guild/pinned/scratch/
  // goal/...) — the handler folds it into the tags array instead of needing a separate tool
  // per kind.
  describe('kind tagging (handler level)', () => {
    it('folds params.kind into the stored tags', async () => {
      const result = await memoryCapability.handler(
        { action: 'remember', scope: 'me', userId: testUserId, content: 'EJ prefers dark mode', kind: 'person' },
        undefined,
        { userId: testUserId }
      );
      expect(result).toContain('person');
    });

    it('still accepts explicit tags without kind', async () => {
      const result = await memoryCapability.handler(
        { action: 'remember', scope: 'me', userId: testUserId, content: 'no kind here', tags: ['misc'] },
        undefined,
        { userId: testUserId }
      );
      expect(result).toContain('misc');
    });

    // EJ 2026-11-17: "personal facts follow you", the rest stays in its server.
    it('scope "me" stores guild-free; "here" stores the conversation guild; missing scope is refused', async () => {
      // remember(userId, content, context, importance, messageId, tags, guildId, channelId)
      const remember = vi.spyOn(MemoryService.getInstance(), 'remember').mockResolvedValue('ok');
      const guildOf = (text: string) => remember.mock.calls.find((c) => c[1] === text)?.[6];

      await memoryCapability.handler(
        { action: 'remember', scope: 'me', content: 'scope-test: likes rye' },
        undefined,
        { userId: testUserId, guildId: 'g-room302' }
      );
      expect(guildOf('scope-test: likes rye')).toBeUndefined();
      const tagsOf = (text: string) => remember.mock.calls.find((c) => c[1] === text)?.[5];
      expect(tagsOf('scope-test: likes rye')).toContain('personal');

      await memoryCapability.handler(
        { action: 'remember', scope: 'here', content: 'scope-test: server ships fridays', guildId: 'g-forged' },
        undefined,
        { userId: testUserId, guildId: 'g-room302' }
      );
      expect(guildOf('scope-test: server ships fridays')).toBe('g-room302'); // never the forged id
      expect(tagsOf('scope-test: server ships fridays') ?? []).not.toContain('personal');

      // Internal (context-less) "here" writes need a guild too.
      await expect(
        memoryCapability.handler({ action: 'remember', scope: 'here', content: 'scope-test: no guild' })
      ).rejects.toThrow(/needs a guildId/);

      await expect(
        memoryCapability.handler(
          { action: 'remember', content: 'scope-test: no scope' },
          undefined,
          { userId: testUserId, guildId: 'g-room302' }
        )
      ).rejects.toThrow(/scope/);

      // A DM has no "here": guild-free would make it follow them into every server.
      await expect(
        memoryCapability.handler(
          { action: 'remember', scope: 'here', content: 'scope-test: dm here' },
          undefined,
          { userId: testUserId }
        )
      ).rejects.toThrow(/needs a server/);
      remember.mockRestore();
    });
  });

  describe('Pin operation', () => {
    it('throws (loud) for a nonexistent id instead of returning a ❌ string', async () => {
      await expect(memoryService.pinMemory(testUserId, 999999999)).rejects.toThrow('not found');
    });
  });
});
