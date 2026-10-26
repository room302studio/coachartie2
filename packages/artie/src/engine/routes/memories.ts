import express from 'express';
import { getDb, desc } from '../../shared/db/client.js';
import { memories } from '../../shared/db/schema.js';
import { logger } from '../../shared/logger.js';
import { getErrorMessage } from '../../shared/errors.js';

const router: express.Router = express.Router();

// GET /api/memories
router.get('/', async (req, res) => {
  try {
    const { userId, limit = 100, search } = req.query;

    if (search) {
      // Use memory capability directly via registry
      const { capabilityRegistry } = await import('../5-tool-loop/registry.js');
      const result = await capabilityRegistry.execute('memory', 'search', {
        query: search as string,
        userId: userId as string,
        limit: parseInt(limit as string),
      });

      let resultCount: number;
      if (Array.isArray(result)) {
        resultCount = result.length;
      } else {
        resultCount = 0;
      }
      return res.json({
        success: true,
        data: result || [],
        count: resultCount,
      });
    } else {
      // Get recent memories directly
      const memoryService = new (await import('../tools/core/memory.js')).MemoryService();
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
    logger.error('Error fetching memories:', error);
    res.status(500).json({
      success: false,
      error: getErrorMessage(error),
    });
  }
});

export { router as memoriesRouter };
