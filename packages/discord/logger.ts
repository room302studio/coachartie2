/**
 * @fileoverview Structured logging system for CoachArtie Discord bot using Winston and Grafana Loki.
 * Provides comprehensive logging capabilities with multiple transports and structured event logging.
 * @module logger
 */

import winston from 'winston';
import LokiTransport from 'winston-loki';
import {
  Message,
  MessageType,
  Attachment,
  Channel,
  ThreadChannel,
  User,
  Guild,
  GuildMember,
} from 'discord.js';
import { hostname } from 'os';
import { randomUUID } from 'crypto';

const { combine, timestamp, json, errors } = winston.format;

const addRequestId = winston.format(info => {
  info.request_id = randomUUID();
  return info;
});

interface LogMetadata {
  service: string;
  event?: string;
  metadata?: Record<string, unknown>;
  error?: Error;
}

interface SystemMetrics {
  memory: number;
  nodeEnv: string;
  additional?: Record<string, unknown>;
}

interface ProcessingResult {
  response?: string;
  taskId?: string;
  success?: boolean;
  processingTime?: number;
}

interface ProcessingOptions {
  isThread?: boolean;
  channelId?: string;
  authorId?: string;
}

interface ExtendedError extends Error {
  code?: string;
}

// Add new interfaces for analytics-focused metadata
interface UserMetadata {
  id: string;
  tag: string;
  username: string;
  isBot: boolean;
  joinedAt?: number;
  guildId?: string;
  roles?: string[];
}

interface MessageMetrics {
  characterCount: number;
  wordCount: number;
  containsCode: boolean;
  containsImage: boolean;
  containsLink: boolean;
  responseTimeMs?: number;
}

// Add standardized label interfaces
interface LokiLabels {
  app: string;
  environment: string;
  component: string;
  level: string;
  event_type: string;
}

interface MetricsData {
  duration_ms?: number;
  memory_mb?: number;
  count?: number;
  size_bytes?: number;
}

/**
 * Winston logger instance configured with console, file, and Loki transports.
 */
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }),
    addRequestId(),
    timestamp({
      format: 'YYYY-MM-DD HH:mm:ss.SSS',
    }),
    json()
  ),
  defaultMeta: {
    service: 'coachartie-discord',
    environment: process.env.NODE_ENV || 'development',
    version: process.env.APP_VERSION || '0.0.1',
    region: process.env.DEPLOY_REGION || 'unknown',
    instance: process.env.INSTANCE_ID || hostname(),
  },
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 5242880,
      maxFiles: 5,
    }),
    new LokiTransport({
      host: process.env.LOKI_HOST || '',
      basicAuth: process.env.LOKI_BASIC_AUTH || '',
      labels: {
        app: 'coachartie',
        environment: process.env.NODE_ENV || 'development',
        component: process.env.LOKI_COMPONENT || 'discord',
        job: process.env.LOKI_JOB_NAME || 'discord-bot',
        region: process.env.DEPLOY_REGION || 'unknown',
      },
      batching: true,
      batchInterval: 5000,
      batchSize: 2 * 1024 * 1024,
      timeout: 10000,
      json: true,
      format: combine(timestamp(), json()),
      replaceTimestamp: true,
      gracefulShutdown: true,
    }),
  ],
  exceptionHandlers: [
    new winston.transports.File({
      filename: 'logs/exceptions.log',
      maxsize: 5242880,
      maxFiles: 5,
    }),
  ],
});

// Extend the logger with our custom methods
interface ExtendedLogger extends winston.Logger {
  messageReceived(message: Message, metadata?: Record<string, unknown>): void;
  systemEvent(type: string, metrics?: SystemMetrics): void;
  apiRequest(endpoint: string, method: string, payload: unknown): void;
  apiResponse(endpoint: string, status: number, data: unknown): void;
  apiError(endpoint: string, error: Error): void;
  messageProcessed(message: Message, result: ProcessingResult): void;
  messageProcessingStart(messageId: string, options?: ProcessingOptions): void;
  userActivity(
    userId: string,
    guildId: string,
    metrics: UserActivityMetrics
  ): void;
  systemMetrics(): void;
}

// Add our custom methods to the logger
const extendedLogger = logger as ExtendedLogger;

/**
 * Logs a received Discord message with metadata.
 * @example
 * // Log a regular message
 * logger.messageReceived(message);
 *
 * @example
 * // Log a message with additional metadata
 * logger.messageReceived(message, {
 *   source: 'dm',
 *   priority: 'high',
 *   mentionsBot: true
 * });
 */
extendedLogger.messageReceived = (message: Message, metadata = {}) => {
  // Extract user metadata in a format optimized for querying
  const userMetadata: UserMetadata = {
    id: message.author.id,
    tag: message.author.tag,
    username: message.author.username,
    isBot: message.author.bot,
    joinedAt: message.member?.joinedTimestamp || undefined,
    guildId: message.guild?.id,
    roles: message.member?.roles.cache.map(role => role.name),
  };

  // Calculate message metrics
  const messageMetrics: MessageMetrics = {
    characterCount: message.content.length,
    wordCount: message.content.trim().split(/\s+/).length,
    containsCode: /```[\s\S]*?```/.test(message.content),
    containsImage: message.attachments.some(att =>
      att.contentType?.startsWith('image/')
    ),
    containsLink: /https?:\/\/\S+/.test(message.content),
  };

  const messageMetadata = {
    id: message.id,
    type: message.type,
    channel: {
      id: message.channel?.id,
      type: message.channel.type,
      name: 'name' in message.channel ? message.channel.name : undefined,
      isThread: message.channel.isThread(),
      parentId: message.channel.isThread()
        ? message.channel.parentId
        : undefined,
    },
    guild: message.guild
      ? {
          id: message.guild.id,
          name: message.guild.name,
          memberCount: message.guild.memberCount,
        }
      : undefined,
    timestamp: message.createdTimestamp,
    attachments: Array.from(message.attachments.values()).map(att => ({
      id: att.id,
      url: att.url,
      contentType: att.contentType,
      size: att.size,
    })),
  };

  // Log in a format optimized for Grafana queries
  logger.info('Message received', {
    event: 'message.received',
    user: userMetadata, // Separate user metadata for easy querying
    metrics: messageMetrics, // Separate metrics for aggregation
    message: messageMetadata,
    metadata: {
      ...metadata,
    },
  });
};

/**
 * Logs a system event with performance metrics.
 * @example
 * logger.systemEvent('startup', {
 *   memory: process.memoryUsage().heapUsed,
 *   uptime: process.uptime(),
 *   nodeVersion: process.version
 * });
 */
extendedLogger.systemEvent = (
  type: string,
  metrics: SystemMetrics = {
    memory: 0,
    nodeEnv: process.env.NODE_ENV || 'development',
  }
) => {
  const currentMemory = process.memoryUsage().heapUsed;
  logger.info(`System ${type}`, {
    event: `system.${type}`,
    metadata: {
      ...metrics,
      memory: currentMemory,
    },
  });
};

/**
 * Logs an outgoing API request.
 * @example
 * logger.apiRequest('/api/execute', 'POST', {
 *   task_type: 'message',
 *   payload: 'Hello!',
 *   messageId: '123456789'
 * });
 */
extendedLogger.apiRequest = (
  endpoint: string,
  method: string,
  payload: unknown
) => {
  logger.info('API request initiated', {
    event: 'api.request',
    endpoint,
    method,
    payload,
  });
};

/**
 * Logs an API response.
 * @example
 * logger.apiResponse('/api/execute', 200, {
 *   success: true,
 *   taskId: 'abc123',
 *   queuePosition: 1
 * });
 */
extendedLogger.apiResponse = (
  endpoint: string,
  status: number,
  data: unknown
) => {
  logger.info('API response received', {
    event: 'api.response',
    endpoint,
    status,
    data,
  });
};

/**
 * Logs an API error with detailed error information.
 * @example
 * try {
 *   await makeApiCall();
 * } catch (error) {
 *   logger.apiError('/api/execute', error);
 * }
 */
extendedLogger.apiError = (endpoint: string, error: Error) => {
  const extError = error as ExtendedError;

  logger.error('API request failed', {
    // Labels for efficient querying
    labels: {
      event_type: 'api_error',
      error_type: extError.name,
      endpoint: endpoint.replace(/[^a-zA-Z0-9_]/g, '_'), // Sanitize for Loki
    },
    // Metrics for alerts and dashboards
    metrics: {
      count: 1,
    },
    // Error context
    error: {
      message: extError.message,
      code: extError.code,
      name: extError.name,
      stack: extError.stack,
    },
    // Additional context
    context: {
      endpoint,
      timestamp: Date.now(),
      process: {
        memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        uptime: process.uptime(),
      },
    },
  });
};

/**
 * Logs a processed Discord message with its result.
 * @example
 * logger.messageProcessed(message, {
 *   response: 'Here's what I found...',
 *   taskId: 'abc123',
 *   success: true,
 *   processingTime: 1234
 * });
 */
extendedLogger.messageProcessed = (
  message: Message,
  result: ProcessingResult
) => {
  const responseTime =
    result.processingTime || Date.now() - message.createdTimestamp;

  // Structure metrics in a standardized way
  const metrics: MetricsData = {
    duration_ms: responseTime,
    memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  };

  logger.info('Message processed', {
    // Labels for efficient querying
    labels: {
      event_type: 'message_processed',
      guild_id: message.guild?.id || 'dm',
      channel_type: message.channel.type,
      success: String(result.success), // Convert to string for Loki labels
    },
    // Metrics for visualization
    metrics,
    // Context for debugging
    context: {
      message_id: message.id,
      user: {
        id: message.author.id,
        tag: message.author.tag,
      },
      channel: {
        id: message.channel?.id,
        name: 'name' in message.channel ? message.channel.name : undefined,
      },
      result: {
        task_id: result.taskId,
        success: result.success,
      },
    },
    // Original data preserved
    raw: {
      response: result.response,
      guild: message.guild
        ? {
            id: message.guild.id,
            name: message.guild.name,
          }
        : null,
    },
  });
};

/**
 * Logs the start of message processing with timing information.
 * @example
 * logger.messageProcessingStart('123456789', {
 *   isThread: true,
 *   channelId: '987654321',
 *   authorId: '456789123'
 * });
 */
extendedLogger.messageProcessingStart = (
  messageId: string,
  options: ProcessingOptions = {}
) => {
  logger.info('Message processing started', {
    event: 'message.processing.start',
    metadata: {
      messageId,
      startTime: Date.now(),
      ...options,
    },
  });
};

// Add a new method for tracking user activity over time
interface UserActivityMetrics {
  messageCount: number;
  characterCount: number;
  responseTimeAvg: number;
  lastActive: number;
}

extendedLogger.userActivity = (
  userId: string,
  guildId: string,
  metrics: UserActivityMetrics
) => {
  logger.info('User activity updated', {
    event: 'user.activity',
    user: {
      id: userId,
    },
    guild: {
      id: guildId,
    },
    metrics,
  });
};

// Add system metrics logging
extendedLogger.systemMetrics = () => {
  const metrics: MetricsData = {
    memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  };

  logger.info('System metrics', {
    labels: {
      event_type: 'system_metrics',
    },
    metrics,
    context: {
      node_version: process.version,
      uptime: process.uptime(),
      cpu_usage: process.cpuUsage(),
    },
  });
};

// Export the extended logger
export default extendedLogger;
