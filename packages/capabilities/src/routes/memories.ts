import express from 'express';
import { getDb, memories } from '@coachartie/shared';
import { desc } from 'drizzle-orm';

const router: express.Router = express.Router();

// GET /api/memories
router.get('/', async (req, res) => {
  try {
    const { userId, limit = 100, search } = req.query;

    if (search) {
      // Use memory capability directly via registry
      const { capabilityRegistry } = await import('../services/capability/capability-registry.js');
      const result = await capabilityRegistry.execute('memory', 'search', {
        query: search as string,
        userId: userId as string,
        limit: parseInt(limit as string),
      });

      return res.json({
        success: true,
        data: result || [],
        count: Array.isArray(result) ? result.length : 0,
      });
    } else {
      // Get recent memories directly
      const memoryService = new (await import('../capabilities/memory/memory.js')).MemoryService();
      let memoriesList;

      if (userId) {
        memoriesList = await memoryService.getRecentMemories(
          userId as string,
          parseInt(limit as string)
        );
      } else {
        // Get all recent memories across all users using Drizzle
        const db = getDb();
        memoriesList = await db
          .select({
            id: memories.id,
            userId: memories.userId,
            content: memories.content,
            tags: memories.tags,
            context: memories.context,
            timestamp: memories.timestamp,
            importance: memories.importance,
            related_message_id: memories.relatedMessageId,
          })
          .from(memories)
          .orderBy(desc(memories.createdAt))
          .limit(parseInt(limit as string));
      }

      return res.json({
        success: true,
        data: memoriesList,
        count: memoriesList.length,
      });
    }
  } catch (error) {
    console.error('Error fetching memories:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export { router as memoriesRouter };
