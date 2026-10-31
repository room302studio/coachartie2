import { Router } from 'express';
import { logger } from '../../shared/logger.js';
import { type ApiResult, sendResult } from '../../shared/api-result.js';

// Wave 9: the handler body is an exported function returning the status + JSON it used to
// send; the route sends it and engine/api.ts calls it in-process for the gateway.
const reply = (status: number, body: any): ApiResult => ({ status, body });

/**
 * POST /api/reflection/check-threshold and GET /api/reflection/stats.
 * Moved verbatim out of engine/main.ts (wave 6); paths and response shapes are unchanged.
 * Mounted at /api by http.ts.
 */
export const reflectionRouter: Router = Router();

// Reflection threshold check endpoint - triggers emergency reflection if threshold crossed
reflectionRouter.post('/reflection/check-threshold', async (req, res) =>
  sendResult(res, await checkReflectionThreshold(req.body))
);

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

/** POST /api/reflection/check-threshold's body: emergency reflection past N negative reactions. */
export async function checkReflectionThreshold(body: any): Promise<ApiResult> {
  try {
    // Same switch as the daily/weekly runs (scheduler.ts). on-reaction checks it before
    // calling in-process, but the HTTP route didn't, so it could still write rules (2026-10-31).
    if (process.env.ENABLE_REFLECTION_CONSOLIDATION !== 'true') {
      return reply(200, { triggered: false, disabled: true });
    }

    const { guildId, threshold, hours } = body;

    if (!guildId || !threshold) {
      return reply(400, { error: 'guildId and threshold are required' });
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

      return reply(200, {
        triggered: true,
        count,
        threshold,
        rulesCreated: result.rulesCreated,
      });
    } else {
      return reply(200, {
        triggered: false,
        count,
        threshold,
      });
    }
  } catch (error) {
    logger.error('Reflection threshold check error:', error);
    return reply(500, { error: 'Failed to check reflection threshold' });
  }
}
