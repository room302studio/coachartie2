import express, { Express } from 'express';
import { logger } from '../shared/logger.js';
import { createApiRouter } from './routes/discord-actions.js';
import { setupModerationApi } from './routes/moderation.js';
import { requireApiToken } from '../shared/require-api-token.js';
import { mountLegalPages } from './routes/legal-pages.js';
import { Client } from 'discord.js';

interface GatewayAppDeps {
  /** The live Discord client. Without one the app serves only the legal pages (as before login). */
  client: Client | null;
}

/**
 * The gateway's express app (:47321), built by a factory (wave 9) so
 * tests/http-contracts.test.ts can mount it with a stub Discord client on port 0.
 * Middleware order is the old ApiServer's: json, CORS, the public legal pages, the token gate,
 * then (only with a client) /api and the moderation routes.
 */
export function createGatewayApp(deps: GatewayAppDeps): Express {
  const app = express();

  // Middleware. 12mb: base64-encoded voice notes ride through /channels/:id/messages
  // and /dm (a ~60s ElevenLabs mp3 is ~1MB raw → ~1.3MB encoded; Discord's own
  // upload cap for bots is 10MB, so match that with encoding overhead).
  app.use(express.json({ limit: '12mb' }));

  // CORS
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });

  // Public legal pages (Discord app verification links to them). Must come before the gate.
  mountLegalPages(app);

  // Every route needs the token unless called directly from this box (see middleware).
  app.use(requireApiToken());

  // Set up API routes now that we have the client
  if (deps.client) {
    app.use('/api', createApiRouter(deps.client));
    setupModerationApi(app, deps.client);
    logger.info('✅ API routes registered with Discord client');
  }

  return app;
}

class ApiServer {
  private server: any;
  private port: number;
  private discordClient: Client | null = null;

  constructor(port: number = 47321) {
    this.port = port;
  }

  setDiscordClient(client: Client): void {
    this.discordClient = client;
  }

  /** Listen on 0.0.0.0; resolves once listening, rejects (after logging) on a listen error. */
  start(): Promise<void> {
    if (!this.discordClient) {
      logger.warn('⚠️ API server starting without Discord client - routes may not work');
    }

    const app = createGatewayApp({ client: this.discordClient });
    return new Promise((resolve, reject) => {
      this.server = app.listen(this.port, '0.0.0.0', () => {
        logger.info(`🌐 Discord API server running on 0.0.0.0:${this.server.address()?.port ?? this.port}`);
        resolve();
      });

      this.server.on('error', (error: Error) => {
        logger.error('API server error:', error);
        reject(error);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
      logger.info('API server stopped');
    });
  }
}

// Export singleton instance
const apiServerPort = parseInt(process.env.DISCORD_API_PORT || '47321');
export const apiServer = new ApiServer(apiServerPort);
