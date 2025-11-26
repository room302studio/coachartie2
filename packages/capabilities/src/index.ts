console.log('🚀 CAPABILITIES SERVICE STARTING - BOOKITY SNOOKITY!');
console.log('📍 Current directory:', process.cwd());
console.log('🔧 Node version:', process.version);
console.log('🌍 Environment:', process.env.NODE_ENV);

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

console.log('📁 __dirname:', __dirname);
console.log('🔑 Loading environment variables...');

// Load .env from monorepo root (go up from packages/capabilities/src to monorepo root)
config({ path: resolve(__dirname, '../../../.env') });
// Also try package-specific .env
config({ path: resolve(__dirname, '../.env') });

console.log('🔌 Port Configuration:');
console.log('  - CAPABILITIES_PORT:', process.env.CAPABILITIES_PORT || 'not set');
console.log('  - REDIS_HOST:', process.env.REDIS_HOST || 'not set');
console.log('  - REDIS_PORT:', process.env.REDIS_PORT || 'not set');

import express from 'express';
import helmet from 'helmet';
import {
  logger,
  createRequestLogger,
  parsePortWithFallback,
  registerServiceWithDiscovery,
  serviceDiscovery,
} from '@coachartie/shared';
import { startMessageConsumer } from './queues/consumer.js';
import { healthRouter } from './routes/health.js';
import { chatRouter } from './routes/chat.js';
import { schedulerRouter } from './routes/scheduler.js';
import { githubRouter } from './routes/github.js';
import { servicesRouter } from './routes/services.js';
import { memoriesRouter } from './routes/memories.js';
import modelsRouter from './routes/models.js';
import { logsRouter, stopCleanupInterval } from './routes/logs.js';
import { schedulerService } from './services/scheduler.js';
import { jobTracker } from './services/job-tracker.js';
import { costMonitor } from './services/cost-monitor.js';
import { GlobalVariableStore } from './capabilities/variable-store.js';
// Import orchestrator FIRST to trigger capability registration
import './services/capability-orchestrator.js';
import { capabilityRegistry } from './services/capability-registry.js';
import { capabilitiesRouter } from './routes/capabilities.js';
import { simpleHealer } from './runtime/simple-healer.js';
import { hybridDataLayer } from './runtime/hybrid-data-layer.js';

// Export openRouterService for models endpoint
export { openRouterService } from './services/openrouter.js';

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
app.use(express.json());
app.use(createRequestLogger('capabilities'));

// Test route
app.get('/test', (req, res) => {
  res.send('Server is running!');
});

// Routes
app.use('/health', healthRouter);
app.use('/chat', chatRouter);
app.use('/capabilities', capabilitiesRouter);
app.use('/scheduler', schedulerRouter);
app.use('/github', githubRouter);
app.use('/services', servicesRouter);
app.use('/api/memories', memoriesRouter);
app.use('/api/models', modelsRouter);
app.use('/logs', logsRouter);

// Observational learning endpoint
app.post('/api/observe', async (req, res) => {
  try {
    const { prompt, guildId, channelId, messageCount, timeRange } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    // Import observation handler
    const { observationHandler } = await import('./services/observation-handler.js');

    // Generate summary
    const result = await observationHandler.generateObservationSummary(
      prompt,
      { guildId, channelId, messageCount, timeRange }
    );

    res.json(result);
  } catch (error) {
    logger.error('Observation endpoint error:', error);
    res.status(500).json({ error: 'Failed to process observation' });
  }
});

// Observation stats endpoint
app.get('/api/observe/stats', async (req, res) => {
  try {
    const { observationHandler } = await import('./services/observation-handler.js');
    const stats = await observationHandler.getObservationStats();
    res.json(stats);
  } catch (error) {
    logger.error('Observation stats error:', error);
    res.status(500).json({ error: 'Failed to get observation stats' });
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

    // Start scheduler
    console.log('⏰ Starting scheduler...');
    await startScheduler();

    // Start simple healer
    console.log('🏥 Starting simple healer...');
    simpleHealer.start();

    console.log('🔍 Parsing port configuration...');
    console.log('  - CAPABILITIES_PORT env:', process.env.CAPABILITIES_PORT);
    const PORT = await parsePortWithFallback('CAPABILITIES_PORT', 'capabilities');
    console.log(`🎲 Selected port: ${PORT}`);

    // Start HTTP server
    console.log(`🌐 Starting HTTP server on 0.0.0.0:${PORT}...`);
    const server = app.listen(PORT, '0.0.0.0', async () => {
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
