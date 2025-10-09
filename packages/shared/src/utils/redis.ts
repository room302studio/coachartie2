import Redis from 'ioredis';
import { Queue, Worker, QueueEvents, Job } from 'bullmq';
import { logger } from './logger.js';

let redisConnection: Redis | null = null;

export const createRedisConnection = (): Redis => {
  if (redisConnection) {
    console.log('♻️ Reusing existing Redis connection');
    return redisConnection;
  }

  const redisHost = process.env.REDIS_HOST || 'localhost';
  const redisPort = parseInt(process.env.REDIS_PORT || '47320');

  console.log('🔴 CREATING NEW REDIS CONNECTION - SNUCKS ARE JUCKED!');
  console.log(`  - Host: ${redisHost}`);
  console.log(`  - Port: ${redisPort}`);
  console.log(`  - Full address: ${redisHost}:${redisPort}`);

  redisConnection = new Redis({
    host: redisHost,
    port: redisPort,
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  redisConnection.on('error', (err) => {
    console.error('💥 REDIS CONNECTION ERROR - BOOKITY BROKEN!');
    console.error(`  - Error: ${err.message}`);
    console.error(`  - Code: ${(err as any).code}`);
    console.error(`  - Attempting to connect to: ${redisHost}:${redisPort}`);
    logger.error('Redis connection error:', err);
  });

  redisConnection.on('connect', () => {
    console.log('✅ REDIS CONNECTED SUCCESSFULLY - FLUCKS ARE BUCKED!');
    console.log(`  - Connected to: ${redisHost}:${redisPort}`);
    logger.info('Redis connected successfully');
  });

  return redisConnection;
};

// Export redis instance for service discovery
export const redis = createRedisConnection();

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