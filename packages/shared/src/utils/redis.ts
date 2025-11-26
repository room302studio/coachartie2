import { Redis } from 'ioredis';
import { Queue, Worker, QueueEvents, Job } from 'bullmq';
import { logger } from './logger.js';

let redisConnection: Redis | null = null;
let redisAvailable = false;
let redisChecked = false; // Have we attempted to check Redis availability?
let lastErrorTime = 0;
let errorCount = 0;
const ERROR_LOG_INTERVAL_MS = 30000; // Only log errors every 30 seconds
const MAX_ERRORS_BEFORE_SILENCE = 3; // After 3 errors, go silent until reconnect

// Check if Redis is available
export const isRedisAvailable = (): boolean => redisAvailable;

// Check if Redis has been tested
export const hasRedisBeenChecked = (): boolean => redisChecked;

// Get Redis config
const getRedisConfig = () => ({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '47320'),
});

// Test Redis connectivity before creating workers
export const testRedisConnection = async (): Promise<boolean> => {
  const { host, port } = getRedisConfig();
  redisChecked = true;

  try {
    const testConnection = new Redis({
      host,
      port,
      password: process.env.REDIS_PASSWORD,
      connectTimeout: 3000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null, // Don't retry
      lazyConnect: true, // Don't connect until we explicitly call connect()
    });

    // Suppress error events on test connection (we handle them via promises)
    testConnection.on('error', () => {
      // Silently ignore - we handle via promise rejection
    });

    await testConnection.connect();
    await testConnection.ping();
    await testConnection.quit();

    redisAvailable = true;
    errorCount = 0;
    return true;
  } catch {
    redisAvailable = false;
    return false;
  }
};

export const createRedisConnection = (): Redis => {
  if (redisConnection) {
    return redisConnection;
  }

  const { host, port } = getRedisConfig();

  // Only log if we haven't already checked and found Redis unavailable
  if (!redisChecked || redisAvailable) {
    logger.info(`🔌 Creating Redis connection to ${host}:${port}`);
  }

  redisConnection = new Redis({
    host,
    port,
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true, // Don't connect immediately
    retryStrategy: (times) => {
      // If we've determined Redis is unavailable, don't retry
      if (redisChecked && !redisAvailable) {
        return null; // Stop retrying
      }
      // Exponential backoff with max 60 seconds
      const delay = Math.min(times * 2000, 60000);
      return delay;
    },
  });

  redisConnection.on('error', (err: Error) => {
    const now = Date.now();
    errorCount++;

    // Rate-limit error logging
    if (now - lastErrorTime > ERROR_LOG_INTERVAL_MS && errorCount <= MAX_ERRORS_BEFORE_SILENCE) {
      logger.warn(`Redis connection error (${errorCount}x): ${(err as any).code || err.message}`);
      lastErrorTime = now;
    } else if (errorCount === MAX_ERRORS_BEFORE_SILENCE + 1) {
      logger.warn('Redis unavailable - suppressing further error logs until reconnected');
    }

    redisAvailable = false;
  });

  redisConnection.on('connect', () => {
    logger.info(`✅ Redis connected to ${host}:${port}`);
    redisAvailable = true;
    errorCount = 0;
  });

  redisConnection.on('ready', () => {
    redisAvailable = true;
    errorCount = 0;
  });

  return redisConnection;
};

// Lazy getter - only creates connection when first accessed
let _redis: Redis | null = null;
export const getRedis = (): Redis => {
  if (!_redis) {
    _redis = createRedisConnection();
  }
  return _redis;
};

// For backwards compatibility - but now lazy
export const redis = new Proxy({} as Redis, {
  get(_, prop) {
    return (getRedis() as any)[prop];
  },
});

// Create a Redis connection config for BullMQ (with error suppression)
const getBullMQConnectionConfig = () => {
  const { host, port } = getRedisConfig();
  return {
    host,
    port,
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
    retryStrategy: (times: number) => {
      if (redisChecked && !redisAvailable) {
        return null; // Stop retrying if we know Redis is down
      }
      return Math.min(times * 2000, 60000);
    },
  };
};

export const createQueue = <T = any>(name: string): Queue<T> => {
  const queue = new Queue<T>(name, {
    connection: getBullMQConnectionConfig(),
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: false,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
    },
  });

  // Suppress error events on the queue's connection
  queue.on('error', (err) => {
    // Only log if we haven't exhausted our error quota
    if (errorCount <= MAX_ERRORS_BEFORE_SILENCE) {
      const now = Date.now();
      if (now - lastErrorTime > ERROR_LOG_INTERVAL_MS) {
        logger.warn(`Queue ${name} error: ${(err as any).code || err.message}`);
        lastErrorTime = now;
      }
    }
  });

  return queue;
};

export const createWorker = <T = any, R = any>(
  name: string,
  processor: (job: Job<T>) => Promise<R>
): Worker<T, R> => {
  const worker = new Worker<T, R>(name, processor, {
    connection: getBullMQConnectionConfig(),
    concurrency: parseInt(process.env.WORKER_CONCURRENCY || '5'),
  });

  // Suppress error events on the worker's connection
  worker.on('error', (err) => {
    // Only log if we haven't exhausted our error quota
    if (errorCount <= MAX_ERRORS_BEFORE_SILENCE) {
      const now = Date.now();
      if (now - lastErrorTime > ERROR_LOG_INTERVAL_MS) {
        logger.warn(`Worker ${name} error: ${(err as any).code || err.message}`);
        lastErrorTime = now;
      }
    }
  });

  return worker;
};

export const createQueueEvents = (name: string): QueueEvents => {
  const events = new QueueEvents(name, {
    connection: getBullMQConnectionConfig(),
  });

  // Suppress error events
  events.on('error', () => {
    // Silently ignore - errors are rate-limited elsewhere
  });

  return events;
};

export const closeRedisConnection = async (): Promise<void> => {
  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
  }
};
