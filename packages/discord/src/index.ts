console.log('🚀 DISCORD SERVICE STARTING UP - BOOKITY BOOKITY!');
console.log('📍 Current directory:', process.cwd());
console.log('🔧 Node version:', process.version);
console.log('🌍 Environment:', process.env.NODE_ENV);

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

console.log('📁 __dirname:', __dirname);
console.log('🔑 Loading environment variables...');

// Load .env from monorepo root (go up from packages/discord/src to monorepo root)
config({ path: resolve(__dirname, '../../../.env') });
// Also try package-specific .env
config({ path: resolve(__dirname, '../.env') });

console.log('🔌 Environment check:');
console.log('  - DISCORD_TOKEN:', process.env.DISCORD_TOKEN ? '✅ Set' : '❌ Missing');
console.log('  - REDIS_HOST:', process.env.REDIS_HOST || 'not set');
console.log('  - REDIS_PORT:', process.env.REDIS_PORT || 'not set');
console.log('  - CAPABILITIES_URL:', process.env.CAPABILITIES_URL || 'not set');
console.log('  - DISCORD_PORT:', process.env.DISCORD_PORT || 'not set');

import { Client, GatewayIntentBits, Events, Partials } from 'discord.js';
import { logger } from '@coachartie/shared';
import { setupMessageHandler } from './handlers/message-handler.js';
import { setupInteractionHandler } from './handlers/interaction-handler.js';
import { setupReactionHandler } from './handlers/reaction-handler.js';
import { startResponseConsumer } from './queues/consumer.js';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { telemetry } from './services/telemetry.js';
import { healthServer } from './services/health-server.js';
import { apiServer } from './services/api-server.js';
import { pathResolver } from './utils/path-resolver.js';
import { jobMonitor } from './services/job-monitor.js';
import { initializeForumTraversal } from './services/forum-traversal.js';
import { initializeGitHubIntegration } from './services/github-integration.js';
import { initializeMentionProxyService } from './services/mention-proxy-service.js';
import { initializeGitHubSync } from './services/github-sync.js';
import { observationalLearning } from './services/observational-learning.js';
import './queues/outgoing-consumer.js';

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildIntegrations,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.User, Partials.Reaction],
});

// DEBUG: Raw message listener to verify events are coming through
client.on(Events.MessageCreate, (msg) => {
  console.log(
    `🔔 RAW MESSAGE: ${msg.author.tag} in ${msg.guild?.name || 'DM'}: "${msg.content.slice(0, 50)}..."`
  );
});

// Write status to shared file
function writeStatus(status: 'starting' | 'ready' | 'error' | 'shutdown', data?: any) {
  try {
    let guildInfo: Array<{ name: string; memberCount: number; channels: number; id: string }> = [];
    let totalChannels = 0;
    let totalMembers = 0;

    if (client.guilds && client.isReady()) {
      guildInfo = client.guilds.cache.map((guild) => ({
        name: guild.name,
        memberCount: guild.memberCount,
        channels: guild.channels.cache.size,
        id: guild.id,
      }));

      totalChannels = client.guilds.cache.reduce(
        (total, guild) => total + guild.channels.cache.size,
        0
      );
      totalMembers = client.guilds.cache.reduce(
        (total, guild) => total + (guild.memberCount || 0),
        0
      );
    }

    const statusData = {
      status,
      timestamp: new Date().toISOString(),
      pid: process.pid,
      guilds: client.guilds?.cache.size || 0,
      guildDetails: guildInfo,
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
    // Setup event handlers
    client.on(Events.ClientReady, () => {
      console.log('✨ CLIENT READY EVENT FIRED - FLUCKED AND BUCKED!');
      logger.info(`✅ discord: ${client.user?.tag} [${client.guilds.cache.size} guilds]`);

      // Update telemetry with connection info
      const guildCount = client.guilds.cache.size;
      const channelCount = client.guilds.cache.reduce(
        (total, guild) => total + guild.channels.cache.size,
        0
      );
      telemetry.updateConnectionMetrics(guildCount, channelCount);
      telemetry.logEvent('discord_ready', {
        username: client.user?.tag,
        guilds: guildCount,
        channels: channelCount,
      });

      // Start health server
      healthServer.setDiscordClient(client);
      healthServer.start();

      // Start API server for forum access
      apiServer.setDiscordClient(client);
      apiServer.start();

      // Start the persistent job monitor (single wheel for all jobs)
      jobMonitor.startMonitoring();

      // Initialize forum traversal service
      try {
        console.log('🔧 Initializing forum traversal...');
        initializeForumTraversal(client);
        logger.info('✅ Forum traversal service enabled');
      } catch (error) {
        logger.warn('Failed to initialize forum traversal:', error);
        console.error('❌ Forum traversal init failed:', error);
      }

      // Initialize mention proxy service
      try {
        console.log('🔧 Initializing mention proxy service...');
        initializeMentionProxyService();
        logger.info('✅ Mention proxy service enabled');
      } catch (error) {
        logger.warn('Failed to initialize mention proxy service:', error);
        console.error('❌ Mention proxy service init failed:', error);
      }

      // Initialize GitHub integration (if token provided)
      try {
        console.log('🔧 Checking GitHub integration...');
        if (process.env.GITHUB_TOKEN) {
          initializeGitHubIntegration();
          logger.info('✅ GitHub integration enabled');
          console.log('✅ GitHub integration enabled');
        } else {
          logger.info('ℹ️  GitHub integration disabled (no GITHUB_TOKEN)');
          console.log('ℹ️  GitHub integration disabled (no GITHUB_TOKEN)');
        }
      } catch (error) {
        logger.warn('Failed to initialize GitHub integration:', error);
        console.error('❌ GitHub integration init failed:', error);
      }

      // Initialize GitHub Sync service (PR/CI notifications)
      try {
        console.log('🔧 Checking GitHub Sync service...');
        if (process.env.GITHUB_TOKEN) {
          initializeGitHubSync(client).then(() => {
            logger.info('✅ GitHub Sync service enabled');
            console.log('✅ GitHub Sync service enabled');
          }).catch((err) => {
            logger.warn('GitHub Sync initialization failed:', err);
            console.error('❌ GitHub Sync init failed:', err);
          });
        } else {
          logger.info('ℹ️  GitHub Sync disabled (no GITHUB_TOKEN)');
          console.log('ℹ️  GitHub Sync disabled (no GITHUB_TOKEN)');
        }
      } catch (error) {
        logger.warn('Failed to initialize GitHub Sync:', error);
        console.error('❌ GitHub Sync init failed:', error);
      }

      // Initialize observational learning
      try {
        console.log('🔧 Initializing observational learning...');
        observationalLearning.initialize(client);
        logger.info('✅ Observational learning enabled');
        console.log('✅ Observational learning enabled');
      } catch (error) {
        logger.warn('Failed to initialize observational learning:', error);
        console.error('❌ Observational learning init failed:', error);
      }

      writeStatus('ready', {
        username: client.user?.tag,
        guilds: client.guilds.cache.size,
        permissions: client.user?.flags?.bitfield || 'none',
      });
    });

    client.on(Events.Error, (error) => {
      logger.error('Discord client error:', error);
      telemetry.incrementApiErrors(error.message);
      telemetry.logEvent(
        'discord_error',
        { error: error.message },
        undefined,
        undefined,
        undefined,
        false
      );
      writeStatus('error', { error: error.message });
    });

    client.on('reconnecting', () => {
      logger.warn('Discord client reconnecting...');
      telemetry.incrementReconnections();
      telemetry.logEvent('discord_reconnecting');
    });

    // Setup message handler
    console.log('📬 Setting up message handler...');
    setupMessageHandler(client);

    // Setup interaction handler for slash commands
    console.log('🎯 Setting up interaction handler...');
    setupInteractionHandler(client);

    // Setup reaction handler for two-way reactions
    console.log('⚡ Setting up reaction handler...');
    setupReactionHandler(client);

    // Start queue consumer for responses
    console.log('🚀 Starting queue consumer...');
    await startResponseConsumer(client);

    // Login to Discord
    console.log('🔐 Attempting Discord login...');
    console.log('   Token exists:', !!process.env.DISCORD_TOKEN);
    console.log('   Token length:', process.env.DISCORD_TOKEN?.length);
    await client.login(process.env.DISCORD_TOKEN);
    console.log('✅ Discord login successful!');

    // Status updates disabled - only update on actual state changes
    // This reduces log spam and Clickhouse costs
  } catch (error) {
    logger.error('Failed to start Discord bot:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    writeStatus('error', { error: errorMessage });
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down Discord bot');
  telemetry.logEvent('shutdown', { signal: 'SIGTERM' });
  telemetry.persistMetrics();
  writeStatus('shutdown');
  healthServer.stop();
  apiServer.stop();
  jobMonitor.stopMonitoring();
  observationalLearning.shutdown();
  client.destroy();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down Discord bot');
  telemetry.logEvent('shutdown', { signal: 'SIGINT' });
  telemetry.persistMetrics();
  writeStatus('shutdown');
  healthServer.stop();
  apiServer.stop();
  jobMonitor.stopMonitoring();
  observationalLearning.shutdown();
  client.destroy();
  process.exit(0);
});

// Start the bot
console.log('🏁 CALLING START FUNCTION - JUCKS ARE SNUCKED!');
start().catch((err) => {
  console.error('💥 START FUNCTION FAILED - SHUCKS ARE JUCKED!', err);
  process.exit(1);
});
console.log('🎸 Start function call completed (async)');
