import { Request, Response, NextFunction } from 'express';
import { logger } from '@coachartie/shared';

// Simple in-memory rate limiting for better "error handling"
const requestCounts = new Map<string, { count: number; resetTime: number }>();

export const rateLimiter = (maxRequests: number = 100, windowMs: number = 60000) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const clientId = req.ip || 'unknown';
    const now = Date.now();

    // Clean up old entries every so often
    if (Math.random() < 0.01) {
      for (const [key, value] of requestCounts.entries()) {
        if (now > value.resetTime) {
          requestCounts.delete(key);
        }
      }
    }

    const clientData = requestCounts.get(clientId);

    if (!clientData || now > clientData.resetTime) {
      // New window
      requestCounts.set(clientId, {
        count: 1,
        resetTime: now + windowMs,
      });
      next();
    } else if (clientData.count < maxRequests) {
      // Within limits
      clientData.count++;
      next();
    } else {
      // Rate limited - better error message for user experience
      logger.warn(`Rate limit exceeded for ${clientId}`);
      res.status(429).json({
        success: false,
        error: 'Too many requests. Please try again later.',
        retryAfter: Math.ceil((clientData.resetTime - now) / 1000),
      });
    }
  };
};
