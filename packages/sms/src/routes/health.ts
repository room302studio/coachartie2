import { Router, type Router as ExpressRouter } from 'express';
import { createRedisConnection } from '@coachartie/shared';
import { getTwilioClient } from '../utils/twilio.js';

export const healthRouter: ExpressRouter = Router();

healthRouter.get('/', async (req, res) => {
  try {
    // Check Redis connection
    const redis = createRedisConnection();
    await redis.ping();

    // Check Twilio credentials (basic validation)
    const twilio = getTwilioClient();
    const isValidAuth = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      service: 'sms',
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});