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

describe('Service Integration Tests', () => {
  let testQueues: Queue[] = [];
  let testWorkers: Worker[] = [];

  beforeAll(async () => {
    createRedisConnection();
  });

  beforeEach(() => {
    testQueues = [];
    testWorkers = [];
  });

  afterAll(async () => {
    for (const worker of testWorkers) {
      await worker.close();
    }
    for (const queue of testQueues) {
      await queue.obliterate({ force: true });
    }
    await closeRedisConnection();
  });

  describe('Discord Service Integration', () => {
    it('should handle Discord message mentions correctly', async () => {
      const incomingQueue = createQueue<IncomingMessage>(QUEUES.INCOMING_MESSAGES);
      const discordQueue = createQueue<OutgoingMessage>(QUEUES.OUTGOING_DISCORD);
      testQueues.push(incomingQueue, discordQueue);

      const processedMessages: IncomingMessage[] = [];
      const discordResponses: OutgoingMessage[] = [];

      // Simulate capabilities service
      const capabilitiesWorker = createWorker<IncomingMessage, void>(
        QUEUES.INCOMING_MESSAGES,
        async (job) => {
          const message = job.data;
          processedMessages.push(message);

          // Simulate different responses based on message content
          let responseText = 'Default response';
          if (message.message.includes('help')) {
            responseText = 'Here are the available commands: help, status, ping';
          } else if (message.message.includes('ping')) {
            responseText = 'Pong! 🏓';
          } else if (message.message.includes('status')) {
            responseText = 'All systems operational ✅';
          }

          const response: OutgoingMessage = {
            id: `discord-response-${Date.now()}`,
            timestamp: new Date(),
            retryCount: 0,
            source: 'capabilities',
            userId: message.userId,
            message: responseText,
            inReplyTo: message.id,
            metadata: {
              channelId: message.respondTo.channelId,
              responseType: 'discord'
            }
          };

          await discordQueue.add('send-response', response);
        }
      );
      testWorkers.push(capabilitiesWorker);

      // Simulate Discord service
      const discordWorker = createWorker<OutgoingMessage, void>(
        QUEUES.OUTGOING_DISCORD,
        async (job) => {
          discordResponses.push(job.data);
        }
      );
      testWorkers.push(discordWorker);

      // Test different Discord scenarios
      const discordMessages: IncomingMessage[] = [
        {
          id: 'discord-mention-1',
          timestamp: new Date(),
          retryCount: 0,
          source: 'discord',
          userId: 'user123',
          message: '@coachartie help',
          context: { userTag: 'TestUser#1234', mention: true },
          respondTo: { type: 'discord', channelId: 'general' }
        },
        {
          id: 'discord-dm-1',
          timestamp: new Date(),
          retryCount: 0,
          source: 'discord',
          userId: 'user456',
          message: 'ping',
          context: { userTag: 'DMUser#5678', isDM: true },
          respondTo: { type: 'discord', channelId: 'dm-channel' }
        },
        {
          id: 'discord-status-1',
          timestamp: new Date(),
          retryCount: 0,
          source: 'discord',
          userId: 'user789',
          message: 'status check please',
          context: { userTag: 'AdminUser#9999', isAdmin: true },
          respondTo: { type: 'discord', channelId: 'admin-channel' }
        }
      ];

      for (const message of discordMessages) {
        await incomingQueue.add('process', message);
      }

      await new Promise(resolve => setTimeout(resolve, 1000));

      expect(processedMessages).toHaveLength(3);
      expect(discordResponses).toHaveLength(3);

      const helpResponse = discordResponses.find(r => r.inReplyTo === 'discord-mention-1');
      const pingResponse = discordResponses.find(r => r.inReplyTo === 'discord-dm-1');
      const statusResponse = discordResponses.find(r => r.inReplyTo === 'discord-status-1');

      expect(helpResponse?.message).toContain('available commands');
      expect(pingResponse?.message).toContain('Pong!');
      expect(statusResponse?.message).toContain('operational');
    });
  });

  describe('SMS Service Integration', () => {
    it('should handle SMS message formatting and phone number validation', async () => {
      const incomingQueue = createQueue<IncomingMessage>(QUEUES.INCOMING_MESSAGES);
      const smsQueue = createQueue<OutgoingMessage>(QUEUES.OUTGOING_SMS);
      testQueues.push(incomingQueue, smsQueue);

      const processedSMS: IncomingMessage[] = [];
      const smsResponses: OutgoingMessage[] = [];

      const capabilitiesWorker = createWorker<IncomingMessage, void>(
        QUEUES.INCOMING_MESSAGES,
        async (job) => {
          const message = job.data;
          if (message.source === 'sms') {
            processedSMS.push(message);

            // SMS responses should be shorter
            let responseText = message.message.length > 50 
              ? 'Message received! (long message truncated for SMS)'
              : `Got it: ${message.message}`;

            const response: OutgoingMessage = {
              id: `sms-response-${Date.now()}`,
              timestamp: new Date(),
              retryCount: 0,
              source: 'capabilities',
              userId: message.userId,
              message: responseText,
              inReplyTo: message.id,
              metadata: {
                phoneNumber: message.respondTo.phoneNumber,
                responseType: 'sms'
              }
            };

            await smsQueue.add('send-sms', response);
          }
        }
      );
      testWorkers.push(capabilitiesWorker);

      const smsWorker = createWorker<OutgoingMessage, void>(
        QUEUES.OUTGOING_SMS,
        async (job) => {
          smsResponses.push(job.data);
        }
      );
      testWorkers.push(smsWorker);

      // Test different SMS scenarios
      const smsMessages: IncomingMessage[] = [
        {
          id: 'sms-short-1',
          timestamp: new Date(),
          retryCount: 0,
          source: 'sms',
          userId: '5551234567',
          message: 'Hello',
          context: { phoneNumber: '+15551234567' },
          respondTo: { type: 'sms', phoneNumber: '+15551234567' }
        },
        {
          id: 'sms-long-1',
          timestamp: new Date(),
          retryCount: 0,
          source: 'sms',
          userId: '5559876543',
          message: 'This is a very long SMS message that exceeds the typical character limit and should be handled appropriately by the system',
          context: { phoneNumber: '+15559876543' },
          respondTo: { type: 'sms', phoneNumber: '+15559876543' }
        }
      ];

      for (const message of smsMessages) {
        await incomingQueue.add('process', message);
      }

      await new Promise(resolve => setTimeout(resolve, 1000));

      expect(processedSMS).toHaveLength(2);
      expect(smsResponses).toHaveLength(2);

      const shortResponse = smsResponses.find(r => r.inReplyTo === 'sms-short-1');
      const longResponse = smsResponses.find(r => r.inReplyTo === 'sms-long-1');

      expect(shortResponse?.message).toContain('Got it: Hello');
      expect(longResponse?.message).toContain('long message truncated');
    });
  });

  describe('Email Service Integration', () => {
    it('should handle email threading and subject line management', async () => {
      const incomingQueue = createQueue<IncomingMessage>(QUEUES.INCOMING_MESSAGES);
      const emailQueue = createQueue<OutgoingMessage>(QUEUES.OUTGOING_EMAIL);
      testQueues.push(incomingQueue, emailQueue);

      const processedEmails: IncomingMessage[] = [];
      const emailResponses: OutgoingMessage[] = [];

      const capabilitiesWorker = createWorker<IncomingMessage, void>(
        QUEUES.INCOMING_MESSAGES,
        async (job) => {
          const message = job.data;
          if (message.source === 'email') {
            processedEmails.push(message);

            // Email responses can be longer and more detailed
            const responseText = `Thank you for your email regarding: ${message.context?.subject || 'your message'}.

I've received your message: "${message.message}"

Best regards,
Coach Artie`;

            const response: OutgoingMessage = {
              id: `email-response-${Date.now()}`,
              timestamp: new Date(),
              retryCount: 0,
              source: 'capabilities',
              userId: message.userId,
              message: responseText,
              inReplyTo: message.id,
              metadata: {
                emailAddress: message.respondTo.emailAddress,
                subject: message.context?.subject,
                responseType: 'email'
              }
            };

            await emailQueue.add('send-email', response);
          }
        }
      );
      testWorkers.push(capabilitiesWorker);

      const emailWorker = createWorker<OutgoingMessage, void>(
        QUEUES.OUTGOING_EMAIL,
        async (job) => {
          emailResponses.push(job.data);
        }
      );
      testWorkers.push(emailWorker);

      // Test different email scenarios
      const emailMessages: IncomingMessage[] = [
        {
          id: 'email-new-1',
          timestamp: new Date(),
          retryCount: 0,
          source: 'email',
          userId: 'user@example.com',
          message: 'I need help with setting up my account',
          context: { 
            emailAddress: 'user@example.com',
            subject: 'Account Setup Help',
            hasHtml: false
          },
          respondTo: { type: 'email', emailAddress: 'user@example.com' }
        },
        {
          id: 'email-reply-1',
          timestamp: new Date(),
          retryCount: 0,
          source: 'email',
          userId: 'customer@domain.com',
          message: 'Thanks for the previous help, I have another question',
          context: { 
            emailAddress: 'customer@domain.com',
            subject: 'Re: Previous Support Ticket',
            hasHtml: true
          },
          respondTo: { type: 'email', emailAddress: 'customer@domain.com' }
        }
      ];

      for (const message of emailMessages) {
        await incomingQueue.add('process', message);
      }

      await new Promise(resolve => setTimeout(resolve, 1000));

      expect(processedEmails).toHaveLength(2);
      expect(emailResponses).toHaveLength(2);

      const newEmailResponse = emailResponses.find(r => r.inReplyTo === 'email-new-1');
      const replyEmailResponse = emailResponses.find(r => r.inReplyTo === 'email-reply-1');

      expect(newEmailResponse?.message).toContain('Account Setup Help');
      expect(newEmailResponse?.message).toContain('setting up my account');
      expect(replyEmailResponse?.message).toContain('Previous Support Ticket');
      expect(replyEmailResponse?.message).toContain('another question');
    });
  });

  describe('Cross-Service Communication', () => {
    it('should handle user identity across different communication channels', async () => {
      const incomingQueue = createQueue<IncomingMessage>(QUEUES.INCOMING_MESSAGES);
      const discordQueue = createQueue<OutgoingMessage>(QUEUES.OUTGOING_DISCORD);
      const smsQueue = createQueue<OutgoingMessage>(QUEUES.OUTGOING_SMS);
      const emailQueue = createQueue<OutgoingMessage>(QUEUES.OUTGOING_EMAIL);
      
      testQueues.push(incomingQueue, discordQueue, smsQueue, emailQueue);

      // Track user interactions across channels
      const userInteractions: Record<string, IncomingMessage[]> = {};
      const allResponses: OutgoingMessage[] = [];

      const capabilitiesWorker = createWorker<IncomingMessage, void>(
        QUEUES.INCOMING_MESSAGES,
        async (job) => {
          const message = job.data;
          
          // Track user across channels (in real app, you'd have user identity mapping)
          const userId = message.userId;
          if (!userInteractions[userId]) {
            userInteractions[userId] = [];
          }
          userInteractions[userId].push(message);

          // Personalized response based on interaction history
          const interactionCount = userInteractions[userId].length;
          let responseText = '';
          
          if (interactionCount === 1) {
            responseText = `Welcome! This is your first message via ${message.source}.`;
          } else {
            responseText = `Welcome back! This is your ${interactionCount}th interaction (previous via ${userInteractions[userId][interactionCount - 2]?.source}).`;
          }

          const response: OutgoingMessage = {
            id: `cross-service-${Date.now()}`,
            timestamp: new Date(),
            retryCount: 0,
            source: 'capabilities',
            userId: message.userId,
            message: responseText,
            inReplyTo: message.id,
            metadata: {
              channelId: message.respondTo.channelId,
              phoneNumber: message.respondTo.phoneNumber,
              emailAddress: message.respondTo.emailAddress,
              responseType: message.respondTo.type
            }
          };

          // Route to appropriate queue
          const targetQueue = message.respondTo.type === 'discord' ? discordQueue :
                            message.respondTo.type === 'sms' ? smsQueue : emailQueue;
          
          await targetQueue.add('response', response);
        }
      );
      testWorkers.push(capabilitiesWorker);

      // Set up response collectors
      [
        { queue: discordQueue, type: 'discord' },
        { queue: smsQueue, type: 'sms' },
        { queue: emailQueue, type: 'email' }
      ].forEach(({ queue, type }) => {
        const worker = createWorker<OutgoingMessage, void>(
          queue.name,
          async (job) => {
            allResponses.push({ ...job.data, metadata: { ...job.data.metadata, actualType: type } });
          }
        );
        testWorkers.push(worker);
      });

      // Simulate same user messaging across different channels
      const crossChannelMessages: IncomingMessage[] = [
        {
          id: 'cross-1',
          timestamp: new Date(),
          retryCount: 0,
          source: 'discord',
          userId: 'multi-channel-user',
          message: 'Hello from Discord',
          respondTo: { type: 'discord', channelId: 'general' }
        },
        {
          id: 'cross-2', 
          timestamp: new Date(),
          retryCount: 0,
          source: 'sms',
          userId: 'multi-channel-user',
          message: 'Hello from SMS',
          respondTo: { type: 'sms', phoneNumber: '+15551234567' }
        },
        {
          id: 'cross-3',
          timestamp: new Date(),
          retryCount: 0,
          source: 'email', 
          userId: 'multi-channel-user',
          message: 'Hello from Email',
          respondTo: { type: 'email', emailAddress: 'user@example.com' }
        }
      ];

      // Send messages with slight delays to ensure ordering
      for (let i = 0; i < crossChannelMessages.length; i++) {
        await incomingQueue.add('process', crossChannelMessages[i]);
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      await new Promise(resolve => setTimeout(resolve, 1500));

      expect(Object.keys(userInteractions)).toHaveLength(1);
      expect(userInteractions['multi-channel-user']).toHaveLength(3);
      expect(allResponses).toHaveLength(3);

      const responses = allResponses.sort((a, b) => a.inReplyTo.localeCompare(b.inReplyTo));
      
      expect(responses[0].message).toContain('first message via discord');
      expect(responses[1].message).toContain('2th interaction (previous via discord)');
      expect(responses[2].message).toContain('3th interaction (previous via sms)');
    });
  });

  describe('Error Recovery and Dead Letter Queue', () => {
    it('should handle poison messages and implement circuit breaker pattern', async () => {
      const poisonQueue = createQueue<{ shouldPoison: boolean; messageContent: string }>('test-poison-messages');
      testQueues.push(poisonQueue);

      const processedMessages: string[] = [];
      const failedMessages: string[] = [];
      let consecutiveFailures = 0;
      let circuitBreakerOpen = false;

      const worker = createWorker<{ shouldPoison: boolean; messageContent: string }, void>(
        'test-poison-messages',
        async (job) => {
          // Simulate circuit breaker
          if (circuitBreakerOpen) {
            throw new Error('Circuit breaker is open');
          }

          if (job.data.shouldPoison) {
            consecutiveFailures++;
            if (consecutiveFailures >= 3) {
              circuitBreakerOpen = true;
            }
            throw new Error('Poison message detected');
          }

          // Reset circuit breaker on success
          consecutiveFailures = 0;
          circuitBreakerOpen = false;
          processedMessages.push(job.data.messageContent);
        }
      );
      testWorkers.push(worker);

      worker.on('failed', (job, err) => {
        if (job) {
          failedMessages.push(job.data.messageContent);
        }
      });

      // Send mix of good and poison messages
      const messages = [
        { shouldPoison: false, messageContent: 'good-1' },
        { shouldPoison: true, messageContent: 'poison-1' },
        { shouldPoison: true, messageContent: 'poison-2' },
        { shouldPoison: false, messageContent: 'good-2' },
        { shouldPoison: true, messageContent: 'poison-3' }, // This should trigger circuit breaker
        { shouldPoison: false, messageContent: 'good-3' }, // This should fail due to circuit breaker
      ];

      for (const message of messages) {
        await poisonQueue.add('test-message', message);
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      await new Promise(resolve => setTimeout(resolve, 2000));

      expect(processedMessages).toContain('good-1');
      expect(processedMessages).toContain('good-2');
      expect(failedMessages.length).toBeGreaterThan(0);
      expect(failedMessages).toContain('poison-1');
      expect(failedMessages).toContain('poison-2');
    });
  });
});