import { FastifyPluginAsync } from 'fastify';
import { createRedisConnection } from '@coachartie/shared/dist/utils/redis';
import { logger } from '@coachartie/shared/dist/utils/logger';

// Using shared logger instance

interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  services: {
    redis: 'connected' | 'disconnected' | 'error';
    database: 'connected' | 'disconnected' | 'error';
    memory: {
      used: string;
      total: string;
      percentage: number;
    };
    process: {
      pid: number;
      version: string;
      platform: string;
    };
  };
  errors?: string[];
}

export const createHealthRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', async (request, reply) => {
    const errors: string[] = [];
    let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

    // Check Redis connection
    let redisStatus: 'connected' | 'disconnected' | 'error' = 'disconnected';
    try {
      const redis = createRedisConnection();
      await Promise.race([
        redis.ping(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Redis timeout')), 2000)
        )
      ]);
      redisStatus = 'connected';
      redis.disconnect();
    } catch (error) {
      redisStatus = 'error';
      errors.push(`Redis: ${error instanceof Error ? error.message : 'Unknown error'}`);
      overallStatus = 'degraded';
    }

    // Check database (SQLite)
    let databaseStatus: 'connected' | 'disconnected' | 'error' = 'disconnected';
    try {
      const Database = require('better-sqlite3');
      const dbPath = process.env.DATABASE_PATH || './data/coachartie.db';
      const db = new Database(dbPath, { readonly: true });
      
      // Simple test query
      const result = db.prepare('SELECT 1 as test').get();
      if (result && result.test === 1) {
        databaseStatus = 'connected';
      } else {
        throw new Error('Database test query failed');
      }
      db.close();
    } catch (error) {
      databaseStatus = 'error';
      errors.push(`Database: ${error instanceof Error ? error.message : 'Unknown error'}`);
      overallStatus = 'degraded';
    }

    // Memory usage
    const memUsage = process.memoryUsage();
    const totalMem = require('os').totalmem();
    const memPercentage = Math.round((memUsage.heapUsed / totalMem) * 100 * 100) / 100;

    // If too many errors, mark as unhealthy
    if (errors.length >= 2) {
      overallStatus = 'unhealthy';
    }

    const healthResponse: HealthResponse = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      services: {
        redis: redisStatus,
        database: databaseStatus,
        memory: {
          used: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
          total: `${Math.round(totalMem / 1024 / 1024)}MB`,
          percentage: memPercentage
        },
        process: {
          pid: process.pid,
          version: process.version,
          platform: process.platform
        }
      }
    };

    if (errors.length > 0) {
      healthResponse.errors = errors;
    }

    // Set appropriate HTTP status
    const statusCode = overallStatus === 'healthy' ? 200 : 
                      overallStatus === 'degraded' ? 200 : 503;

    logger.info(`Health check completed: ${overallStatus}`, {
      redis: redisStatus,
      database: databaseStatus,
      errors: errors.length
    });

    await reply.status(statusCode).send(healthResponse);
  });

  // Simple test endpoint for self-checks
  fastify.get('/test', async (request, reply) => {
    return { 
      message: 'Server is running!',
      timestamp: new Date().toISOString(),
      framework: 'Fastify'
    };
  });
};