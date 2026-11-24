import { Router } from 'express';
import { logger } from '../../shared/logger.js';

/**
 * GET /api/reflection/stats.
 * Moved verbatim out of engine/main.ts (wave 6); path and response shape are unchanged.
 * Mounted at /api by http.ts.
 */
export const reflectionRouter: Router = Router();

// Reflection stats endpoint - get active rules and reflection statistics
reflectionRouter.get('/reflection/stats', async (req, res) => {
  try {
    const { reflectionConsolidator } = await import(
      '../memory/reflection-consolidator.js'
    );

    const systemRules = await reflectionConsolidator.getActiveRules('system');

    // Get guild-specific rules count
    const { getSyncDb } = await import('../../shared/db/client.js');
    const db = getSyncDb();

    const guildStats = db.all<{ scope_id: string; count: number }>(
      `SELECT scope_id, COUNT(*) as count
       FROM learned_rules
       WHERE rule_type = 'guild' AND is_active = 1
       GROUP BY scope_id`
    );

    const totalRules = db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM learned_rules WHERE is_active = 1`
    );

    res.json({
      systemRules: systemRules.length,
      guildRules: guildStats || [],
      totalActiveRules: totalRules?.count || 0,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Reflection stats error:', error);
    res.status(500).json({ error: 'Failed to get reflection stats' });
  }
});
