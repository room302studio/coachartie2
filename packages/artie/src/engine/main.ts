/**
 * The engine: queue workers, the scheduler, the monitors and the :47324 HTTP API.
 *
 * Wave 9 (one process): this module no longer runs itself, loads .env, or installs signal
 * handlers. src/main.ts does those once for the whole bot and calls startEngine(), then the
 * gateway's startGateway(); its one SIGINT/SIGTERM handler calls the returned stop().
 */
import type { Server } from 'http';
import type { Worker } from 'bullmq';
import { logger } from '../shared/logger.js';
import { parsePortWithFallback } from '../shared/config/ports.js';
import { registerServiceWithDiscovery, serviceDiscovery } from './health/service-discovery.js';
import { startMessageConsumer } from './1-intake/queue-worker.js';
// The express app, its middleware and every route (http.ts). main.ts only boots and listens.
import { createEngineApp } from './http.js';
import { stopCleanupInterval } from './routes/logs.js';
import { schedulerService } from './jobs/scheduler.js';
import { jobTracker } from './1-intake/job-tracker.js';
import { costMonitor } from './budget/usage-ledger.js';
import { distressMonitor } from './health/distress.js';
import { vitalsMonitor, simpleHealer } from './health/vitals.js';
import { startDailyBudgetWatch } from './budget/daily-cap.js';
import { startJarEarningsWatch } from './budget/jar-earnings.js';
import { GlobalVariableStore } from './5-tool-loop/variables.js';
// Import the turn spine FIRST to trigger capability registration (its orchestrator
// singleton runs the bootstrap at module load). Wave 3 left this path pointing at the
// pre-move services/capability/ tree; tsc doesn't check side-effect-only imports, so it
// would have thrown ERR_MODULE_NOT_FOUND at boot.
import './2-turn/run-turn.js';
import { capabilityRegistry } from './5-tool-loop/registry.js';
import { toolLoopMode } from './5-tool-loop/mode.js';
import { openRouterModelsService } from './4-generate/model-catalog.js';
import { hybridDataLayer } from './memory/store.js';

// Export openRouterService for models endpoint
export { openRouterService } from './4-generate/openrouter.js';

export interface EngineHandle {
  /** The :47324 server, listening. */
  server: Server;
  /** The INCOMING_MESSAGES worker (null when Redis was unavailable at boot). */
  incomingWorker: Worker | null;
  /** Stop everything startEngine started, in reverse order. Never exits the process. */
  stop(): Promise<void>;
}

// Start queue consumers and scheduler
async function startQueueWorkers(): Promise<Worker | null> {
  try {
    logger.info('Starting queue consumers...');
    const worker = await startMessageConsumer();
    if (worker) {
      logger.info('Queue consumers started successfully');
    } else {
      logger.warn('Queue consumers not started (Redis unavailable)');
    }
    return worker;
  } catch (error) {
    logger.error('Failed to start queue consumers:', error);
    // Don't exit - continue without queues
    return null;
  }
}

// Redis down at boot used to mean no scheduler (no reminders, no crons) until the next
// restart (2026-10-31). Retry once a minute until it comes up; stop() clears the timer.
const SCHEDULER_RETRY_MS = 60_000;
let schedulerRetry: NodeJS.Timeout | null = null;

async function startScheduler() {
  schedulerRetry = null;
  try {
    // Initialize scheduler (checks Redis availability)
    const initialized = await schedulerService.initialize();
    if (!initialized) {
      logger.warn(`Scheduler not initialized (Redis unavailable) — retrying in ${SCHEDULER_RETRY_MS / 1000}s`);
      schedulerRetry = setTimeout(() => {
        void startScheduler();
      }, SCHEDULER_RETRY_MS);
      schedulerRetry.unref();
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

/** Listen on 127.0.0.1:<port>; resolves once listening. EADDRINUSE still exits, as before. */
function listen(port: number, stats: { totalCapabilities: number; totalActions: number }): Promise<Server> {
  return new Promise((resolve) => {
    console.log(`🌐 Starting HTTP server on 127.0.0.1:${port}...`);
    const server = createEngineApp().listen(port, '127.0.0.1', async () => {
      console.log(`✅ HTTP SERVER LISTENING - SNUCKS ARE JUCKED!`);
      logger.info(
        `✅ capabilities: ${port} [${stats.totalCapabilities} caps, ${stats.totalActions} actions]`
      );
      resolve(server);
      await registerServiceWithDiscovery('capabilities', port);
    });

    // Enhanced error handling with helpful developer guidance
    server.on('error', (error: Error) => {
      if ((error as any).code === 'EADDRINUSE') {
        console.error('\n' + '='.repeat(60));
        console.error('❌ PORT CONFLICT DETECTED!');
        console.error('='.repeat(60));
        console.error(`Port ${port} is already in use!\n`);

        console.error('This usually means one of the following:');
        console.error('1. A previous instance is still running (pm2 list)');
        console.error('2. Another service is using this port\n');

        console.error('TO FIX THIS:');
        console.error('------------');
        console.error('Kill the process using this port:');
        console.error(`  $ lsof -ti :${port} | xargs kill -9`);
        console.error('  $ pnpm run dev\n');

        console.error('='.repeat(60) + '\n');
      } else {
        logger.error(`❌ Server failed to start on port ${port}:`, error);
      }
      process.exit(1);
    });
  });
}

/**
 * Start the engine: queue workers, daily budget watch, scheduler, monitors, then the HTTP
 * API on 127.0.0.1, port CAPABILITIES_PORT (47324). Resolves once the server is listening.
 */
export async function startEngine(): Promise<EngineHandle> {
  console.log('🚀 CAPABILITIES SERVICE STARTING - BOOKITY SNOOKITY!');
  console.log('🔌 Port Configuration:');
  console.log('  - CAPABILITIES_PORT:', process.env.CAPABILITIES_PORT || 'not set');
  console.log('  - REDIS_HOST:', process.env.REDIS_HOST || 'not set');
  console.log('  - REDIS_PORT:', process.env.REDIS_PORT || 'not set');

  console.log('🎯 Start function called - LUCKS ARE SNUCK!');
  // Initialize orchestrator
  console.log('📊 Initializing orchestrator...');
  const stats = capabilityRegistry.getStats();

  // Which tool loop this process runs (wave 8). warn, so it reaches the PM2 log file.
  const loopMode = toolLoopMode();
  let loopModeMsg: string;
  if (loopMode === 'native') {
    loopModeMsg = '🔧 Tool loop: native tool calls (default). Rollback: TOOL_LOOP=xml + restart.';
  } else {
    loopModeMsg = '🔧 Tool loop: XML (TOOL_LOOP=xml, emergency fallback)';
  }
  logger.warn(loopModeMsg);
  // Native tool turns check the model catalog's supported_parameters; warm it now so the
  // first reply after boot doesn't wait on the fetch.
  if (loopMode === 'native') void openRouterModelsService.fetchLiveModelInfo();

  // Start queue workers first
  console.log('👷 Starting queue workers...');
  const incomingWorker = await startQueueWorkers();

  // Daily spend cap FIRST, before anything that can generate: it lifts a stale budget mute
  // from a previous ET day and trips the mute if today's spend is already over the cap.
  console.log('💸 Starting daily budget watch...');
  startDailyBudgetWatch();

  // Jar earnings (self-meter line only — no-op until ARTIE_TIP_JAR_URL/STRIPE_JAR_READ_KEY/
  // ARTIE_TIP_JAR_PAYMENT_LINK_ID are all set; see JAR-NOTES.md).
  console.log('🫙 Starting jar earnings watch...');
  startJarEarningsWatch();

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

  const server = await listen(PORT, stats);

  return {
    server,
    incomingWorker,
    async stop() {
      // Reverse of start: HTTP server, monitors, scheduler, the INCOMING worker, then the
      // in-process state that flushes on the way out.
      logger.info('Closing the engine HTTP server...');
      await new Promise<void>((resolve) => server.close(() => resolve()));

      logger.info('Stopping distress monitor...');
      distressMonitor.stop();

      logger.info('Stopping simple healer...');
      simpleHealer.stop();

      logger.info('Shutting down scheduler...');
      if (schedulerRetry) {
        clearTimeout(schedulerRetry);
        schedulerRetry = null;
      }
      await schedulerService.close();

      if (incomingWorker) {
        logger.info('Closing the INCOMING_MESSAGES worker...');
        await incomingWorker.close();
      }

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

      logger.info('✅ Engine stopped');
    },
  };
}
