import winston from 'winston';
import LokiTransport from 'winston-loki';
import TransportStream from 'winston-transport';

const logLevel = process.env.LOG_LEVEL || 'info';
const serviceName = process.env.SERVICE_NAME || 'coachartie';
const lokiUrl = process.env.LOKI_URL || 'http://localhost:3100';

// SQLite transport for local log storage
class SQLiteTransport extends TransportStream {
  constructor(opts: any = {}) {
    super(opts);
  }

  log(info: any, callback: () => void) {
    setImmediate(() => {
      this.emit('logged', info);
    });

    // For now, just emit the logged event
    // SQLite integration will be added later to avoid circular dependencies
    callback();
  }
}

// Create base logger with multiple transports
const transports: winston.transport[] = [
  // Console transport with high-density format
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, service, message, ...meta }: any) => {
        // Skip pid and nodeVersion
        const { pid, nodeVersion, ...cleanMeta } = meta;
        
        // Collapse message to single line
        const cleanMessage = String(message).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
        
        // Only show meta if it has meaningful content
        const hasUsefulMeta = Object.keys(cleanMeta).length > 0 && 
          !Object.values(cleanMeta).every(v => v === undefined || v === null);
        
        // Super compact format
        const metaStr = hasUsefulMeta ? ` ${JSON.stringify(cleanMeta)}` : '';
        
        // Short service names
        const shortService = String(service || 'unknown').replace('@coachartie/', '').substring(0, 8);
        
        return `${timestamp} ${shortService}: ${cleanMessage}${metaStr}`;
      })
    ),
  }),

  // SQLite transport for local storage
  new SQLiteTransport({}),
];

// Add Loki transport if URL is configured
if (process.env.LOKI_URL && process.env.LOKI_URL !== 'disabled') {
  transports.push(
    new LokiTransport({
      host: lokiUrl,
      labels: { 
        service: serviceName,
        environment: process.env.NODE_ENV || 'development',
        host: process.env.HOSTNAME || 'localhost'
      },
      json: true,
      format: winston.format.json(),
      replaceTimestamp: true,
      onConnectionError: (err) => {
        console.error('Loki connection error:', err);
      }
    })
  );
}

// Add file transports in production
if (process.env.NODE_ENV === 'production') {
  transports.push(
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      format: winston.format.json(),
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      format: winston.format.json(),
    })
  );
}

export const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { 
    service: serviceName,
    pid: process.pid,
    nodeVersion: process.version
  },
  transports,
});

// Enhanced logging interface with metrics
export interface LogMetrics {
  duration?: number;
  statusCode?: number;
  userId?: string;
  requestId?: string;
  messageId?: string;
  endpoint?: string;
  memoryUsage?: number;
  cpuUsage?: number;
  errorCode?: string;
  success?: boolean;
  error?: string;
  userAgent?: string;
  ip?: string;
  responseLength?: number;
  messageLength?: number;
  jobId?: string;
  jobName?: string;
}

export interface StructuredLogger {
  info(message: string, meta?: LogMetrics): void;
  error(message: string, error?: Error, meta?: LogMetrics): void;
  warn(message: string, meta?: LogMetrics): void;
  debug(message: string, meta?: LogMetrics): void;
  http(message: string, meta?: LogMetrics): void;
  metric(eventName: string, value: number, meta?: LogMetrics): void;
}

// Performance monitoring utilities
export const performanceLogger = {
  startTimer: (label: string) => {
    const start = process.hrtime.bigint();
    return {
      end: (meta?: LogMetrics) => {
        const duration = Number(process.hrtime.bigint() - start) / 1000000; // Convert to ms
        logger.info(`${label} completed`, { 
          ...meta, 
          duration: Math.round(duration),
          memoryUsage: process.memoryUsage().heapUsed,
          cpuUsage: process.cpuUsage().user / 1000000 // Convert to ms
        });
        return duration;
      }
    };
  },

  measureAsync: async <T>(label: string, fn: () => Promise<T>, meta?: LogMetrics): Promise<T> => {
    const timer = performanceLogger.startTimer(label);
    try {
      const result = await fn();
      timer.end({ ...meta, success: true });
      return result;
    } catch (error) {
      timer.end({ ...meta, success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      throw error;
    }
  }
};

// Structured logger implementation
export const structuredLogger: StructuredLogger = {
  info: (message: string, meta?: LogMetrics) => {
    logger.info(message, meta);
  },
  
  error: (message: string, error?: Error, meta?: LogMetrics) => {
    logger.error(message, {
      ...meta,
      error: error?.message,
      stack: error?.stack,
      errorCode: meta?.errorCode
    });
  },
  
  warn: (message: string, meta?: LogMetrics) => {
    logger.warn(message, meta);
  },
  
  debug: (message: string, meta?: LogMetrics) => {
    logger.debug(message, meta);
  },
  
  http: (message: string, meta?: LogMetrics) => {
    logger.http(message, meta);
  },
  
  metric: (eventName: string, value: number, meta?: LogMetrics) => {
    logger.info(`METRIC: ${eventName}`, {
      ...meta,
      metricName: eventName,
      metricValue: value,
      timestamp: new Date().toISOString()
    });
  }
};

// Request/Response logging middleware
export const createRequestLogger = (serviceName: string) => {
  return (req: any, res: any, next: any) => {
    const requestId = Math.random().toString(36).substring(7);
    const startTime = Date.now();
    
    req.requestId = requestId;
    
    // Log incoming request
    structuredLogger.http('Incoming request', {
      requestId,
      endpoint: `${req.method} ${req.path}`,
      userId: req.userId || req.user?.id,
      userAgent: req.get('User-Agent'),
      ip: req.ip
    });
    
    // Override res.end to log response
    const originalEnd = res.end;
    res.end = function(...args: any[]) {
      const duration = Date.now() - startTime;
      
      structuredLogger.http('Request completed', {
        requestId,
        endpoint: `${req.method} ${req.path}`,
        statusCode: res.statusCode,
        duration,
        userId: req.userId || req.user?.id
      });
      
      originalEnd.apply(this, args);
    };
    
    next();
  };
};

// Queue job logging
export const queueLogger = {
  jobStarted: (jobName: string, jobId: string, meta?: any) => {
    structuredLogger.info(`Queue job started: ${jobName}`, {
      jobId,
      jobName,
      ...meta
    });
  },
  
  jobCompleted: (jobName: string, jobId: string, duration: number, meta?: any) => {
    structuredLogger.info(`Queue job completed: ${jobName}`, {
      jobId,
      jobName,
      duration,
      success: true,
      ...meta
    });
  },
  
  jobFailed: (jobName: string, jobId: string, error: Error, meta?: any) => {
    structuredLogger.error(`Queue job failed: ${jobName}`, error, {
      jobId,
      jobName,
      success: false,
      ...meta
    });
  }
};

export default logger;