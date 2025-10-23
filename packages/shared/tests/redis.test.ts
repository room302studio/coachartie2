import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createQueue,
  createWorker,
  createRedisConnection,
  closeRedisConnection,
} from '../src/utils/redis.js';
import { IncomingMessage } from '../src/types/queue.js';

describe('Redis Queue Tests', () => {
  beforeAll(async () => {
    // Ensure Redis connection is established
    createRedisConnection();
  });

  afterAll(async () => {
    await closeRedisConnection();
  });

  it('should create a queue and add a job', async () => {
    const testQueue = createQueue<IncomingMessage>('test-queue');

    const testMessage: IncomingMessage = {
      id: 'test-123',
      timestamp: new Date(),
      retryCount: 0,
      source: 'discord',
      userId: 'user-123',
      message: 'Hello, world!',
      respondTo: {
        type: 'discord',
        channelId: 'channel-123',
      },
    };

    const job = await testQueue.add('test-job', testMessage);
    expect(job.id).toBeDefined();
    expect(job.data).toEqual(testMessage);

    // Clean up
    await testQueue.obliterate({ force: true });
  });

  it('should process jobs with a worker', async () => {
    const testQueue = createQueue<{ message: string }>('test-worker');
    let processedMessage = '';

    const worker = createWorker<{ message: string }, void>('test-worker', async (job) => {
      processedMessage = job.data.message;
    });

    await testQueue.add('test-job', { message: 'Process me!' });

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(processedMessage).toBe('Process me!');

    // Clean up
    await worker.close();
    await testQueue.obliterate({ force: true });
  });
});
