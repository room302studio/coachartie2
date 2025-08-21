import { logger } from '@coachartie/shared';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface DiscordMetrics {
  // Message metrics
  messagesReceived: number;
  messagesProcessed: number;
  messagesFailed: number;
  responsesDelivered: number;
  
  // Job metrics
  jobsSubmitted: number;
  jobsCompleted: number;
  jobsFailed: number;
  jobsTimedOut: number;
  
  // Performance metrics
  averageResponseTime: number;
  maxResponseTime: number;
  minResponseTime: number;
  
  // Discord API metrics
  typingIndicatorsSent: number;
  messageChunksSent: number;
  apiErrors: number;
  
  // Connection metrics
  reconnections: number;
  uptime: number;
  
  // User metrics
  uniqueUsers: Set<string>;
  guildCount: number;
  channelCount: number;
}

export interface TelemetryEvent {
  timestamp: string;
  correlationId?: string;
  userId?: string;
  event: string;
  data?: any;
  duration?: number;
  success?: boolean;
}

export class DiscordTelemetry {
  private metrics: DiscordMetrics;
  private events: TelemetryEvent[] = [];
  private maxEvents = 1000; // Keep last 1000 events in memory
  private metricsFile: string;
  private eventsFile: string;
  private startTime: number;
  private responseTimes: number[] = [];

  constructor() {
    this.startTime = Date.now();
    this.metricsFile = process.env.DISCORD_METRICS_FILE || '/app/data/discord-metrics.json';
    this.eventsFile = process.env.DISCORD_EVENTS_FILE || '/app/data/discord-events.json';
    
    // Initialize metrics
    this.metrics = {
      messagesReceived: 0,
      messagesProcessed: 0,
      messagesFailed: 0,
      responsesDelivered: 0,
      jobsSubmitted: 0,
      jobsCompleted: 0,
      jobsFailed: 0,
      jobsTimedOut: 0,
      averageResponseTime: 0,
      maxResponseTime: 0,
      minResponseTime: 0,
      typingIndicatorsSent: 0,
      messageChunksSent: 0,
      apiErrors: 0,
      reconnections: 0,
      uptime: 0,
      uniqueUsers: new Set<string>(),
      guildCount: 0,
      channelCount: 0
    };

    // Ensure data directories exist
    this.ensureDataDirectories();
    
    // Auto-persist metrics every 30 seconds
    setInterval(() => this.persistMetrics(), 30000);
  }

  private ensureDataDirectories(): void {
    try {
      const metricsDir = dirname(this.metricsFile);
      const eventsDir = dirname(this.eventsFile);
      
      if (!existsSync(metricsDir)) {
        mkdirSync(metricsDir, { recursive: true });
      }
      
      if (!existsSync(eventsDir)) {
        mkdirSync(eventsDir, { recursive: true });
      }
    } catch (error) {
      logger.error('Failed to create telemetry data directories:', error);
    }
  }

  // Event logging
  logEvent(event: string, data?: any, correlationId?: string, userId?: string, duration?: number, success?: boolean): void {
    const telemetryEvent: TelemetryEvent = {
      timestamp: new Date().toISOString(),
      correlationId,
      userId,
      event,
      data,
      duration,
      success
    };

    this.events.push(telemetryEvent);
    
    // Keep only recent events in memory
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }

    // Log important events
    if (success === false || event.includes('error') || event.includes('failed')) {
      logger.warn(`📊 Telemetry Event: ${event}`, { correlationId, userId, data });
    } else {
      logger.debug(`📊 Telemetry Event: ${event}`, { correlationId, userId, duration });
    }
  }

  // Message metrics
  incrementMessagesReceived(userId: string): void {
    this.metrics.messagesReceived++;
    this.metrics.uniqueUsers.add(userId);
    this.logEvent('message_received', { userId }, undefined, userId);
  }

  incrementMessagesProcessed(userId: string, duration?: number): void {
    this.metrics.messagesProcessed++;
    if (duration) {
      this.recordResponseTime(duration);
    }
    this.logEvent('message_processed', { duration }, undefined, userId, duration, true);
  }

  incrementMessagesFailed(userId: string, error: string, duration?: number): void {
    this.metrics.messagesFailed++;
    this.logEvent('message_failed', { error }, undefined, userId, duration, false);
  }

  incrementResponsesDelivered(userId: string, chunks: number): void {
    this.metrics.responsesDelivered++;
    this.metrics.messageChunksSent += chunks;
    this.logEvent('response_delivered', { chunks }, undefined, userId);
  }

  // Job metrics
  incrementJobsSubmitted(userId: string, jobId: string): void {
    this.metrics.jobsSubmitted++;
    this.logEvent('job_submitted', { jobId }, jobId, userId);
  }

  incrementJobsCompleted(userId: string, jobId: string, duration: number): void {
    this.metrics.jobsCompleted++;
    this.recordResponseTime(duration);
    this.logEvent('job_completed', { jobId, duration }, jobId, userId, duration, true);
  }

  incrementJobsFailed(userId: string, jobId: string, error: string, duration?: number): void {
    this.metrics.jobsFailed++;
    this.logEvent('job_failed', { jobId, error }, jobId, userId, duration, false);
  }

  incrementJobsTimedOut(userId: string, jobId: string, duration: number): void {
    this.metrics.jobsTimedOut++;
    this.logEvent('job_timeout', { jobId }, jobId, userId, duration, false);
  }

  // Discord API metrics
  incrementTypingIndicators(): void {
    this.metrics.typingIndicatorsSent++;
  }

  incrementApiErrors(error: string): void {
    this.metrics.apiErrors++;
    this.logEvent('discord_api_error', { error }, undefined, undefined, undefined, false);
  }

  incrementReconnections(): void {
    this.metrics.reconnections++;
    this.logEvent('discord_reconnection');
  }

  // Performance tracking
  private recordResponseTime(duration: number): void {
    this.responseTimes.push(duration);
    
    // Keep only recent response times for calculating averages
    if (this.responseTimes.length > 100) {
      this.responseTimes = this.responseTimes.slice(-100);
    }

    // Update performance metrics
    this.metrics.maxResponseTime = Math.max(this.metrics.maxResponseTime, duration);
    this.metrics.minResponseTime = this.metrics.minResponseTime === 0 
      ? duration 
      : Math.min(this.metrics.minResponseTime, duration);
    
    this.metrics.averageResponseTime = this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length;
  }

  // Discord connection metrics
  updateConnectionMetrics(guildCount: number, channelCount: number): void {
    this.metrics.guildCount = guildCount;
    this.metrics.channelCount = channelCount;
    this.metrics.uptime = Date.now() - this.startTime;
  }

  // Get current metrics snapshot
  getMetrics(): DiscordMetrics & { uniqueUserCount: number } {
    this.updateConnectionMetrics(this.metrics.guildCount, this.metrics.channelCount);
    
    return {
      ...this.metrics,
      uniqueUserCount: this.metrics.uniqueUsers.size,
      uniqueUsers: this.metrics.uniqueUsers // Keep for internal use
    };
  }

  // Get recent events
  getRecentEvents(limit: number = 50): TelemetryEvent[] {
    return this.events.slice(-limit);
  }

  // Persist metrics to file
  persistMetrics(): void {
    try {
      const metricsSnapshot = this.getMetrics();
      
      // Convert Set to array for JSON serialization
      const serializableMetrics = {
        ...metricsSnapshot,
        uniqueUsers: Array.from(metricsSnapshot.uniqueUsers),
        timestamp: new Date().toISOString()
      };
      
      writeFileSync(this.metricsFile, JSON.stringify(serializableMetrics, null, 2));
      
      // Also persist recent events
      const recentEvents = this.getRecentEvents();
      writeFileSync(this.eventsFile, JSON.stringify(recentEvents, null, 2));
      
    } catch (error) {
      logger.error('Failed to persist telemetry data:', error);
    }
  }

  // Get telemetry summary for health checks
  getHealthSummary(): {
    status: 'healthy' | 'degraded' | 'unhealthy';
    metrics: any;
    issues: string[];
  } {
    const metrics = this.getMetrics();
    const issues: string[] = [];
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

    // Check for issues
    const errorRate = metrics.messagesFailed / Math.max(metrics.messagesReceived, 1);
    const jobFailureRate = metrics.jobsFailed / Math.max(metrics.jobsSubmitted, 1);
    
    if (errorRate > 0.1) {
      issues.push(`High message error rate: ${(errorRate * 100).toFixed(1)}%`);
      status = 'degraded';
    }
    
    if (jobFailureRate > 0.2) {
      issues.push(`High job failure rate: ${(jobFailureRate * 100).toFixed(1)}%`);
      status = 'degraded';
    }
    
    if (metrics.averageResponseTime > 30000) {
      issues.push(`Slow response times: ${(metrics.averageResponseTime / 1000).toFixed(1)}s avg`);
      status = 'degraded';
    }
    
    if (metrics.apiErrors > 10) {
      issues.push(`Multiple Discord API errors: ${metrics.apiErrors}`);
      status = 'unhealthy';
    }

    if (errorRate > 0.5 || jobFailureRate > 0.5) {
      status = 'unhealthy';
    }

    return {
      status,
      metrics: {
        messagesReceived: metrics.messagesReceived,
        successRate: ((metrics.messagesProcessed / Math.max(metrics.messagesReceived, 1)) * 100).toFixed(1) + '%',
        averageResponseTime: `${(metrics.averageResponseTime / 1000).toFixed(1)}s`,
        uniqueUsers: metrics.uniqueUserCount,
        uptime: `${Math.floor(metrics.uptime / 1000 / 60)}min`,
        guilds: metrics.guildCount
      },
      issues
    };
  }
}

// Export singleton instance
export const telemetry = new DiscordTelemetry();