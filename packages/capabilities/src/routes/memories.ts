import express from 'express';
import { capabilityOrchestrator } from '../services/capability-orchestrator.js';

const router: express.Router = express.Router();

// GET /api/memories
router.get('/', async (req, res) => {
  try {
    const { userId, limit = 100, search } = req.query;
    
    if (search) {
      // Use memory capability directly via registry
      const { capabilityRegistry } = await import('../services/capability-registry.js');
      const result = await capabilityRegistry.execute('memory', 'search', {
        query: search as string,
        userId: userId as string,
        limit: parseInt(limit as string)
      });
      
      return res.json({
        success: true,
        data: result || [],
        count: Array.isArray(result) ? result.length : 0
      });
    } else {
      // Get recent memories directly
      const memoryService = new (await import('../capabilities/memory.js')).MemoryService();
      let memories;
      
      if (userId) {
        memories = await memoryService.getRecentMemories(userId as string, parseInt(limit as string));
      } else {
        // Get all recent memories across all users
        const db = await (await import('@coachartie/shared')).getDatabase();
        memories = await db.all(`
          SELECT id, user_id as userId, content, tags, context, timestamp, importance
          FROM memories 
          ORDER BY created_at DESC 
          LIMIT ?
        `, [parseInt(limit as string)]);
      }
      
      return res.json({
        success: true,
        data: memories,
        count: memories.length
      });
    }
  } catch (error) {
    console.error('Error fetching memories:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export { router as memoriesRouter };