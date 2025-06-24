import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { 
  createQueue, 
  createWorker, 
  createRedisConnection, 
  closeRedisConnection,
  QUEUES,
  IncomingMessage,
  OutgoingMessage,
  logger
} from '../src/index.js';
import type { Queue, Worker } from 'bullmq';

describe('Comprehensive Redis Queue Tests', () => {
  let testQueues: Queue[] = [];
  let testWorkers: Worker[] = [];

  beforeAll(async () => {
    // Ensure Redis connection is established
    createRedisConnection();
  });

  beforeEach(() => {
    // Reset arrays for each test
    testQueues = [];
    testWorkers = [];
  });

  afterAll(async () => {
    // Clean up all test queues and workers
    for (const worker of testWorkers) {
      await worker.close();
    }
    for (const queue of testQueues) {
      await queue.obliterate({ force: true });
    }
    await closeRedisConnection();
  });

  describe('Queue Creation and Basic Operations', () => {
    it('should create multiple queues with different types', async () => {
      const incomingQueue = createQueue<IncomingMessage>('test-incoming-multi');
      const outgoingQueue = createQueue<OutgoingMessage>('test-outgoing-multi');
      const stringQueue = createQueue<string>('test-string-multi');
      
      testQueues.push(incomingQueue, outgoingQueue, stringQueue);

      // Test adding different types of jobs
      await incomingQueue.add('incoming-job', {
        id: 'test-1',
        timestamp: new Date(),
        retryCount: 0,
        source: 'discord',
        userId: 'user-1',
        message: 'test message',
        respondTo: { type: 'discord', channelId: 'channel-1' }
      });

      await outgoingQueue.add('outgoing-job', {
        id: 'response-1',
        timestamp: new Date(),
        retryCount: 0,
        source: 'capabilities',
        userId: 'user-1',
        message: 'response message',
        inReplyTo: 'test-1'
      });

      await stringQueue.add('string-job', 'simple string message');

      // Verify jobs were added
      const incomingCount = await incomingQueue.getJobCounts();
      const outgoingCount = await outgoingQueue.getJobCounts();
      const stringCount = await stringQueue.getJobCounts();

      expect(incomingCount.waiting).toBe(1);
      expect(outgoingCount.waiting).toBe(1);
      expect(stringCount.waiting).toBe(1);
    });

    it('should handle job priorities correctly', async () => {
      const priorityQueue = createQueue<{ message: string; priority: number }>('test-priority');
      testQueues.push(priorityQueue);

      const processedOrder: number[] = [];
      
      const worker = createWorker<{ message: string; priority: number }, void>(
        'test-priority',
        async (job) => {
          processedOrder.push(job.data.priority);
        }
      );
      testWorkers.push(worker);

      // Add jobs with different priorities (higher number = higher priority)
      await priorityQueue.add('low', { message: 'low priority', priority: 1 }, { priority: 1 });
      await priorityQueue.add('high', { message: 'high priority', priority: 3 }, { priority: 3 });
      await priorityQueue.add('medium', { message: 'medium priority', priority: 2 }, { priority: 2 });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 500));

      // Should process in priority order: 3, 2, 1
      expect(processedOrder).toEqual([3, 2, 1]);
    });
  });

  describe('Error Handling and Retries', () => {
    it('should retry failed jobs with exponential backoff', async () => {
      const retryQueue = createQueue<{ shouldFail: boolean; attempt: number }>('test-retry');
      testQueues.push(retryQueue);

      const attempts: number[] = [];
      let successfulRun = false;

      const worker = createWorker<{ shouldFail: boolean; attempt: number }, void>(
        'test-retry',
        async (job) => {
          attempts.push(job.attemptsMade);
          
          // Fail first 2 attempts, succeed on 3rd
          if (job.attemptsMade < 3 && job.data.shouldFail) {
            throw new Error(`Attempt ${job.attemptsMade} failed`);
          }
          successfulRun = true;
        }
      );
      testWorkers.push(worker);

      await retryQueue.add('retry-job', { shouldFail: true, attempt: 1 });

      // Wait for all retries to complete
      await new Promise(resolve => setTimeout(resolve, 2000));

      expect(attempts.length).toBeGreaterThanOrEqual(3);
      expect(successfulRun).toBe(true);
      expect(attempts).toContain(1); // First attempt
      expect(attempts).toContain(2); // First retry
      expect(attempts).toContain(3); // Second retry (success)
    });

    it('should handle job timeouts', async () => {
      const timeoutQueue = createQueue<{ delay: number }>('test-timeout');
      testQueues.push(timeoutQueue);

      let timeoutOccurred = false;

      const worker = createWorker<{ delay: number }, void>(
        'test-timeout',
        async (job) => {
          // Simulate long-running task
          await new Promise(resolve => setTimeout(resolve, job.data.delay));
        },
        {
          settings: {
            stalledInterval: 1000,
            maxStalledCount: 1
          }
        }
      );
      testWorkers.push(worker);

      worker.on('stalled', () => {
        timeoutOccurred = true;
      });

      // Add job that takes longer than stalled interval
      await timeoutQueue.add('timeout-job', { delay: 2000 });

      await new Promise(resolve => setTimeout(resolve, 3000));

      expect(timeoutOccurred).toBe(true);
    });
  });

  describe('Message Flow Integration', () => {
    it('should process complete message flow for all communication types', async () => {
      const incomingQueue = createQueue<IncomingMessage>(QUEUES.INCOMING_MESSAGES);
      const discordQueue = createQueue<OutgoingMessage>(QUEUES.OUTGOING_DISCORD);
      const smsQueue = createQueue<OutgoingMessage>(QUEUES.OUTGOING_SMS);
      const emailQueue = createQueue<OutgoingMessage>(QUEUES.OUTGOING_EMAIL);

      testQueues.push(incomingQueue, discordQueue, smsQueue, emailQueue);

      const processedMessages: string[] = [];
      const sentResponses: { type: string; message: string }[] = [];

      // Capabilities worker
      const capabilitiesWorker = createWorker<IncomingMessage, void>(
        QUEUES.INCOMING_MESSAGES,
        async (job) => {
          const message = job.data;
          processedMessages.push(message.id);

          const response: OutgoingMessage = {
            id: `response-${Date.now()}-${Math.random()}`,
            timestamp: new Date(),
            retryCount: 0,
            source: 'capabilities',
            userId: message.userId,
            message: `Processed: ${message.message}`,
            inReplyTo: message.id,
            metadata: {
              channelId: message.respondTo.channelId,
              phoneNumber: message.respondTo.phoneNumber,
              emailAddress: message.respondTo.emailAddress
            }
          };

          // Route to appropriate queue
          const targetQueue = message.respondTo.type === 'discord' ? discordQueue :
                            message.respondTo.type === 'sms' ? smsQueue : emailQueue;
          
          await targetQueue.add('response', response);
        }
      );
      testWorkers.push(capabilitiesWorker);

      // Communication service workers
      const discordWorker = createWorker<OutgoingMessage, void>(
        QUEUES.OUTGOING_DISCORD,
        async (job) => {
          sentResponses.push({ type: 'discord', message: job.data.message });
        }
      );
      testWorkers.push(discordWorker);

      const smsWorker = createWorker<OutgoingMessage, void>(
        QUEUES.OUTGOING_SMS,
        async (job) => {
          sentResponses.push({ type: 'sms', message: job.data.message });
        }
      );
      testWorkers.push(smsWorker);

      const emailWorker = createWorker<OutgoingMessage, void>(
        QUEUES.OUTGOING_EMAIL,
        async (job) => {
          sentResponses.push({ type: 'email', message: job.data.message });
        }
      );
      testWorkers.push(emailWorker);

      // Send test messages for each communication type
      const testMessages: IncomingMessage[] = [
        {
          id: 'discord-flow-test',
          timestamp: new Date(),
          retryCount: 0,
          source: 'discord',
          userId: 'user-discord',
          message: 'Discord test message',
          respondTo: { type: 'discord', channelId: 'test-channel' }
        },
        {
          id: 'sms-flow-test',
          timestamp: new Date(),
          retryCount: 0,
          source: 'sms',
          userId: 'user-sms',
          message: 'SMS test message',
          respondTo: { type: 'sms', phoneNumber: '+1234567890' }
        },
        {
          id: 'email-flow-test',
          timestamp: new Date(),
          retryCount: 0,
          source: 'email',
          userId: 'user-email',
          message: 'Email test message',
          respondTo: { type: 'email', emailAddress: 'test@example.com' }
        }
      ];

      for (const message of testMessages) {
        await incomingQueue.add('process', message);
      }

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Verify all messages were processed
      expect(processedMessages).toHaveLength(3);
      expect(processedMessages).toContain('discord-flow-test');
      expect(processedMessages).toContain('sms-flow-test');
      expect(processedMessages).toContain('email-flow-test');

      // Verify all responses were sent
      expect(sentResponses).toHaveLength(3);
      
      const discordResponse = sentResponses.find(r => r.type === 'discord');
      const smsResponse = sentResponses.find(r => r.type === 'sms');
      const emailResponse = sentResponses.find(r => r.type === 'email');

      expect(discordResponse?.message).toContain('Processed: Discord test message');
      expect(smsResponse?.message).toContain('Processed: SMS test message');
      expect(emailResponse?.message).toContain('Processed: Email test message');
    });
  });

  describe('Performance and Concurrency', () => {
    it('should handle high-volume message processing', async () => {
      const highVolumeQueue = createQueue<{ messageId: number }>('test-high-volume');
      testQueues.push(highVolumeQueue);

      const processedIds: number[] = [];

      const worker = createWorker<{ messageId: number }, void>(
        'test-high-volume',
        async (job) => {
          // Simulate some processing time
          await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
          processedIds.push(job.data.messageId);
        }
      );
      testWorkers.push(worker);

      // Add 100 jobs quickly
      const jobPromises = [];
      for (let i = 1; i <= 100; i++) {
        jobPromises.push(highVolumeQueue.add(`job-${i}`, { messageId: i }));
      }
      await Promise.all(jobPromises);

      // Wait for all jobs to process
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Should process all 100 messages
      expect(processedIds).toHaveLength(100);
      
      // Should have all message IDs from 1 to 100
      const sortedIds = processedIds.sort((a, b) => a - b);
      expect(sortedIds[0]).toBe(1);
      expect(sortedIds[99]).toBe(100);
    });

    it('should handle concurrent workers on the same queue', async () => {
      const concurrentQueue = createQueue<{ workerId: string; delay: number }>('test-concurrent');
      testQueues.push(concurrentQueue);

      const results: { workerId: string; jobId: string }[] = [];

      // Create 3 workers for the same queue
      for (let i = 1; i <= 3; i++) {
        const worker = createWorker<{ workerId: string; delay: number }, void>(
          'test-concurrent',
          async (job) => {
            await new Promise(resolve => setTimeout(resolve, job.data.delay));
            results.push({ workerId: `worker-${i}`, jobId: job.id! });
          }
        );
        testWorkers.push(worker);
      }

      // Add 10 jobs
      for (let i = 1; i <= 10; i++) {
        await concurrentQueue.add(`concurrent-job-${i}`, { 
          workerId: `job-${i}`, 
          delay: Math.random() * 100 
        });
      }

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Should process all 10 jobs
      expect(results).toHaveLength(10);
      
      // Should have jobs processed by different workers
      const workerIds = [...new Set(results.map(r => r.workerId))];
      expect(workerIds.length).toBeGreaterThan(1);
    });
  });

  describe('Queue Monitoring and Stats', () => {
    it('should provide accurate job counts and statistics', async () => {
      const statsQueue = createQueue<{ status: string }>('test-stats');
      testQueues.push(statsQueue);

      let processedCount = 0;
      let failedCount = 0;

      const worker = createWorker<{ status: string }, void>(
        'test-stats',
        async (job) => {
          if (job.data.status === 'fail') {
            failedCount++;
            throw new Error('Intentional failure');
          }
          processedCount++;
        }
      );
      testWorkers.push(worker);

      // Add mix of successful and failing jobs
      await statsQueue.add('success-1', { status: 'success' });
      await statsQueue.add('success-2', { status: 'success' });
      await statsQueue.add('fail-1', { status: 'fail' });
      await statsQueue.add('success-3', { status: 'success' });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 1000));

      const jobCounts = await statsQueue.getJobCounts();
      
      expect(processedCount).toBe(3); // 3 successful jobs
      expect(failedCount).toBeGreaterThan(0); // At least 1 failed job
      expect(jobCounts.completed).toBeGreaterThanOrEqual(3);
    });
  });

  describe('Data Integrity and Serialization', () => {
    it('should preserve complex data types through queue serialization', async () => {
      interface ComplexData {
        timestamp: Date;
        nested: {
          array: number[];
          object: { key: string; value: boolean };
        };
        metadata?: Record<string, any>;
      }

      const complexQueue = createQueue<ComplexData>('test-complex-data');
      testQueues.push(complexQueue);

      let receivedData: ComplexData | null = null;

      const worker = createWorker<ComplexData, void>(
        'test-complex-data',
        async (job) => {
          receivedData = job.data;
        }
      );
      testWorkers.push(worker);

      const originalData: ComplexData = {
        timestamp: new Date('2023-01-01T12:00:00Z'),
        nested: {
          array: [1, 2, 3, 4, 5],
          object: { key: 'test-key', value: true }
        },
        metadata: {
          source: 'test',
          tags: ['tag1', 'tag2'],
          config: { enabled: true, retries: 3 }
        }
      };

      await complexQueue.add('complex-job', originalData);

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(receivedData).toBeTruthy();
      expect(receivedData!.nested.array).toEqual([1, 2, 3, 4, 5]);
      expect(receivedData!.nested.object.key).toBe('test-key');
      expect(receivedData!.nested.object.value).toBe(true);
      expect(receivedData!.metadata?.source).toBe('test');
      expect(receivedData!.metadata?.tags).toEqual(['tag1', 'tag2']);
      expect(receivedData!.metadata?.config.enabled).toBe(true);
    });
  });
});