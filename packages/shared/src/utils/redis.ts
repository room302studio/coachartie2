import Redis from 'ioredis';
import { Queue, Worker, QueueEvents, Job } from 'bullmq';
import { logger } from './logger.js';

let redisConnection: Redis | null = null;

export const createRedisConnection = (): Redis => {
  if (redisConnection) {
    return redisConnection;
  }

  redisConnection = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  redisConnection.on('error', (err) => {
    logger.error('Redis connection error:', err);
  });

  redisConnection.on('connect', () => {
    logger.info('Redis connected successfully');
  });

  return redisConnection;
};

export const createQueue = <T = any>(name: string): Queue<T> => {
  return new Queue<T>(name, {
    connection: createRedisConnection(),
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
};

export const createWorker = <T = any, R = any>(
  name: string,
  processor: (job: Job<T>) => Promise<R>
): Worker<T, R> => {
  return new Worker<T, R>(name, processor, {
    connection: createRedisConnection(),
    concurrency: parseInt(process.env.WORKER_CONCURRENCY || '5'),
  });
};

export const createQueueEvents = (name: string): QueueEvents => {
  return new QueueEvents(name, {
    connection: createRedisConnection(),
  });
};

export const closeRedisConnection = async (): Promise<void> => {
  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
  }
};