import { Router } from 'express';
import { logger } from '../../shared/logger.js';
import { handleGitHubWebhook } from '../jobs/github-push/handle-push.js';

export const githubRouter: Router = Router();

githubRouter.post('/webhook', async (req, res) => {
  try {
    logger.info('📡 GitHub webhook received', {
      event: req.headers['x-github-event'],
      delivery: req.headers['x-github-delivery'],
    });

    await handleGitHubWebhook(req.body, req.headers);

    res.status(200).json({
      status: 'processed',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('❌ GitHub webhook processing failed:', error);
    res.status(500).json({
      error: 'Internal server error',
      timestamp: new Date().toISOString(),
    });
  }
});

// Health check specifically for GitHub integration
githubRouter.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'github-integration',
    timestamp: new Date().toISOString(),
  });
});
