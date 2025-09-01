import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from monorepo root (go up from packages/discord/src to monorepo root)
config({ path: resolve(__dirname, '../../../.env') });
// Also try package-specific .env
config({ path: resolve(__dirname, '../.env') });
import { Client, GatewayIntentBits, Events, Partials } from 'discord.js';
import { logger } from '@coachartie/shared';
import { setupMessageHandler } from './handlers/message-handler.js';
import { setupInteractionHandler } from './handlers/interaction-handler.js';
import { startResponseConsumer } from './queues/consumer.js';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { telemetry } from './services/telemetry.js';
import { healthServer } from './services/health-server.js';
import { pathResolver } from './utils/path-resolver.js';
import { jobMonitor } from './services/job-monitor.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildIntegrations,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.User],
});

// Write status to shared file
function writeStatus(status: 'starting' | 'ready' | 'error' | 'shutdown', data?: any) {
  try {
    let guildInfo: Array<{name: string, memberCount: number, channels: number, id: string}> = [];
    let totalChannels = 0;
    let totalMembers = 0;
    
    if (client.guilds && client.isReady()) {
      guildInfo = client.guilds.cache.map(guild => ({
        name: guild.name,
        memberCount: guild.memberCount,
        channels: guild.channels.cache.size,
        id: guild.id
      }));
      
      totalChannels = client.guilds.cache.reduce((total, guild) => total + guild.channels.cache.size, 0);
      totalMembers = client.guilds.cache.reduce((total, guild) => total + (guild.memberCount || 0), 0);
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
      ...data
    };
    
    // Silently write status file using environment-aware path resolution
    const statusFile = pathResolver.getStatusFilePath();
    writeFileSync(statusFile, JSON.stringify(statusData, null, 2));
  } catch (error) {
    logger.error('Failed to write status file:', error);
  }
}

async function start() {
  try {
    writeStatus('starting');

    // Setup event handlers
    client.on(Events.ClientReady, () => {
      logger.info(`✅ discord: ${client.user?.tag} [${client.guilds.cache.size} guilds]`);
      
      // Update telemetry with connection info
      const guildCount = client.guilds.cache.size;
      const channelCount = client.guilds.cache.reduce((total, guild) => total + guild.channels.cache.size, 0);
      telemetry.updateConnectionMetrics(guildCount, channelCount);
      telemetry.logEvent('discord_ready', {
        username: client.user?.tag,
        guilds: guildCount,
        channels: channelCount
      });
      
      // Start health server
      healthServer.setDiscordClient(client);
      healthServer.start();
      
      // Start the persistent job monitor (single wheel for all jobs)
      jobMonitor.startMonitoring();
      
      writeStatus('ready', {
        username: client.user?.tag,
        guilds: client.guilds.cache.size,
        permissions: client.user?.flags?.bitfield || 'none'
      });
    });

    client.on(Events.Error, (error) => {
      logger.error('Discord client error:', error);
      telemetry.incrementApiErrors(error.message);
      telemetry.logEvent('discord_error', { error: error.message }, undefined, undefined, undefined, false);
      writeStatus('error', { error: error.message });
    });

    client.on('reconnecting', () => {
      logger.warn('Discord client reconnecting...');
      telemetry.incrementReconnections();
      telemetry.logEvent('discord_reconnecting');
    });

    // Setup message handler
    setupMessageHandler(client);

    // Setup interaction handler for slash commands
    setupInteractionHandler(client);

    // Start queue consumer for responses
    await startResponseConsumer(client);

    // Login to Discord
    await client.login(process.env.DISCORD_TOKEN);

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
  jobMonitor.stopMonitoring();
  client.destroy();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down Discord bot');
  telemetry.logEvent('shutdown', { signal: 'SIGINT' });
  telemetry.persistMetrics();
  writeStatus('shutdown');
  healthServer.stop();
  jobMonitor.stopMonitoring();
  client.destroy();
  process.exit(0);
});

// Start the bot
start();