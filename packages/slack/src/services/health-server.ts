import { createServer, IncomingMessage, ServerResponse } from 'http';
import { logger } from '@coachartie/shared';
import { telemetry } from './telemetry.js';
import { readFileSync } from 'fs';

export interface HealthCheckResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  service: 'slack-bot';
  version: string;
  uptime: number;
  slack?: {
    connected: boolean;
    workspaces: number;
    users: number;
    workspaceDetails?: Array<{
      id: string;
      name: string;
    }>;
  };
  telemetry?: any;
  issues?: string[];
}

export class HealthServer {
  private server: any;
  private port: number;
  private slackApp: any;

  constructor(port: number = 47320) {
    this.port = port;
  }

  setSlackApp(app: any): void {
    this.slackApp = app;
  }

  start(): void {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Set CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }

      try {
        switch (req.url) {
          case '/health':
          case '/':
            this.handleHealthCheck(res);
            break;
          case '/metrics':
            this.handleMetrics(res);
            break;
          case '/ready':
            this.handleReadiness(res);
            break;
          case '/live':
            this.handleLiveness(res);
            break;
          default:
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not found' }));
        }
      } catch (error) {
        logger.error('Health server error:', error);
        res.writeHead(500);
        res.end(
          JSON.stringify({
            error: 'Internal server error',
            message: error instanceof Error ? error.message : String(error),
          })
        );
      }
    });

    this.server.listen(this.port, () => {
      logger.info(`🩺 Health server running on port ${this.port}`);
    });

    this.server.on('error', (error: Error) => {
      logger.error('Health server error:', error);
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      logger.info('Health server stopped');
    }
  }

  private handleHealthCheck(res: ServerResponse): void {
    const healthSummary = telemetry.getHealthSummary();
    const slackStatus = this.getSlackStatus();

    // Determine overall health based on Slack connection and telemetry
    let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = healthSummary.status;
    const issues = [...healthSummary.issues];

    if (!slackStatus.connected) {
      overallStatus = 'unhealthy';
      issues.push('Slack client not connected');
    }

    const response: HealthCheckResponse = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      service: 'slack-bot',
      version: this.getVersion(),
      uptime: process.uptime(),
      slack: slackStatus,
      telemetry: healthSummary.metrics,
      issues: issues.length > 0 ? issues : undefined,
    };

    const statusCode = overallStatus === 'healthy' ? 200 : overallStatus === 'degraded' ? 200 : 503;

    res.writeHead(statusCode);
    res.end(JSON.stringify(response, null, 2));
  }

  private handleMetrics(res: ServerResponse): void {
    const metrics = telemetry.getMetrics();
    const slackStatus = this.getSlackStatus();

    const response = {
      timestamp: new Date().toISOString(),
      slack: slackStatus,
      metrics: {
        ...metrics,
        uniqueUsers: metrics.uniqueUserCount, // Convert for API response
      },
      events: telemetry.getRecentEvents(20),
    };

    res.writeHead(200);
    res.end(JSON.stringify(response, null, 2));
  }

  private handleReadiness(res: ServerResponse): void {
    const slackConnected = this.slackApp !== null;
    const capabilitiesReachable = true; // TODO: Add actual capabilities service check

    const ready = slackConnected && capabilitiesReachable;
    const issues: string[] = [];

    if (!slackConnected) issues.push('Slack client not ready');
    if (!capabilitiesReachable) issues.push('Capabilities service unreachable');

    const response = {
      ready,
      timestamp: new Date().toISOString(),
      checks: {
        slack: slackConnected,
        capabilities: capabilitiesReachable,
      },
      issues: issues.length > 0 ? issues : undefined,
    };

    res.writeHead(ready ? 200 : 503);
    res.end(JSON.stringify(response, null, 2));
  }

  private handleLiveness(res: ServerResponse): void {
    // Simple liveness check - if we can respond, we're alive
    const response = {
      alive: true,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      pid: process.pid,
    };

    res.writeHead(200);
    res.end(JSON.stringify(response, null, 2));
  }

  private getSlackStatus(): any {
    if (!this.slackApp) {
      return {
        connected: false,
        workspaces: 0,
        users: 0,
      };
    }

    try {
      // Slack app is connected if it exists and started
      const connected = this.slackApp !== null;

      // TODO: Fetch actual workspace info via Slack API
      // For now, return basic status
      return {
        connected,
        workspaces: connected ? 1 : 0, // Single workspace mode by default
        users: 0, // Would need to query Slack API for this
        workspaceDetails: [],
      };
    } catch (error) {
      logger.error('Failed to get Slack status:', error);
      return {
        connected: false,
        workspaces: 0,
        users: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private getVersion(): string {
    try {
      const packageJson = JSON.parse(readFileSync('/app/packages/slack/package.json', 'utf8'));
      return packageJson.version || '1.0.0';
    } catch (error) {
      // Fallback for local development
      try {
        const packageJson = JSON.parse(readFileSync('./package.json', 'utf8'));
        return packageJson.version || '1.0.0';
      } catch (fallbackError) {
        return '1.0.0';
      }
    }
  }
}

// Export singleton instance
export const healthServer = new HealthServer(parseInt(process.env.HEALTH_PORT || '47320'));
