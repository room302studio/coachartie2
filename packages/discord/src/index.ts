import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from monorepo root (go up from packages/discord/src to monorepo root)
config({ path: resolve(__dirname, '../../../.env') });
// Also try package-specific .env
config({ path: resolve(__dirname, '../.env') });
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { logger } from '@coachartie/shared';
import { setupMessageHandler } from './handlers/message-handler.js';
import { startResponseConsumer } from './queues/consumer.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

async function start() {
  try {
    // Setup event handlers
    client.on(Events.ClientReady, () => {
      logger.info(`Discord bot logged in as ${client.user?.tag}`);
    });

    // Setup message handler
    setupMessageHandler(client);

    // Start queue consumer for responses
    await startResponseConsumer(client);

    // Login to Discord
    await client.login(process.env.DISCORD_TOKEN);
  } catch (error) {
    logger.error('Failed to start Discord bot:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down Discord bot');
  client.destroy();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down Discord bot');
  client.destroy();
  process.exit(0);
});

// Start the bot
start();