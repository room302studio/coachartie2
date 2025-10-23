import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createQueue,
  createWorker,
  createRedisConnection,
  closeRedisConnection,
  QUEUES,
  IncomingMessage,
  OutgoingMessage,
} from '../src/index.js';

describe('Redis Queue Integration Tests', () => {
  beforeAll(async () => {
    // Ensure Redis connection is established
    createRedisConnection();
  });

  afterAll(async () => {
    await closeRedisConnection();
  });

  it('should process a message through the queue system', async () => {
    const incomingQueue = createQueue<IncomingMessage>(QUEUES.INCOMING_MESSAGES);
    const outgoingQueue = createQueue<OutgoingMessage>(QUEUES.OUTGOING_DISCORD);

    let receivedMessage: IncomingMessage | null = null;
    let processedResponse: OutgoingMessage | null = null;

    // Set up a worker to process incoming messages
    const incomingWorker = createWorker<IncomingMessage, void>(
      QUEUES.INCOMING_MESSAGES,
      async (job) => {
        receivedMessage = job.data;

        // Simulate processing and send response
        const response: OutgoingMessage = {
          id: `response-${Date.now()}`,
          timestamp: new Date(),
          retryCount: 0,
          source: 'capabilities',
          userId: job.data.userId,
          message: `Echo: ${job.data.message}`,
          inReplyTo: job.data.id,
          metadata: {
            channelId: job.data.respondTo.channelId,
          },
        };

        await outgoingQueue.add('response', response);
      }
    );

    // Set up a worker to handle outgoing messages
    const outgoingWorker = createWorker<OutgoingMessage, void>(
      QUEUES.OUTGOING_DISCORD,
      async (job) => {
        processedResponse = job.data;
      }
    );

    // Send a test message
    const testMessage: IncomingMessage = {
      id: 'test-message-123',
      timestamp: new Date(),
      retryCount: 0,
      source: 'discord',
      userId: 'user-123',
      message: 'Hello, Coach Artie!',
      respondTo: {
        type: 'discord',
        channelId: 'channel-123',
      },
    };

    await incomingQueue.add('test', testMessage);

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify the message was processed
    expect(receivedMessage).toBeTruthy();
    expect(receivedMessage?.message).toBe('Hello, Coach Artie!');
    expect(receivedMessage?.userId).toBe('user-123');

    // Verify the response was generated
    expect(processedResponse).toBeTruthy();
    expect(processedResponse?.message).toBe('Echo: Hello, Coach Artie!');
    expect(processedResponse?.inReplyTo).toBe('test-message-123');

    // Clean up
    await incomingWorker.close();
    await outgoingWorker.close();
    await incomingQueue.obliterate({ force: true });
    await outgoingQueue.obliterate({ force: true });
  });

  it('should handle queue failures gracefully', async () => {
    const testQueue = createQueue<{ shouldFail: boolean }>('test-failures');
    let failureCount = 0;

    const worker = createWorker<{ shouldFail: boolean }, void>('test-failures', async (job) => {
      if (job.data.shouldFail) {
        failureCount++;
        throw new Error('Intentional test failure');
      }
    });

    worker.on('failed', (job, err) => {
      expect(err.message).toBe('Intentional test failure');
    });

    // Add a job that will fail
    await testQueue.add('fail-test', { shouldFail: true });

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(failureCount).toBeGreaterThan(0);

    // Clean up
    await worker.close();
    await testQueue.obliterate({ force: true });
  });
});
