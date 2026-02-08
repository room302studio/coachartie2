import { createServer, IncomingMessage, ServerResponse } from 'http';
import { logger } from '@coachartie/shared';
import { telemetry } from './telemetry.js';
import { readFileSync } from 'fs';

export interface HealthCheckResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  service: 'discord-bot';
  version: string;
  uptime: number;
  discord?: {
    connected: boolean;
    guilds: number;
    users: number;
    latency?: number;
    guildDetails?: Array<{
      id: string;
      name: string;
      memberCount: number;
      channels: number;
    }>;
  };
  telemetry?: any;
  issues?: string[];
}

export class HealthServer {
  private server: any;
  private port: number;
  private discordClient: any;
  private capabilitiesHealthCache: { reachable: boolean; checkedAt: number } = {
    reachable: false,
    checkedAt: 0,
  };
  private readonly CAPABILITIES_CACHE_TTL_MS = 30000; // 30 seconds

  constructor(port: number = 47319) {
    this.port = port;
  }

  private async checkCapabilitiesHealth(): Promise<boolean> {
    const now = Date.now();
    if (now - this.capabilitiesHealthCache.checkedAt < this.CAPABILITIES_CACHE_TTL_MS) {
      return this.capabilitiesHealthCache.reachable;
    }

    const capabilitiesUrl = process.env.CAPABILITIES_URL || 'http://localhost:47324';
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(`${capabilitiesUrl}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      this.capabilitiesHealthCache = { reachable: response.ok, checkedAt: now };
      return response.ok;
    } catch {
      this.capabilitiesHealthCache = { reachable: false, checkedAt: now };
      return false;
    }
  }

  setDiscordClient(client: any): void {
    this.discordClient = client;
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
            void this.handleReadiness(res);
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
    const discordStatus = this.getDiscordStatus();

    // Determine overall health based on Discord connection and telemetry
    let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = healthSummary.status;
    const issues = [...healthSummary.issues];

    if (!discordStatus.connected) {
      overallStatus = 'unhealthy';
      issues.push('Discord client not connected');
    }

    const response: HealthCheckResponse = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      service: 'discord-bot',
      version: this.getVersion(),
      uptime: process.uptime(),
      discord: discordStatus,
      telemetry: healthSummary.metrics,
      issues: issues.length > 0 ? issues : undefined,
    };

    const statusCode = overallStatus === 'healthy' ? 200 : overallStatus === 'degraded' ? 200 : 503;

    res.writeHead(statusCode);
    res.end(JSON.stringify(response, null, 2));
  }

  private handleMetrics(res: ServerResponse): void {
    const metrics = telemetry.getMetrics();
    const discordStatus = this.getDiscordStatus();

    const response = {
      timestamp: new Date().toISOString(),
      discord: discordStatus,
      metrics: {
        ...metrics,
        uniqueUsers: metrics.uniqueUserCount, // Convert for API response
      },
      events: telemetry.getRecentEvents(20),
    };

    res.writeHead(200);
    res.end(JSON.stringify(response, null, 2));
  }

  private async handleReadiness(res: ServerResponse): Promise<void> {
    const discordConnected = this.discordClient?.isReady() || false;
    const capabilitiesReachable = await this.checkCapabilitiesHealth();

    const ready = discordConnected && capabilitiesReachable;
    const issues: string[] = [];

    if (!discordConnected) issues.push('Discord client not ready');
    if (!capabilitiesReachable) issues.push('Capabilities service unreachable');

    const response = {
      ready,
      timestamp: new Date().toISOString(),
      checks: {
        discord: discordConnected,
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

  private getDiscordStatus(): any {
    if (!this.discordClient) {
      return {
        connected: false,
        guilds: 0,
        users: 0,
      };
    }

    try {
      const connected = this.discordClient.isReady();
      const guilds = this.discordClient.guilds?.cache.size || 0;
      const users =
        this.discordClient.guilds?.cache.reduce(
          (total: number, guild: any) => total + (guild.memberCount || 0),
          0
        ) || 0;
      const latency = this.discordClient.ws?.ping;

      // Extract guild details for environment context
      const guildDetails =
        this.discordClient.guilds?.cache.map((guild: any) => ({
          id: guild.id,
          name: guild.name,
          memberCount: guild.memberCount || 0,
          channels: guild.channels?.cache.size || 0,
        })) || [];

      return {
        connected,
        guilds,
        users,
        latency: latency >= 0 ? latency : undefined,
        guildDetails,
      };
    } catch (error) {
      logger.error('Failed to get Discord status:', error);
      return {
        connected: false,
        guilds: 0,
        users: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private getVersion(): string {
    try {
      const packageJson = JSON.parse(readFileSync('/app/packages/discord/package.json', 'utf8'));
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
export const healthServer = new HealthServer(parseInt(process.env.HEALTH_PORT || '47319'));
