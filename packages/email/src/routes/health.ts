import { Router, type Router as ExpressRouter } from 'express';
import { createRedisConnection } from '@coachartie/shared';
import { getEmailTransporter } from '../utils/email.js';

export const healthRouter: ExpressRouter = Router();

healthRouter.get('/', async (req, res) => {
  try {
    // Check Redis connection
    const redis = createRedisConnection();
    await redis.ping();

    // Check email configuration
    const hasEmailConfig = !!(
      process.env.EMAIL_HOST &&
      process.env.EMAIL_USER &&
      process.env.EMAIL_PASS
    );

    // Optionally verify email connection
    let emailStatus = 'not_configured';
    if (hasEmailConfig) {
      try {
        const transporter = getEmailTransporter();
        await transporter.verify();
        emailStatus = 'connected';
      } catch (error) {
        emailStatus = 'connection_failed';
      }
    }

    res.json({
      status: 'healthy',
      service: 'email',
      timestamp: new Date().toISOString(),
      checks: {
        redis: 'connected',
        email: emailStatus,
      },
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      service: 'email',
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
