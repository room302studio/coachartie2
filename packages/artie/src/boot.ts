/**
 * Boot and shutdown for the one Coach Artie process (wave 9): the engine (queue workers,
 * scheduler, monitors, :47324) and the gateway (Discord, :47321, 127.0.0.1:47319) in one Node
 * process. src/main.ts is the entry point; it calls boot() and wires signals to shutdown().
 *
 * Order: env (one load) -> DB -> engine -> gateway -> 'ready'. Shutdown is the reverse:
 * gateway, engine, Redis, DB.
 */
import { config } from 'dotenv';
import {
  getEnvFiles,
  REPO_ROOT,
  getKillSwitch,
  getStrikeMode,
  getDatabasePath,
  getSteamReviewNotes,
  getCasinoLedger,
  LAUNCH_STATE,
  CAPABILITIES_GUILD_NOTES,
  MENTION_PROXY_DATA,
  SKILLS_DIRS,
  getGuildKnowledgeDirs,
  ARTIE_LOGS,
  PM2_LOGS,
  getLogsDir,
  PROMPTS_DIR,
  REFERENCE_DOCS,
} from './shared/paths.js';
import { logger } from './shared/logger.js';
import { getDb, closeDb } from './shared/db/client.js';
import { closeRedisConnection } from './shared/queue/redis.js';
import { startEngine, type EngineHandle } from './engine/main.js';
import { startGateway, type GatewayHandle } from './gateway/main.js';

export interface BootOptions {
  /** Called once when everything is up. Default: process.send?.('ready') (PM2 wait_ready). */
  notifyReady?: () => void;
}

export interface Running {
  engine: EngineHandle;
  gateway: GatewayHandle;
  /** True once notifyReady was called (Discord ready and all three listeners up). */
  ready: boolean;
}

let running: Partial<Running> = {};

/**
 * Load every .env file once (first wins; PM2's env beats them all). Runs in boot(), after
 * every module has been imported, exactly when each process's own config() calls used to run,
 * so module-load-time env reads see what they saw before.
 */
function loadEnv(): string[] {
  console.log('🔑 Loading environment variables...');
  const envFiles = getEnvFiles();
  for (const envFile of envFiles) {
    config({ path: envFile });
  }
  return envFiles;
}

export async function boot(opts: BootOptions = {}): Promise<Running> {
  const notifyReady = opts.notifyReady ?? (() => process.send?.('ready'));

  console.log('🔧 Node version:', process.version);
  console.log('🌍 Environment:', process.env.NODE_ENV);
  const envFiles = loadEnv();

  // Every resolved runtime path, one block, every boot — so a wrong path is visible in the
  // first log line instead of discovered the next time something silently reads a stale file.
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
    ARTIE_LOGS,
    PM2_LOGS,
    LOGS_DIR: getLogsDir(),
    PROMPTS_DIR,
    REFERENCE_DOCS,
  });

  // Open the database now, so a bad DATABASE_PATH fails the boot instead of the first turn.
  getDb();

  const engine = await startEngine();
  running.engine = engine;

  const gateway = await startGateway();
  running.gateway = gateway;

  // PM2 'ready' once: Discord is ready (startGateway resolved) and all three listeners are up
  // (the engine's resolved before startGateway was called).
  let ready = false;
  if (gateway.listening) {
    notifyReady();
    ready = true;
    logger.info('✅ Coach Artie is up: engine :47324, gateway :47321, health :47319');
  } else {
    logger.error('❌ A gateway listener failed to start; not signalling ready');
  }
  running = { engine, gateway, ready };
  return running as Running;
}

/**
 * Close everything boot() opened, in reverse order: the gateway (listeners, watchers, push
 * worker, Discord), the engine (listener, monitors, scheduler, INCOMING worker), Redis, then
 * the database. Safe to call before boot() finished; never exits the process.
 */
export async function shutdown(signal = 'shutdown'): Promise<void> {
  const { engine, gateway } = running;
  running = {};
  try {
    if (gateway) await gateway.stop(signal);
  } catch (error) {
    logger.error('Error stopping the gateway:', error);
  }
  try {
    if (engine) await engine.stop();
  } catch (error) {
    logger.error('Error stopping the engine:', error);
  }
  try {
    await closeRedisConnection();
  } catch (error) {
    logger.error('Error closing Redis:', error);
  }
  try {
    closeDb();
  } catch (error) {
    logger.error('Error closing the database:', error);
  }
  logger.info('✅ Graceful shutdown complete');
}
