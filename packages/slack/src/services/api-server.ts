import express, { Express } from 'express';
import { logger } from '@coachartie/shared';
import { createApiRouter } from '../routes/api.js';
import type { App } from '@slack/bolt';

export class ApiServer {
  private app: Express;
  private server: any;
  private port: number;
  private slackApp: App | null = null;

  constructor(port: number = 47322) {
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

  setSlackApp(app: App): void {
    this.slackApp = app;

    // Set up API routes now that we have the app
    if (this.slackApp) {
      this.app.use('/api', createApiRouter(this.slackApp));
      logger.info('✅ API routes registered with Slack app');
    }
  }

  start(): void {
    if (!this.slackApp) {
      logger.warn('⚠️ API server starting without Slack app - routes may not work');
    }

    this.server = this.app.listen(this.port, () => {
      logger.info(`🌐 Slack API server running on port ${this.port}`);
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
const apiServerPort = parseInt(process.env.SLACK_API_PORT || '47322');
export const apiServer = new ApiServer(apiServerPort);
