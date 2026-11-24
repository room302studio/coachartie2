import { createServer, IncomingMessage, ServerResponse } from 'http';
import { logger } from '../shared/logger.js';
import { telemetry } from './telemetry.js';
import { readFileSync } from 'fs';
import type { ApiResult } from '../shared/api-result.js';
import * as engine from '../engine/api.js';
import { withTimeout } from '../shared/async.js';
import { getErrorMessage } from '../shared/errors.js';

interface HealthCheckResponse {
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

/**
 * Convert health status to HTTP status code.
 */
function healthStatusCode(status: 'healthy' | 'degraded' | 'unhealthy'): number {
  if (status === 'healthy') {
    return 200;
  }
  if (status === 'degraded') {
    return 200;
  }
  return 503;
}

class HealthServer {
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

    // Wave 9: the engine's GET /health body, in-process (was a fetch to :47324/health),
    // still bounded at 3s: a Redis ping can hang when Redis is down.
    try {
      const response = await withTimeout(engine.healthSnapshot(), 3000);
      const reachable = engine.isOk(response);
      this.capabilitiesHealthCache = { reachable, checkedAt: now };
      return reachable;
    } catch {
      this.capabilitiesHealthCache = { reachable: false, checkedAt: now };
      return false;
    }
  }

  setDiscordClient(client: any): void {
    this.discordClient = client;
  }

  /** Listen on 127.0.0.1; resolves once listening, rejects (after logging) on a listen error. */
  start(): Promise<void> {
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
            message: getErrorMessage(error),
          })
        );
      }
    });

    return new Promise((resolve, reject) => {
      this.server.listen(this.port, '127.0.0.1', () => {
        logger.info(`🩺 Health server running on 127.0.0.1:${this.server.address()?.port ?? this.port}`);
        resolve();
      });

      this.server.on('error', (error: Error) => {
        logger.error('Health server error:', error);
        reject(error);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
      logger.info('Health server stopped');
    });
  }

  private handleHealthCheck(res: ServerResponse): void {
    const { status, body } = this.healthCheck();
    res.writeHead(status);
    res.end(JSON.stringify(body, null, 2));
  }

  /**
   * GET /health's status code and body (wave 9: extracted so the engine's forums tool can
   * read the guild list in-process through gateway/api.ts instead of fetching :47319).
   */
  healthCheck(): ApiResult<HealthCheckResponse> {
    const healthSummary = telemetry.getHealthSummary();
    const discordStatus = this.getDiscordStatus();

    // Determine overall health based on Discord connection and telemetry
    let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = healthSummary.status;
    const issues = [...healthSummary.issues];

    if (!discordStatus.connected) {
      overallStatus = 'unhealthy';
      issues.push('Discord client not connected');
    }

    let responseIssues: string[] | undefined;
    if (issues.length > 0) {
      responseIssues = issues;
    }

    const response: HealthCheckResponse = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      service: 'discord-bot',
      version: this.getVersion(),
      uptime: process.uptime(),
      discord: discordStatus,
      telemetry: healthSummary.metrics,
      issues: responseIssues,
    };

    const statusCode = healthStatusCode(overallStatus);

    return { status: statusCode, body: response };
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

    let responseIssues: string[] | undefined;
    if (issues.length > 0) {
      responseIssues = issues;
    }

    const response = {
      ready,
      timestamp: new Date().toISOString(),
      checks: {
        discord: discordConnected,
        capabilities: capabilitiesReachable,
      },
      issues: responseIssues,
    };

    let readyStatusCode: number;
    if (ready) {
      readyStatusCode = 200;
    } else {
      readyStatusCode = 503;
    }
    res.writeHead(readyStatusCode);
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

      let latencyValue: number | undefined;
      if (latency >= 0) {
        latencyValue = latency;
      }

      return {
        connected,
        guilds,
        users,
        latency: latencyValue,
        guildDetails,
      };
    } catch (error) {
      logger.error('Failed to get Discord status:', error);
      return {
        connected: false,
        guilds: 0,
        users: 0,
        error: getErrorMessage(error),
      };
    }
  }

  private getVersion(): string {
    try {
      const packageJson = JSON.parse(readFileSync('/app/packages/discord/package.json', 'utf8'));
      return packageJson.version || '1.0.0';
    } catch {
      // Fallback for local development
      try {
        const packageJson = JSON.parse(readFileSync('./package.json', 'utf8'));
        return packageJson.version || '1.0.0';
      } catch {
        return '1.0.0';
      }
    }
  }
}

// Export singleton instance
export const healthServer = new HealthServer(parseInt(process.env.HEALTH_PORT || '47319'));
