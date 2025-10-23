import express, { Express } from 'express';
import { logger } from '@coachartie/shared';
import { createApiRouter } from '../routes/api.js';
import { Client } from 'discord.js';

export class ApiServer {
  private app: Express;
  private server: any;
  private port: number;
  private discordClient: Client | null = null;

  constructor(port: number = 47321) {
    this.port = port;
    this.app = express();

    // Middleware
    this.app.use(express.json());

    // CORS
    this.app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      next();
    });
  }

  setDiscordClient(client: Client): void {
    this.discordClient = client;

    // Set up API routes now that we have the client
    if (this.discordClient) {
      this.app.use('/api', createApiRouter(this.discordClient));
      logger.info('✅ API routes registered with Discord client');
    }
  }

  start(): void {
    if (!this.discordClient) {
      logger.warn('⚠️ API server starting without Discord client - routes may not work');
    }

    this.server = this.app.listen(this.port, () => {
      logger.info(`🌐 Discord API server running on port ${this.port}`);
    });

    this.server.on('error', (error: Error) => {
      logger.error('API server error:', error);
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      logger.info('API server stopped');
    }
  }
}

// Export singleton instance
const apiServerPort = parseInt(process.env.DISCORD_API_PORT || '47321');
export const apiServer = new ApiServer(apiServerPort);
