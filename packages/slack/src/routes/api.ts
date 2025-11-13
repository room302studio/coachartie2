import { Router, Request, Response } from 'express';
import { logger } from '@coachartie/shared';
import type { App } from '@slack/bolt';

export function createApiRouter(slackApp: App): Router {
  const router = Router();

  // GET /api/workspaces - List workspace info
  router.get('/workspaces', async (req: Request, res: Response) => {
    try {
      logger.info(`📋 API: Fetching workspace info`);

      // TODO: Fetch workspace info from Slack API
      // For now, return basic status
      res.json({
        success: true,
        message: 'Slack workspace API - coming soon',
      });
    } catch (error) {
      logger.error('Error fetching workspace info:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // GET /api/health - Slack-specific health check
  router.get('/health', async (req: Request, res: Response) => {
    try {
      res.json({
        success: true,
        service: 'slack-api',
        status: 'operational',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error in health check:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
