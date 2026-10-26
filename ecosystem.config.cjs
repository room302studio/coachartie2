/**
 * PM2 Ecosystem Config for Coach Artie
 *
 * Production deployment configuration for running Artie natively (not Docker).
 *
 * Wave 9 collapsed the engine (capabilities) and gateway (Discord) into one Node
 * process; wave 12 collapses them into one PM2 app to match: `coach-artie`, running
 * `packages/artie/dist/main.js`. It serves both HTTP APIs (engine :47324, gateway
 * :47321/:47319) out of the same process. See ARCHITECTURE.md and CUTOVER.md — this
 * file describes the NEW target state; the cutover itself (deleting the two old PM2
 * apps and starting this one) is written, not run, in CUTOVER.md.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs --only coach-artie   # start the bot (post-cutover)
 *   pm2 restart coach-artie                              # restart
 *   pm2 save                                             # persist for auto-restart on reboot
 *
 * Apps:
 *   - coach-artie (ports 47321 + 47324, health 47319): engine + gateway, one process
 *   - brain (port 47325): Nuxt web dashboard
 *
 * Docker services (separate):
 *   - redis (port 47320): Job queues - docker compose up -d redis
 *   - sandbox (port 47323): Code execution - docker compose up -d sandbox
 *
 * @see ARCHITECTURE.md for the package layout and @see CUTOVER.md for the migration steps.
 */

const path = require('path');
const fs = require('fs');

// =============================================================================
// ENVIRONMENT LOADING
// =============================================================================

// Load environment variables from .env.production
const envPath = path.join(__dirname, '.env.production');
const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};

envContent.split('\n').forEach(line => {
  // Match KEY=value, handling quotes and inline comments
  const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (match) {
    let value = match[2].split('#')[0].trim(); // Remove inline comments
    // Remove surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
});

// =============================================================================
// NATIVE DEPLOYMENT OVERRIDES
// =============================================================================

// Override Docker-specific settings for native deployment
env.REDIS_HOST = 'localhost';           // Redis runs in Docker, accessible via localhost
env.NODE_ENV = 'production';

// Shared paths
const DATA_DIR = path.join(__dirname, 'data');
const LOGS_DIR = path.join(__dirname, 'logs');
const DATABASE_PATH = path.join(DATA_DIR, 'coachartie.db');

// =============================================================================
// PM2 APPLICATIONS
// =============================================================================

module.exports = {
  apps: [
    // -------------------------------------------------------------------------
    // COACH-ARTIE: engine (capabilities) + gateway (Discord) in one process
    // (wave 9). Serves :47321, :47324, health on :47319.
    // -------------------------------------------------------------------------
    {
      name: 'coach-artie',
      cwd: path.join(__dirname, 'packages/artie'),
      script: 'dist/main.js',
      // A dependency still requires the deprecated punycode builtin; the warning is noise.
      node_args: '--disable-warning=DEP0040',
      env: {
        ...env,
        DATABASE_PATH,
        // Winston logs carry message content. On prod <repo>/logs is a symlink onto the LUKS
        // mount (/srv/artie/logs), so writing under it keeps them encrypted at rest. The
        // pre-v3 packages/*/logs dirs were plain disk.
        LOGS_DIR: path.join(LOGS_DIR, 'app'),
        ENABLE_STARTUP_NOTIFICATION: 'false',
        // CAPABILITIES_URL dropped: the engine and gateway are the same process now,
        // so there is no internal HTTP hop left for the bot to point at itself.
        // `brain` (below) still reaches the engine over HTTP and keeps its own
        // CAPABILITIES_URL for that.
      },
      instances: 1,
      autorestart: true,
      watch: false,
      // 1G (old capabilities) + 512M (old discord) = 1536M for the one process.
      max_memory_restart: '1536M',
      // Named coach-artie-{out,error}, not artie-{out,error}: vitals.ts's LOG_PREFIXES
      // (engine/health/vitals.ts, wired in wave 9) hardcodes 'coach-artie-out' as the
      // new-process prefix it reads. Matching the reader beats the literal wording here
      // (logged in BUILD-LOG wave 12 — a log-reader contract is an invariant).
      error_file: path.join(LOGS_DIR, 'coach-artie-error.log'),
      out_file: path.join(LOGS_DIR, 'coach-artie-out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      // main.ts sends process.send('ready') once the engine listener and both gateway
      // listeners (health + Discord login) are up. listen_timeout covers engine boot
      // (queue workers, scheduler, monitors) plus Discord login, not just one HTTP bind.
      wait_ready: true,
      listen_timeout: 30000,
      // Must exceed main.ts's 10s graceful-shutdown deadline, or PM2 SIGKILLs before
      // shutdown() finishes closing the gateway/engine/DB/Redis in order.
      kill_timeout: 12000,
    },

    // -------------------------------------------------------------------------
    // BRAIN SERVICE
    // Nuxt.js web dashboard for monitoring and configuration
    // -------------------------------------------------------------------------
    {
      name: 'coach-artie-brain',
      cwd: path.join(__dirname, 'packages/brain'),
      script: '.output/server/index.mjs',
      env: {
        ...env,
        HOST: '127.0.0.1',
        PORT: 47325,
        NITRO_PORT: 47325,
        DATABASE_PATH,
        CAPABILITIES_URL: 'http://localhost:47324',
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      error_file: path.join(LOGS_DIR, 'brain-error.log'),
      out_file: path.join(LOGS_DIR, 'brain-out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },

  ],
};
