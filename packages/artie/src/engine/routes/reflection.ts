import { Router } from 'express';
import { logger } from '../../shared/logger.js';

/**
 * POST /api/reflection/check-threshold and GET /api/reflection/stats.
 * Moved verbatim out of engine/main.ts (wave 6); paths and response shapes are unchanged.
 * Mounted at /api by http.ts.
 */
export const reflectionRouter: Router = Router();

// Reflection threshold check endpoint - triggers emergency reflection if threshold crossed
reflectionRouter.post('/reflection/check-threshold', async (req, res) => {
  try {
    const { guildId, threshold, hours } = req.body;

    if (!guildId || !threshold) {
      return res.status(400).json({ error: 'guildId and threshold are required' });
    }

    // Import the consolidator
    const { reflectionConsolidator, countRecentNegativeFeedback } = await import(
      '../memory/reflection-consolidator.js'
    );

    // Check count of recent negative feedback
    const count = await countRecentNegativeFeedback(guildId, hours || 1);

    if (count >= threshold) {
      // Trigger emergency reflection
      const result = await reflectionConsolidator.triggerEmergencyReflection(
        guildId,
        `${count} negative reactions in last ${hours || 1} hour(s)`
      );

      res.json({
        triggered: true,
        count,
        threshold,
        rulesCreated: result.rulesCreated,
      });
    } else {
      res.json({
        triggered: false,
        count,
        threshold,
      });
    }
  } catch (error) {
    logger.error('Reflection threshold check error:', error);
    res.status(500).json({ error: 'Failed to check reflection threshold' });
  }
});

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
