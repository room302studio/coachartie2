console.log('🚀 CAPABILITIES SERVICE STARTING - BOOKITY SNOOKITY!');
// The directory diagnostic that used to be here is gone (wave 3): DONE WHEN requires the cwd
// call to appear only in shared/paths.ts. REPO_ROOT (logged below) is the cwd-independent
// answer to "where is this process rooted" anyway.
console.log('🔧 Node version:', process.version);
console.log('🌍 Environment:', process.env.NODE_ENV);

import { config } from 'dotenv';
import { getEnvFiles, REPO_ROOT, getKillSwitch, getStrikeMode, getDatabasePath, getSteamReviewNotes, getCasinoLedger, LAUNCH_STATE, CAPABILITIES_GUILD_NOTES, MENTION_PROXY_DATA, SKILLS_DIRS, getGuildKnowledgeDirs, ENGINE_LOGS, GATEWAY_LOGS, PM2_LOGS, getLogsDir, PROMPTS_DIR, REFERENCE_DOCS } from '../shared/paths.js';

console.log('🔑 Loading environment variables...');

// Load .env from monorepo root, then the package-specific one. getEnvFiles() (paths.ts,
// wave 2) resolves both to the exact same absolute files the old
// resolve(__dirname, '../../../.env') / resolve(__dirname, '../.env') pair did — see its doc
// comment.
const envFiles = getEnvFiles('capabilities');
for (const envFile of envFiles) {
  config({ path: envFile });
}

// Every resolved runtime path, one block, every boot — so a wrong path is visible in the
// first log line instead of discovered the next time something silently reads a stale file.
// Logs every export (not just the ones this process itself reads) so a before/after diff
// between this process and the gateway's is a straight log comparison.
console.log('📂 Resolved paths:', {
  REPO_ROOT,
  ENV_FILES: envFiles,
  KILL_SWITCH: getKillSwitch(),
  STRIKE_MODE: getStrikeMode(),
  DATABASE_PATH: getDatabasePath(),
  STEAM_REVIEW_NOTES: getSteamReviewNotes(),
  CASINO_LEDGER: getCasinoLedger(),
  LAUNCH_STATE,
  CAPABILITIES_GUILD_NOTES,
  MENTION_PROXY_DATA,
  SKILLS_DIRS,
  GUILD_KNOWLEDGE_DIRS: getGuildKnowledgeDirs(),
  ENGINE_LOGS,
  GATEWAY_LOGS,
  PM2_LOGS,
  LOGS_DIR: getLogsDir(),
  PROMPTS_DIR,
  REFERENCE_DOCS,
});

console.log('🔌 Port Configuration:');
console.log('  - CAPABILITIES_PORT:', process.env.CAPABILITIES_PORT || 'not set');
console.log('  - REDIS_HOST:', process.env.REDIS_HOST || 'not set');
console.log('  - REDIS_PORT:', process.env.REDIS_PORT || 'not set');

import express from 'express';
import helmet from 'helmet';
import { logger, createRequestLogger } from '../shared/logger.js';
import { parsePortWithFallback } from '../shared/config/ports.js';
import { registerServiceWithDiscovery, serviceDiscovery } from './health/service-discovery.js';
import { startMessageConsumer } from './1-intake/queue-worker.js';
import { healthRouter } from './routes/health.js';
import { chatRouter } from './1-intake/chat-route.js';
import { schedulerRouter } from './routes/scheduler.js';
import { githubRouter } from './routes/github.js';
import { servicesRouter } from './routes/services.js';
import { memoriesRouter } from './routes/memories.js';
import modelsRouter from './routes/models.js';
import { logsRouter, stopCleanupInterval } from './routes/logs.js';
import { apiRouter } from './routes/observability.js';
import { securityRouter } from './routes/security.js';
import { sbatRouter } from './routes/sbat-email-tickets.js';
import { schedulerService } from './jobs/scheduler.js';
import { jobTracker } from './1-intake/job-tracker.js';
import { costMonitor } from './budget/session-spend.js';
import { distressMonitor } from './health/distress.js';
import { vitalsMonitor } from './health/vitals.js';
import { startDailyBudgetWatch } from './budget/daily-cap.js';
import { GlobalVariableStore } from './5-tool-loop/variables.js';
// Import orchestrator FIRST to trigger capability registration
import './services/capability/capability-orchestrator.js';
import { capabilityRegistry } from './5-tool-loop/registry.js';
import { capabilitiesRouter } from './routes/tool-registry.js';
import { simpleHealer } from './health/simple-healer.js';
import { hybridDataLayer } from './memory/store.js';
import { getMetrics, getMetricsContentType } from './health/metrics.js';
import { requireApiToken } from '../shared/require-api-token.js';

// Export openRouterService for models endpoint
export { openRouterService } from './4-generate/openrouter.js';

const app = express();

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

// Observational learning endpoint
app.post('/api/observe', async (req, res) => {
  try {
    const { prompt, guildId, channelId, messageCount, timeRange } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    // Import observation handler
    const { observationHandler } = await import('./memory/observe.js');

    // Generate summary
    const result = await observationHandler.generateObservationSummary(prompt, {
      guildId,
      channelId,
      messageCount,
      timeRange,
    });

    res.json(result);
  } catch (error) {
    logger.error('Observation endpoint error:', error);
    res.status(500).json({ error: 'Failed to process observation' });
  }
});

// Channel digest: fold new channel messages into the channel's rolling summary (channel-digest.ts)
app.post('/api/channel-digest', async (req, res) => {
  try {
    const { guildId, guildName, channelId, channelName, lines, lastMessageId } = req.body || {};
    if (!guildId || !channelId || !lastMessageId || !Array.isArray(lines)) {
      return res.status(400).json({ error: 'guildId, channelId, lastMessageId and lines[] required' });
    }
    const { refreshChannelDigest } = await import('./memory/channel-digest.js');
    const result = await refreshChannelDigest({
      guildId,
      guildName: guildName || guildId,
      channelId,
      channelName: channelName || channelId,
      lines: lines.map(String),
      lastMessageId: String(lastMessageId),
    });
    res.status(result ? 200 : 422).json(result ?? { error: 'digest not produced' });
  } catch (error) {
    logger.warn('Channel digest endpoint error:', error);
    res.status(500).json({ error: 'Failed to refresh digest' });
  }
});

// Repo routing: Artie picks the Discord channel for a newly discovered GitHub repo (repo-router.ts)
app.post('/api/route-repo', async (req, res) => {
  try {
    const { repo, channels, existing, guildId } = req.body || {};
    if (!repo?.fullName || !Array.isArray(channels)) {
      return res.status(400).json({ error: 'repo.fullName and channels[] required' });
    }
    const { pickRepoChannel } = await import('./routes/route-repo.js');
    const pick = await pickRepoChannel(repo, channels, Array.isArray(existing) ? existing : [], guildId);
    res.status(pick ? 200 : 422).json(pick ?? { error: 'no valid pick' });
  } catch (error) {
    logger.warn('Repo routing endpoint error:', error);
    res.status(500).json({ error: 'routing failed' });
  }
});

// Observation stats endpoint
app.get('/api/observe/stats', async (req, res) => {
  try {
    const { observationHandler } = await import('./memory/observe.js');
    const stats = await observationHandler.getObservationStats();
    res.json(stats);
  } catch (error) {
    logger.error('Observation stats error:', error);
    res.status(500).json({ error: 'Failed to get observation stats' });
  }
});

// Reflection threshold check endpoint - triggers emergency reflection if threshold crossed
app.post('/api/reflection/check-threshold', async (req, res) => {
  try {
    const { guildId, threshold, hours } = req.body;

    if (!guildId || !threshold) {
      return res.status(400).json({ error: 'guildId and threshold are required' });
    }

    // Import the consolidator
    const { reflectionConsolidator, countRecentNegativeFeedback } = await import(
      './memory/reflection-consolidator.js'
    );

    // Check count of recent negative feedback
    const count = await countRecentNegativeFeedback(guildId, hours || 1);

    if (count >= threshold) {
      // Trigger emergency reflection
      const result = await reflectionConsolidator.triggerEmergencyReflection(
        guildId,
        `${count} negative reactions in last ${hours || 1} hour(s)`
      );

      res.json({
        triggered: true,
        count,
        threshold,
        rulesCreated: result.rulesCreated,
      });
    } else {
      res.json({
        triggered: false,
        count,
        threshold,
      });
    }
  } catch (error) {
    logger.error('Reflection threshold check error:', error);
    res.status(500).json({ error: 'Failed to check reflection threshold' });
  }
});

// Reflection stats endpoint - get active rules and reflection statistics
app.get('/api/reflection/stats', async (req, res) => {
  try {
    const { reflectionConsolidator } = await import(
      './memory/reflection-consolidator.js'
    );

    const systemRules = await reflectionConsolidator.getActiveRules('system');

    // Get guild-specific rules count
    const { getSyncDb } = await import('../shared/db/client.js');
    const db = getSyncDb();

    const guildStats = db.all<{ scope_id: string; count: number }>(
      `SELECT scope_id, COUNT(*) as count
       FROM learned_rules
       WHERE rule_type = 'guild' AND is_active = 1
       GROUP BY scope_id`
    );

    const totalRules = db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM learned_rules WHERE is_active = 1`
    );

    res.json({
      systemRules: systemRules.length,
      guildRules: guildStats || [],
      totalActiveRules: totalRules?.count || 0,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Reflection stats error:', error);
    res.status(500).json({ error: 'Failed to get reflection stats' });
  }
});

// Start queue consumers and scheduler
async function startQueueWorkers() {
  try {
    logger.info('Starting queue consumers...');
    const worker = await startMessageConsumer();
    if (worker) {
      logger.info('Queue consumers started successfully');
    } else {
      logger.warn('Queue consumers not started (Redis unavailable)');
    }
  } catch (error) {
    logger.error('Failed to start queue consumers:', error);
    // Don't exit - continue without queues
  }
}

async function startScheduler() {
  try {
    // Initialize scheduler (checks Redis availability)
    const initialized = await schedulerService.initialize();
    if (!initialized) {
      logger.warn('Scheduler not initialized (Redis unavailable)');
      return;
    }

    // Setup default tasks if enabled
    if (process.env.ENABLE_SCHEDULING !== 'false') {
      await schedulerService.setupDefaultTasks();
    }
  } catch (error) {
    logger.error('Failed to setup scheduler:', error);
    // Don't exit - scheduler is optional
  }
}

// Start server
async function start() {
  console.log('🎯 Start function called - LUCKS ARE SNUCK!');
  try {
    // Initialize orchestrator
    console.log('📊 Initializing orchestrator...');
    const stats = capabilityRegistry.getStats();

    // Start queue workers first
    console.log('👷 Starting queue workers...');
    await startQueueWorkers();

    // Daily spend cap FIRST, before anything that can generate: it lifts a stale budget mute
    // from a previous ET day and trips the mute if today's spend is already over the cap.
    console.log('💸 Starting daily budget watch...');
    startDailyBudgetWatch();

    // Start scheduler
    console.log('⏰ Starting scheduler...');
    await startScheduler();

    // Start simple healer
    console.log('🏥 Starting simple healer...');
    simpleHealer.start();

    // Start distress monitor (detects when Artie needs help)
    console.log('🆘 Starting distress monitor...');
    distressMonitor.start();

    // Start vitals monitor (hourly self-audit of prod logs + operator alarms)
    console.log('🩺 Starting vitals monitor...');
    vitalsMonitor.start();

    console.log('🔍 Parsing port configuration...');
    console.log('  - CAPABILITIES_PORT env:', process.env.CAPABILITIES_PORT);
    const PORT = await parsePortWithFallback('CAPABILITIES_PORT', 'capabilities');
    console.log(`🎲 Selected port: ${PORT}`);

    // Start HTTP server
    console.log(`🌐 Starting HTTP server on 127.0.0.1:${PORT}...`);
    const server = app.listen(PORT, '127.0.0.1', async () => {
      console.log(`✅ HTTP SERVER LISTENING - SNUCKS ARE JUCKED!`);
      logger.info(
        `✅ capabilities: ${PORT} [${stats.totalCapabilities} caps, ${stats.totalActions} actions]`
      );
      await registerServiceWithDiscovery('capabilities', PORT);
    });

    // Enhanced error handling with helpful developer guidance
    server.on('error', (error: Error) => {
      if ((error as any).code === 'EADDRINUSE') {
        console.error('\n' + '='.repeat(60));
        console.error('❌ PORT CONFLICT DETECTED!');
        console.error('='.repeat(60));
        console.error(`Port ${PORT} is already in use!\n`);

        console.error('This usually means one of the following:');
        console.error('1. Docker is running Coach Artie (check: docker ps)');
        console.error('2. A previous instance is still running');
        console.error('3. Another service is using this port\n');

        console.error('TO FIX THIS:');
        console.error('------------');
        console.error('Option 1: If Docker is running Coach Artie:');
        console.error('  $ docker-compose down');
        console.error('  $ pnpm run dev\n');

        console.error('Option 2: Kill the process using this port:');
        console.error(`  $ lsof -ti :${PORT} | xargs kill -9`);
        console.error('  $ pnpm run dev\n');

        console.error('Option 3: Use the built-in port checker:');
        console.error('  $ pnpm run check-ports');
        console.error("  (This will show you exactly what's using each port)\n");

        console.error('='.repeat(60) + '\n');
      } else {
        logger.error(`❌ Server failed to start on port ${PORT}:`, error);
      }
      process.exit(1);
    });

    // DELETE the self-test - if it works, it works
  } catch (error) {
    logger.error('Failed to start capabilities service:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
async function gracefulShutdown() {
  logger.info('🛑 Graceful shutdown initiated...');

  try {
    // Stop services in order
    logger.info('Stopping simple healer...');
    simpleHealer.stop();

    logger.info('Shutting down scheduler...');
    await schedulerService.close();

    logger.info('Shutting down job tracker...');
    jobTracker.shutdown();

    logger.info('Shutting down cost monitor...');
    costMonitor.shutdown();

    logger.info('Stopping job logs cleanup interval...');
    stopCleanupInterval();

    logger.info('Shutting down variable store...');
    GlobalVariableStore.getInstance().shutdown();

    logger.info('Cleaning up hybrid data layer...');
    await hybridDataLayer.cleanup();

    logger.info('Shutting down service discovery...');
    await serviceDiscovery.shutdown();

    logger.info('✅ Graceful shutdown complete');
  } catch (error) {
    logger.error('Error during graceful shutdown:', error);
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Catch unhandled errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  // Don't exit, just log
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit, just log
});

// Start the service
start();
