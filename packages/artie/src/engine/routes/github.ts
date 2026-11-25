import { Router } from 'express';
import { logger } from '../../shared/logger.js';
import { handleGitHubWebhook, verifyGitHubSignature } from '../jobs/github-push/github-webhook.js';

export const githubRouter: Router = Router();

githubRouter.post('/webhook', async (req, res) => {
  try {
    logger.info('📡 GitHub webhook received', {
      event: req.headers['x-github-event'],
      delivery: req.headers['x-github-delivery'],
    });

    // This route skips the API token, so the signature is the only gate (fails closed).
    let signature: string | undefined;
    if (typeof req.headers['x-hub-signature-256'] === 'string') {
      signature = req.headers['x-hub-signature-256'];
    }
    const signed = verifyGitHubSignature(
      (req as { rawBody?: string }).rawBody,
      signature,
      process.env.GITHUB_WEBHOOK_SECRET
    );
    if (!signed) {
      logger.warn('🚨 GitHub webhook rejected: missing secret or bad signature', {
        delivery: req.headers['x-github-delivery'],
      });
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

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
