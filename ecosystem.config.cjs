// PM2 Ecosystem Config for Coach Artie
// Run with: pm2 start ecosystem.config.cjs

const path = require('path');
const fs = require('fs');

// Load env from .env.production
const envPath = path.join(__dirname, '.env.production');
const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (match) {
    // Remove comments and trim
    let value = match[2].split('#')[0].trim();
    // Remove quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
});

// Override for non-Docker environment
env.REDIS_HOST = 'localhost';
env.CAPABILITIES_URL = 'http://localhost:47324';
env.NODE_ENV = 'production';

module.exports = {
  apps: [
    {
      name: 'coach-artie-capabilities',
      cwd: path.join(__dirname, 'packages/capabilities'),
      script: 'dist/index.js',
      env: {
        ...env,
        DATABASE_PATH: path.join(__dirname, 'data/coachartie.db'),
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      error_file: path.join(__dirname, 'logs/capabilities-error.log'),
      out_file: path.join(__dirname, 'logs/capabilities-out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
    {
      name: 'coach-artie-discord',
      cwd: path.join(__dirname, 'packages/discord'),
      script: 'dist/index.js',
      env: {
        ...env,
        CAPABILITIES_URL: 'http://localhost:47324',
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      error_file: path.join(__dirname, 'logs/discord-error.log'),
      out_file: path.join(__dirname, 'logs/discord-out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      // Wait for capabilities to start first
      wait_ready: true,
      listen_timeout: 10000,
    },
    {
      name: 'coach-artie-brain',
      cwd: path.join(__dirname, 'packages/brain'),
      script: '.output/server/index.mjs',
      env: {
        ...env,
        HOST: '0.0.0.0',
        PORT: 47325,
        NITRO_PORT: 47325,
        DATABASE_PATH: path.join(__dirname, 'data/coachartie.db'),
        CAPABILITIES_URL: 'http://localhost:47324',
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      error_file: path.join(__dirname, 'logs/brain-error.log'),
      out_file: path.join(__dirname, 'logs/brain-out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
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
      error_file: path.join(__dirname, 'logs/sms-error.log'),
      out_file: path.join(__dirname, 'logs/sms-out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
