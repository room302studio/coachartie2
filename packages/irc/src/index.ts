import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from monorepo root and package-specific
config({ path: resolve(__dirname, '../../../.env') });
config({ path: resolve(__dirname, '../.env') });

import * as irc from 'irc-framework';
import express from 'express';
import helmet from 'helmet';
import {
  logger,
  parsePortWithFallback,
  registerServiceWithDiscovery,
  serviceDiscovery,
} from '@coachartie/shared';
import { setupMessageHandler } from './handlers/incoming-message.js';
import { startResponseConsumer } from './queues/consumer.js';
import { writeFileSync } from 'fs';

// IRC Configuration
const IRC_SERVER = process.env.IRC_SERVER || 'irc.forestpunks.com';
const IRC_PORT = parseInt(process.env.IRC_SERVER_PORT || '6667');
const IRC_NICK = process.env.IRC_NICK || 'coachartie';
const IRC_USERNAME = process.env.IRC_USERNAME || 'artie';
const IRC_REALNAME = process.env.IRC_REALNAME || 'Coach Artie Bot';
const IRC_CHANNELS = process.env.IRC_CHANNELS?.split(',') || ['#test'];
const IRC_USE_TLS = process.env.IRC_USE_TLS === 'true';
const IRC_PASSWORD = process.env.IRC_PASSWORD; // NickServ password (optional)

// Create IRC client
export const ircClient = new irc.Client();

// Health check server
const app = express();
app.use(helmet());
app.use(express.json());

app.get('/health', (req, res) => {
  const isConnected = ircClient.connected;
  const channels =
    ircClient.network?.channels
      ? Array.from(ircClient.network.channels.values()).map((c: any) => c.name)
      : [];

  res.json({
    status: isConnected ? 'ok' : 'disconnected',
    connected: isConnected,
    server: IRC_SERVER,
    nick: ircClient.user?.nick || IRC_NICK,
    channels,
    timestamp: new Date().toISOString(),
  });
});

// Write status file
function writeStatus(status: 'starting' | 'connected' | 'error' | 'shutdown', data?: any) {
  try {
    const channels =
      ircClient.network?.channels
        ? Array.from(ircClient.network.channels.values()).map((c: any) => c.name)
        : [];

    const statusData = {
      status,
      timestamp: new Date().toISOString(),
      pid: process.pid,
      server: IRC_SERVER,
      nick: IRC_NICK,
      channels,
      uptime: process.uptime(),
      ...data,
    };

    const statusFile = resolve(__dirname, '../../../data/irc-status.json');
    writeFileSync(statusFile, JSON.stringify(statusData, null, 2));
  } catch (error) {
    logger.error('Failed to write status file:', error);
  }
}

async function start() {
  try {
    logger.info('Starting IRC bot...');
    writeStatus('starting');

    // Setup IRC client
    ircClient.connect({
      host: IRC_SERVER,
      port: IRC_PORT,
      nick: IRC_NICK,
      username: IRC_USERNAME,
      gecos: IRC_REALNAME,
      tls: IRC_USE_TLS,
      auto_reconnect: true,
      auto_reconnect_wait: 4000,
      auto_reconnect_max_retries: 0, // Infinite retries
    });

    // Handle IRC events
    ircClient.on('registered', () => {
      logger.info(`✅ irc: Connected to ${IRC_SERVER} as ${IRC_NICK}`);

      // Identify with NickServ if password provided
      if (IRC_PASSWORD) {
        ircClient.say('NickServ', `IDENTIFY ${IRC_PASSWORD}`);
        logger.info('Sent NickServ identification');
      }

      // Join channels
      IRC_CHANNELS.forEach((channel) => {
        ircClient.join(channel);
        logger.info(`Joining channel: ${channel}`);
      });

      writeStatus('connected', {
        server: IRC_SERVER,
        nick: IRC_NICK,
      });
    });

    ircClient.on('close', () => {
      logger.warn('IRC connection closed');
      writeStatus('error', { error: 'Connection closed' });
    });

    ircClient.on('socket close', () => {
      logger.warn('IRC socket closed');
    });

    ircClient.on('socket error', (error: Error) => {
      logger.error('IRC socket error:', error);
      writeStatus('error', { error: error.message });
    });

    // Setup message handler
    setupMessageHandler(ircClient);

    // Start queue consumer for responses
    await startResponseConsumer(ircClient);

    // Start health check server
    const PORT = await parsePortWithFallback('IRC_PORT', 'irc');
    app.listen(PORT, '0.0.0.0', async () => {
      logger.info(`✅ irc health: ${PORT}`);
      await registerServiceWithDiscovery('irc', PORT);
    });
  } catch (error) {
    logger.error('Failed to start IRC bot:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    writeStatus('error', { error: errorMessage });
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down IRC bot');
  writeStatus('shutdown');
  ircClient.quit('Shutting down...');
  await serviceDiscovery.shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down IRC bot');
  writeStatus('shutdown');
  ircClient.quit('Shutting down...');
  await serviceDiscovery.shutdown();
  process.exit(0);
});

// Start the bot
start();
