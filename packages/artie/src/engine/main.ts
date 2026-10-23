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

import { logger } from '../shared/logger.js';
import { parsePortWithFallback } from '../shared/config/ports.js';
import { registerServiceWithDiscovery, serviceDiscovery } from './health/service-discovery.js';
import { startMessageConsumer } from './1-intake/queue-worker.js';
// The express app, its middleware and every route (http.ts). main.ts only boots and listens.
import { app } from './http.js';
import { stopCleanupInterval } from './routes/logs.js';
import { schedulerService } from './jobs/scheduler.js';
import { jobTracker } from './1-intake/job-tracker.js';
import { costMonitor } from './budget/usage-ledger.js';
import { distressMonitor } from './health/distress.js';
import { vitalsMonitor } from './health/vitals.js';
import { startDailyBudgetWatch } from './budget/daily-cap.js';
import { GlobalVariableStore } from './5-tool-loop/variables.js';
// Import the turn spine FIRST to trigger capability registration (its orchestrator
// singleton runs the bootstrap at module load). Wave 3 left this path pointing at the
// pre-move services/capability/ tree; tsc doesn't check side-effect-only imports, so it
// would have thrown ERR_MODULE_NOT_FOUND at boot.
import './2-turn/run-turn.js';
import { capabilityRegistry } from './5-tool-loop/registry.js';
import { simpleHealer } from './health/simple-healer.js';
import { hybridDataLayer } from './memory/store.js';

// Export openRouterService for models endpoint
export { openRouterService } from './4-generate/openrouter.js';

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
