/**
 * Coach Artie's one entry point (wave 9): the engine and the Discord gateway in one Node
 * process, one PM2 app. boot.ts does the work; this file only starts it and owns the
 * process-level handlers, once for the whole bot.
 *
 *   dev:  pnpm --filter @coachartie/artie dev   (tsx watch src/main.ts)
 *   prod: node packages/artie/dist/main.js     (PM2 app coach-artie, wave 12)
 */
import { boot, shutdown } from './boot.js';
import { logger } from './shared/logger.js';
import { telemetry } from './gateway/telemetry.js';

console.log('🚀 COACH ARTIE STARTING (engine + gateway, one process)');

// One SIGINT/SIGTERM handler for the whole process. A second signal while shutting down,
// or a shutdown that hangs past the deadline, exits anyway.
const SHUTDOWN_DEADLINE_MS = 10_000;
let shuttingDown = false;
async function onSignal(signal: string) {
  if (shuttingDown) {
    logger.warn(`${signal} again during shutdown; exiting now`);
    process.exit(0);
  }
  shuttingDown = true;
  logger.info(`🛑 ${signal}: graceful shutdown initiated...`);
  const deadline = setTimeout(() => {
    logger.warn(`Shutdown took over ${SHUTDOWN_DEADLINE_MS}ms; exiting`);
    process.exit(0);
  }, SHUTDOWN_DEADLINE_MS);
  deadline.unref();
  await shutdown(signal);
  process.exit(0);
}
process.on('SIGTERM', () => void onSignal('SIGTERM'));
process.on('SIGINT', () => void onSignal('SIGINT'));

// Crash policy for the one process: log and keep running, the engine's old policy. The
// gateway used to exit(1) on an uncaught exception, which only restarted the Discord side;
// exiting here would take the engine (and every in-flight turn) down with it. PM2 still
// restarts on a real crash, and max_memory_restart (wave 12) bounds a slow leak.
process.on('uncaughtException', (error) => {
  logger.error('💥 Uncaught Exception:', error);
  telemetry.logEvent('error', { type: 'uncaughtException', message: error.message });
});
process.on('unhandledRejection', (reason) => {
  logger.error('💥 Unhandled Rejection:', reason);
  telemetry.logEvent('error', { type: 'unhandledRejection', reason: String(reason) });
});

boot().catch((error) => {
  logger.error('💥 Coach Artie failed to start:', error);
  console.error('💥 START FUNCTION FAILED - SHUCKS ARE JUCKED!', error);
  process.exit(1);
});
