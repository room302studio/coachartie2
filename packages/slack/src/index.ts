console.log('🚀 SLACK SERVICE STARTING UP - BOOKITY BOOKITY!');
console.log('📍 Current directory:', process.cwd());
console.log('🔧 Node version:', process.version);
console.log('🌍 Environment:', process.env.NODE_ENV);

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

console.log('📁 __dirname:', __dirname);
console.log('🔑 Loading environment variables...');

// Load .env from monorepo root (go up from packages/slack/src to monorepo root)
config({ path: resolve(__dirname, '../../../.env') });
// Also try package-specific .env
config({ path: resolve(__dirname, '../.env') });

console.log('🔌 Environment check:');
console.log('  - SLACK_BOT_TOKEN:', process.env.SLACK_BOT_TOKEN ? '✅ Set' : '❌ Missing');
console.log(
  '  - SLACK_SIGNING_SECRET:',
  process.env.SLACK_SIGNING_SECRET ? '✅ Set' : '❌ Missing'
);
console.log('  - REDIS_HOST:', process.env.REDIS_HOST || 'not set');
console.log('  - REDIS_PORT:', process.env.REDIS_PORT || 'not set');
console.log('  - CAPABILITIES_URL:', process.env.CAPABILITIES_URL || 'not set');
console.log('  - SLACK_PORT:', process.env.SLACK_PORT || 'not set');

import pkg from '@slack/bolt';
const { App, LogLevel } = pkg;
import { logger } from '@coachartie/shared';
import { setupMessageHandler } from './handlers/message-handler.js';
import { setupInteractionHandler } from './handlers/interaction-handler.js';
import { startResponseConsumer } from './queues/consumer.js';
import { writeFileSync } from 'fs';
import { telemetry } from './services/telemetry.js';
import { healthServer } from './services/health-server.js';
import { apiServer } from './services/api-server.js';
import { pathResolver } from './utils/path-resolver.js';
import { jobMonitor } from './services/job-monitor.js';
import { initializeConversationState } from './services/conversation-state.js';
import './queues/outgoing-consumer.js';

// Check for required environment variables before initializing the app
if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_SIGNING_SECRET) {
  console.log('⚠️  Slack service disabled: Missing SLACK_BOT_TOKEN or SLACK_SIGNING_SECRET');
  console.log('   Set these environment variables to enable the Slack service.');
  process.exit(0);
}

export const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false, // Use HTTP mode by default
  logLevel: process.env.NODE_ENV === 'development' ? LogLevel.DEBUG : LogLevel.INFO,
  port: parseInt(process.env.SLACK_PORT || '3000'),
});

// Write status to shared file
function writeStatus(status: 'starting' | 'ready' | 'error' | 'shutdown', data?: any) {
  try {
    let workspaceInfo: Array<{ name: string; id: string }> = [];
    let totalChannels = 0;
    let totalMembers = 0;

    // TODO: Fetch workspace info when app is ready
    // Slack's API requires explicit calls to get this info

    const statusData = {
      status,
      timestamp: new Date().toISOString(),
      pid: process.pid,
      workspaces: workspaceInfo.length,
      workspaceDetails: workspaceInfo,
      totalChannels,
      totalMembers,
      uptime: process.uptime(),
      ...data,
    };

    // Silently write status file using environment-aware path resolution
    const statusFile = pathResolver.getStatusFilePath();
    writeFileSync(statusFile, JSON.stringify(statusData, null, 2));
  } catch (error) {
    logger.error('Failed to write status file:', error);
  }
}

async function start() {
  console.log('🎯 Start function called - SNOOKITY LOOKITY!');
  try {
    console.log('📝 Writing starting status...');
    writeStatus('starting');

    console.log('🎮 Setting up event handlers...');

    // Setup message handler
    console.log('📬 Setting up message handler...');
    setupMessageHandler(app);

    // Setup interaction handler for buttons, modals, etc.
    console.log('🎯 Setting up interaction handler...');
    setupInteractionHandler(app);

    // Start queue consumer for responses
    console.log('🚀 Starting queue consumer...');
    await startResponseConsumer(app);

    // Start the Slack app
    console.log('🔐 Starting Slack app...');
    await app.start();
    console.log('✅ Slack app started successfully!');

    logger.info(`✅ slack: Bot connected on port ${process.env.SLACK_PORT || 3000}`);

    // Update telemetry
    telemetry.logEvent('slack_ready', {
      port: process.env.SLACK_PORT || 3000,
    });

    // Start health server
    healthServer.setSlackApp(app);
    healthServer.start();

    // Start API server
    apiServer.setSlackApp(app);
    apiServer.start();

    // Start the persistent job monitor (single wheel for all jobs)
    jobMonitor.startMonitoring();

    // Initialize conversation state manager
    try {
      console.log('🔧 Initializing conversation state...');
      initializeConversationState();
      logger.info('✅ Conversation state tracking enabled');
    } catch (error) {
      logger.warn('Failed to initialize conversation state:', error);
      console.error('❌ Conversation state init failed:', error);
    }

    writeStatus('ready', {
      port: process.env.SLACK_PORT || 3000,
    });
  } catch (error) {
    logger.error('Failed to start Slack bot:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    writeStatus('error', { error: errorMessage });
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down Slack bot');
  telemetry.logEvent('shutdown', { signal: 'SIGTERM' });
  telemetry.persistMetrics();
  writeStatus('shutdown');
  healthServer.stop();
  apiServer.stop();
  jobMonitor.stopMonitoring();
  await app.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down Slack bot');
  telemetry.logEvent('shutdown', { signal: 'SIGINT' });
  telemetry.persistMetrics();
  writeStatus('shutdown');
  healthServer.stop();
  apiServer.stop();
  jobMonitor.stopMonitoring();
  await app.stop();
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('💥 Uncaught Exception:', error);
  telemetry.logEvent('error', { type: 'uncaughtException', message: error.message });
  process.exit(1);
});

process.on('unhandledRejection', (reason, _promise) => {
  logger.error('💥 Unhandled Rejection:', reason);
  telemetry.logEvent('error', { type: 'unhandledRejection', reason: String(reason) });
});

// Start the bot
console.log('🏁 CALLING START FUNCTION - JUCKS ARE SNUCKED!');
start().catch((err) => {
  console.error('💥 START FUNCTION FAILED - SHUCKS ARE JUCKED!', err);
  process.exit(1);
});
console.log('🎸 Start function call completed (async)');
