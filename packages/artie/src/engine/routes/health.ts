import { Router, type Router as ExpressRouter } from 'express';
import { engineDeps, defaultEngineDeps, type EngineDeps } from '../deps.js';
import { getDatabasePath } from '../../shared/paths.js';
import { access } from 'fs/promises';
import { logger } from '../../shared/logger.js';
import { type ApiResult, sendResult } from '../../shared/api-result.js';
import { getErrorMessage } from '../../shared/errors.js';

// Wave 9: the handler body is an exported function returning the status + JSON it used to
// send; the route sends it and engine/api.ts calls it in-process for the gateway.
const reply = (status: number, body: any): ApiResult => ({ status, body });
import os from 'os';
import { creditMonitor } from '../budget/openrouter-balance.js';

export const healthRouter: ExpressRouter = Router();

// Basic health check
healthRouter.get('/', async (req, res) => sendResult(res, await healthSnapshot(engineDeps(req))));

// Detailed health check with system metrics
healthRouter.get('/detailed', async (req, res) => {
  const startTime = Date.now();
  const checks: Record<string, any> = {};
  let overallStatus = 'healthy';

  try {
    // Check Redis connection
    try {
      const redisStart = Date.now();
      await engineDeps(req).pingRedis();
      checks.redis = {
        status: 'connected',
        responseTime: Date.now() - redisStart,
      };
    } catch (error) {
      checks.redis = {
        status: 'error',
        error: getErrorMessage(error),
      };
      overallStatus = 'degraded';
    }

    // Check database accessibility
    try {
      const dbPath = getDatabasePath();
      await access(dbPath);
      checks.database = {
        status: 'accessible',
        path: dbPath,
      };
    } catch (error) {
      checks.database = {
        status: 'inaccessible',
        error: getErrorMessage(error),
      };
      overallStatus = 'degraded';
    }

    // Check MCP tool registry
    const mcpRegistry = (global as any).mcpToolRegistry;
    const mcpStatus = mcpRegistry ? 'initialized' : 'not_initialized';
    const mcpToolCount = mcpRegistry ? mcpRegistry.size : 0;
    checks.mcp = {
      status: mcpStatus,
      toolCount: mcpToolCount,
    };

    // System metrics
    const memUsage = process.memoryUsage();
    const systemMem = {
      total: os.totalmem(),
      free: os.freemem(),
      used: os.totalmem() - os.freemem(),
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
          external: Math.round(memUsage.external / 1024 / 1024), // MB
        },
        system: {
          total: Math.round(systemMem.total / 1024 / 1024), // MB
          free: Math.round(systemMem.free / 1024 / 1024), // MB
          used: Math.round(systemMem.used / 1024 / 1024), // MB
          usage: Math.round((systemMem.used / systemMem.total) * 100), // %
        },
      },
    };

    // Environment info
    checks.environment = {
      nodeEnv: process.env.NODE_ENV || 'development',
      logLevel: process.env.LOG_LEVEL || 'info',
      port: process.env.CAPABILITIES_PORT || '47324',
    };

    const responseTime = Date.now() - startTime;

    res.json({
      status: overallStatus,
      service: 'capabilities',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      responseTime,
      checks,
    });
  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      service: 'capabilities',
      timestamp: new Date().toISOString(),
      responseTime: Date.now() - startTime,
      error: getErrorMessage(error),
    });
  }
});

// Ready check (for kubernetes/docker readiness probes)
healthRouter.get('/ready', async (req, res) => {
  try {
    // Check essential services are ready
    await engineDeps(req).pingRedis();

    // Check if database is accessible
    const dbPath = getDatabasePath();
    await access(dbPath);

    res.json({
      status: 'ready',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      status: 'not_ready',
      timestamp: new Date().toISOString(),
      error: getErrorMessage(error),
    });
  }
});

// Live check (for kubernetes/docker liveness probes)
healthRouter.get('/live', (req, res) => {
  // Simple alive check - if this endpoint responds, the process is alive
  res.json({
    status: 'alive',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Admin: Clear credit exhaustion flag (call when credits are re-added)
healthRouter.post('/admin/clear-credit-flag', (req, res) => {
  // Simple auth check - expects Authorization header or secret
  const auth = req.headers.authorization;
  const expectedSecret = process.env.ADMIN_SECRET || 'admin-secret';

  if (!auth || auth !== `Bearer ${expectedSecret}`) {
    logger.warn('❌ Unauthorized attempt to clear credit flag');
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization header',
    });
  }

  creditMonitor.clearExhaustedFlag();
  logger.info('✅ Credit exhaustion flag cleared via admin endpoint');

  res.json({
    status: 'success',
    message: '💳 Credit exhaustion flag cleared. LLM calls will resume immediately.',
    timestamp: new Date().toISOString(),
  });
});

/** GET /health's body: 200 healthy when Redis answers a ping, else 503. */
export async function healthSnapshot(deps: EngineDeps = defaultEngineDeps): Promise<ApiResult> {
  try {
    // Check Redis connection
    await deps.pingRedis();

    return reply(200, {
      status: 'healthy',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return reply(503, {
      status: 'unhealthy',
      service: 'capabilities',
      timestamp: new Date().toISOString(),
      error: getErrorMessage(error),
    });
  }
}
