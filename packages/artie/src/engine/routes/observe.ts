import { Router } from 'express';
import { logger } from '../../shared/logger.js';
import { type ApiResult, sendResult } from '../../shared/api-result.js';

// Wave 9: the handler body is an exported function returning the status + JSON it used to
// send; the route sends it and engine/api.ts calls it in-process for the gateway.
const reply = (status: number, body: any): ApiResult => ({ status, body });

/**
 * Observational learning: POST /api/observe and GET /api/observe/stats.
 * Moved verbatim out of engine/main.ts (wave 6); paths and response shapes are unchanged.
 * Mounted at /api by http.ts.
 */
export const observeRouter: Router = Router();

// Observational learning endpoint
observeRouter.post('/observe', async (req, res) => sendResult(res, await observe(req.body)));

// Observation stats endpoint
observeRouter.get('/observe/stats', async (req, res) => {
  try {
    const { observationHandler } = await import('../memory/observe.js');
    const stats = await observationHandler.getObservationStats();
    res.json(stats);
  } catch (error) {
    logger.error('Observation stats error:', error);
    res.status(500).json({ error: 'Failed to get observation stats' });
  }
});

/** POST /api/observe's body: an observation summary from FAST_MODEL ({summary, cost}). */
export async function observe(body: any): Promise<ApiResult> {
  try {
    const { prompt, guildId, channelId, messageCount, timeRange } = body;

    if (!prompt) {
      return reply(400, { error: 'Prompt is required' });
    }

    // Import observation handler
    const { observationHandler } = await import('../memory/observe.js');

    // Generate summary
    const result = await observationHandler.generateObservationSummary(prompt, {
      guildId,
      channelId,
      messageCount,
      timeRange,
    });

    return reply(200, result);
  } catch (error) {
    logger.error('Observation endpoint error:', error);
    return reply(500, { error: 'Failed to process observation' });
  }
}
