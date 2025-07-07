import { Router, type Router as ExpressRouter } from 'express';
import { createRedisConnection } from '@coachartie/shared';

export const healthRouter: ExpressRouter = Router();

healthRouter.get('/', async (req, res) => {
  try {
    // Check Redis connection
    const redis = createRedisConnection();
    await redis.ping();

    res.json({
      status: 'healthy',
      service: 'capabilities',
      timestamp: new Date().toISOString(),
      checks: {
        redis: 'connected'
      }
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      service: 'capabilities',
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});