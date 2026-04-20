/**
 * PM2 Ecosystem Config for Coach Artie
 *
 * Production deployment configuration for running Artie natively (not Docker).
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs    # Start all services
 *   pm2 restart all                   # Restart all
 *   pm2 delete all && pm2 start ...   # Full reset
 *   pm2 save                          # Save for auto-restart on reboot
 *
 * Services:
 *   - capabilities (port 47324): Core AI, memory, LLM orchestration
 *   - discord (port 47321): Discord bot + REST API
 *   - brain (port 47325): Nuxt web dashboard
 *   - sms (port 47326): Twilio SMS interface
 *
 * Docker services (separate):
 *   - redis (port 47320): Job queues - docker compose up -d redis
 *   - sandbox (port 47323): Code execution - docker compose up -d sandbox
 *
 * @see DEPLOYMENT.md for full documentation
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
env.CAPABILITIES_URL = 'http://localhost:47324';
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
    // CAPABILITIES SERVICE
    // Core AI processing, memory management, LLM orchestration
    // -------------------------------------------------------------------------
    {
      name: 'coach-artie-capabilities',
      cwd: path.join(__dirname, 'packages/capabilities'),
      script: 'dist/index.js',
      env: {
        ...env,
        DATABASE_PATH,
        ENABLE_STARTUP_NOTIFICATION: 'false',
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      error_file: path.join(LOGS_DIR, 'capabilities-error.log'),
      out_file: path.join(LOGS_DIR, 'capabilities-out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      // Capabilities should start first - other services depend on it
    },

    // -------------------------------------------------------------------------
    // DISCORD SERVICE
    // Discord bot, REST API, GitHub sync, observational learning
    // -------------------------------------------------------------------------
    {
      name: 'coach-artie-discord',
      cwd: path.join(__dirname, 'packages/discord'),
      script: 'dist/index.js',
      env: {
        ...env,
        DATABASE_PATH,
        CAPABILITIES_URL: 'http://localhost:47324',
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      error_file: path.join(LOGS_DIR, 'discord-error.log'),
      out_file: path.join(LOGS_DIR, 'discord-out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      // Wait for capabilities to be ready before starting
      wait_ready: true,
      listen_timeout: 10000,
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

    // -------------------------------------------------------------------------
    // SMS SERVICE
    // Twilio webhook handler for SMS conversations
    // -------------------------------------------------------------------------
    {
      name: 'coach-artie-sms',
      cwd: path.join(__dirname, 'packages/sms'),
      script: 'dist/index.js',
      env: {
        ...env,
        SMS_PORT: 47326,
        CAPABILITIES_URL: 'http://localhost:47324',
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      error_file: path.join(LOGS_DIR, 'sms-error.log'),
      out_file: path.join(LOGS_DIR, 'sms-out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
