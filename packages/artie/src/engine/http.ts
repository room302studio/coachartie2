import express, { type Express } from 'express';
import helmet from 'helmet';
import { createRequestLogger } from '../shared/logger.js';
import { healthRouter } from './routes/health.js';
import { chatRouter } from './1-intake/chat-route.js';
import { schedulerRouter } from './routes/scheduler.js';
import { githubRouter } from './routes/github.js';
import { servicesRouter } from './routes/services.js';
import { memoriesRouter } from './routes/memories.js';
import modelsRouter from './routes/models.js';
import { logsRouter } from './routes/logs.js';
import { apiRouter } from './routes/observability.js';
import { securityRouter } from './routes/security.js';
import { sbatRouter } from './routes/sbat-email-tickets.js';
import { capabilitiesRouter } from './routes/tool-registry.js';
import { observeRouter } from './routes/observe.js';
import { channelDigestRouter } from './routes/channel-digest.js';
import { routeRepoRouter } from './routes/route-repo.js';
import { reflectionRouter } from './routes/reflection.js';
import { getMetrics, getMetricsContentType } from './health/metrics.js';
import { requireApiToken } from '../shared/require-api-token.js';
import { defaultEngineDeps, type EngineDeps } from './deps.js';

/**
 * The engine's express app: middleware, /test, /metrics and every router mount, in the
 * order engine/main.ts registered them before wave 6. main.ts owns boot and listen().
 *
 * A factory (wave 9) so tests/http-contracts.test.ts can build the real app with stub deps
 * (no Redis) and listen on port 0. `deps` overrides the Redis-touching defaults in deps.ts.
 */
export function createEngineApp(deps: Partial<EngineDeps> = {}): Express {
  const app: Express = express();
  app.locals.engineDeps = { ...defaultEngineDeps, ...deps };

  // CORS middleware - allow Brain UI to connect
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header(
      'Access-Control-Allow-Headers',
      'Origin, X-Requested-With, Content-Type, Accept, Authorization'
    );

    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }

    next();
  });

  // Middleware
  app.use(
    helmet({
      crossOriginResourcePolicy: false,
    })
  );
  app.use(express.json({
    // Capture raw body for webhook signature verification (SBAT inbound email)
    verify: (req, _res, buf) => {
      if (req.headers['x-mailersend-signature']) {
        (req as any).rawBody = buf.toString();
      }
    },
  }));
  app.use(createRequestLogger('capabilities'));

  // Remote callers (Cloudflare tunnel api.artie.tools, Caddy, docker bridges) need the
  // token; direct 127.0.0.1 callers don't. Health checks and the two webhooks that verify
  // their own signatures (MailerSend -> /api/sbat, GitHub -> /github/webhook) stay open.
  app.use(
    requireApiToken([
      (req) => req.path === '/test' || req.path === '/health' || req.path.startsWith('/health/'),
      (req) => req.method === 'GET' && req.path === '/github/health',
      (req) =>
        req.method === 'POST' && (req.path === '/github/webhook' || req.path.startsWith('/api/sbat')),
    ])
  );

  // Test route
  app.get('/test', (req, res) => {
    res.send('Server is running!');
  });

  // Prometheus metrics endpoint
  app.get('/metrics', async (req, res) => {
    try {
      res.set('Content-Type', getMetricsContentType());
      res.end(await getMetrics());
    } catch (err) {
      res.status(500).end((err as Error).message);
    }
  });

  // Routes
  app.use('/health', healthRouter);
  app.use('/chat', chatRouter);
  app.use('/capabilities', capabilitiesRouter);
  app.use('/scheduler', schedulerRouter);
  app.use('/github', githubRouter);
  app.use('/security', securityRouter);
  app.use('/services', servicesRouter);
  app.use('/api/memories', memoriesRouter);
  app.use('/api/models', modelsRouter);
  app.use('/api', apiRouter); // Context Alchemy observability + experiments
  app.use('/api/sbat', sbatRouter); // SBAT inbound email tickets
  app.use('/logs', logsRouter);

  // The routes that used to be inline in main.ts, mounted where they were registered (after
  // /logs, so apiRouter still sees every /api/* request first): /api/observe,
  // /api/observe/stats, /api/channel-digest, /api/route-repo and /api/reflection/*.
  app.use('/api', observeRouter);
  app.use('/api', channelDigestRouter);
  app.use('/api', routeRepoRouter);
  app.use('/api', reflectionRouter);

  return app;
}
