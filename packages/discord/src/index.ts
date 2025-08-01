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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.User],
});

// Status file path - write to host directory that brain can read
const STATUS_FILE = '/Users/ejfox/code/coachartie2/packages/capabilities/data/discord-status.json';

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
    
    logger.info(`Writing status to ${STATUS_FILE}:`, { status, guilds: statusData.guilds });
    writeFileSync(STATUS_FILE, JSON.stringify(statusData, null, 2));
    logger.info('Status file written successfully');
  } catch (error) {
    logger.error('Failed to write status file:', error);
  }
}

async function start() {
  try {
    writeStatus('starting');

    // Setup event handlers
    client.on(Events.ClientReady, () => {
      logger.info(`Discord bot logged in as ${client.user?.tag}`);
      logger.info(`Bot can see ${client.guilds.cache.size} guilds`);
      logger.info(`Bot permissions: ${client.user?.flags?.bitfield || 'none'}`);
      
      writeStatus('ready', {
        username: client.user?.tag,
        guilds: client.guilds.cache.size,
        permissions: client.user?.flags?.bitfield || 'none'
      });
    });

    client.on(Events.Error, (error) => {
      logger.error('Discord client error:', error);
      writeStatus('error', { error: error.message });
    });

    // Setup message handler
    setupMessageHandler(client);

    // Setup interaction handler for slash commands
    setupInteractionHandler(client);

    // Start queue consumer for responses
    await startResponseConsumer(client);

    // Login to Discord
    await client.login(process.env.DISCORD_TOKEN);

    // Update status every 30 seconds
    setInterval(() => {
      if (client.isReady()) {
        writeStatus('ready', {
          username: client.user?.tag,
          guilds: client.guilds.cache.size,
          permissions: client.user?.flags?.bitfield || 'none'
        });
      }
    }, 30000);

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
  writeStatus('shutdown');
  client.destroy();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down Discord bot');
  writeStatus('shutdown');
  client.destroy();
  process.exit(0);
});

// Start the bot
start();