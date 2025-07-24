import { Router, type Router as ExpressRouter } from 'express';
import { createRedisConnection } from '@coachartie/shared';
import { access } from 'fs/promises';
import { join } from 'path';
import { logger } from '@coachartie/shared';
import os from 'os';

export const healthRouter: ExpressRouter = Router();

// Basic health check
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

// Detailed health check with system metrics
healthRouter.get('/detailed', async (req, res) => {
  const startTime = Date.now();
  const checks: Record<string, any> = {};
  let overallStatus = 'healthy';

  try {
    // Check Redis connection
    try {
      const redis = createRedisConnection();
      const redisStart = Date.now();
      await redis.ping();
      checks.redis = {
        status: 'connected',
        responseTime: Date.now() - redisStart
      };
    } catch (error) {
      checks.redis = {
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
      overallStatus = 'degraded';
    }

    // Check database accessibility
    try {
      const dbPath = process.env.DATABASE_PATH || '/app/data/coachartie.db';
      await access(dbPath);
      checks.database = {
        status: 'accessible',
        path: dbPath
      };
    } catch (error) {
      checks.database = {
        status: 'inaccessible',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
      overallStatus = 'degraded';
    }

    // Check MCP tool registry
    const mcpRegistry = (global as any).mcpToolRegistry;
    checks.mcp = {
      status: mcpRegistry ? 'initialized' : 'not_initialized',
      toolCount: mcpRegistry ? mcpRegistry.size : 0
    };

    // System metrics
    const memUsage = process.memoryUsage();
    const systemMem = {
      total: os.totalmem(),
      free: os.freemem(),
      used: os.totalmem() - os.freemem()
    };

    checks.system = {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptime: process.uptime(),
      cpuUsage: process.cpuUsage(),
      memory: {
        process: {
          rss: Math.round(memUsage.rss / 1024 / 1024), // MB
          heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
          heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
          external: Math.round(memUsage.external / 1024 / 1024) // MB
        },
        system: {
          total: Math.round(systemMem.total / 1024 / 1024), // MB
          free: Math.round(systemMem.free / 1024 / 1024), // MB
          used: Math.round(systemMem.used / 1024 / 1024), // MB
          usage: Math.round((systemMem.used / systemMem.total) * 100) // %
        }
      }
    };

    // Environment info
    checks.environment = {
      nodeEnv: process.env.NODE_ENV || 'development',
      logLevel: process.env.LOG_LEVEL || 'info',
      port: process.env.CAPABILITIES_PORT || '18239'
    };

    const responseTime = Date.now() - startTime;

    res.json({
      status: overallStatus,
      service: 'capabilities',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      responseTime,
      checks
    });

  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      service: 'capabilities',
      timestamp: new Date().toISOString(),
      responseTime: Date.now() - startTime,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Ready check (for kubernetes/docker readiness probes)
healthRouter.get('/ready', async (req, res) => {
  try {
    // Check essential services are ready
    const redis = createRedisConnection();
    await redis.ping();
    
    // Check if database is accessible
    const dbPath = process.env.DATABASE_PATH || '/app/data/coachartie.db';
    await access(dbPath);

    res.json({
      status: 'ready',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({
      status: 'not_ready',
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Live check (for kubernetes/docker liveness probes)
healthRouter.get('/live', (req, res) => {
  // Simple alive check - if this endpoint responds, the process is alive
  res.json({
    status: 'alive',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});