import { Router, type Router as ExpressRouter } from 'express';
import { createRedisConnection } from '@coachartie/shared';
import { getTwilioClient } from '../utils/twilio.js';

export const healthRouter: ExpressRouter = Router();

healthRouter.get('/', async (req, res) => {
  try {
    // Check Redis connection
    const redis = createRedisConnection();
    await redis.ping();

    // Check Twilio credentials (basic validation, don't throw)
    const hasValidAuth = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);

    // Only try to get Twilio client if credentials exist
    if (hasValidAuth) {
      try {
        const twilio = getTwilioClient();
      } catch (e) {
        // Log but don't fail health check for missing Twilio
      }
    }

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      twilioConfigured: hasValidAuth,
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      service: 'sms',
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
