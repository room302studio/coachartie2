import { Router } from 'express';
import { logger } from '../../shared/logger.js';

/**
 * Observational learning: POST /api/observe and GET /api/observe/stats.
 * Moved verbatim out of engine/main.ts (wave 6); paths and response shapes are unchanged.
 * Mounted at /api by http.ts.
 */
export const observeRouter: Router = Router();

// Observational learning endpoint
observeRouter.post('/observe', async (req, res) => {
  try {
    const { prompt, guildId, channelId, messageCount, timeRange } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
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

    res.json(result);
  } catch (error) {
    logger.error('Observation endpoint error:', error);
    res.status(500).json({ error: 'Failed to process observation' });
  }
});

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
