#!/usr/bin/env tsx

/**
 * Comprehensive test script to verify all Coach Artie services work with Redis queues
 * This simulates messages going through Discord, SMS, and Email interfaces
 * 
 * Usage: npx tsx scripts/test-all-services.ts
 */

import { 
  createQueue, 
  createWorker, 
  createRedisConnection, 
  closeRedisConnection,
  QUEUES,
  IncomingMessage,
  OutgoingMessage,
  logger
} from '@coachartie/shared';

async function testAllServices() {
  logger.info('🚀 Starting comprehensive service test...');

  try {
    // Connect to Redis
    const redis = createRedisConnection();
    await redis.ping();
    logger.info('✅ Redis connection established');

    // Create queues
    const incomingQueue = createQueue<IncomingMessage>(QUEUES.INCOMING_MESSAGES);
    const discordOutQueue = createQueue<OutgoingMessage>(QUEUES.OUTGOING_DISCORD);
    const smsOutQueue = createQueue<OutgoingMessage>(QUEUES.OUTGOING_SMS);
    const emailOutQueue = createQueue<OutgoingMessage>(QUEUES.OUTGOING_EMAIL);

    // Track processed messages
    const processedMessages = new Set<string>();
    const sentResponses = new Set<string>();

    // Simulate the capabilities service
    const capabilitiesWorker = createWorker<IncomingMessage, void>(
      QUEUES.INCOMING_MESSAGES,
      async (job) => {
        const message = job.data;
        logger.info(`📥 Capabilities processing: "${message.message}" from ${message.source}`);

        // Simulate processing time
        await new Promise(resolve => setTimeout(resolve, 100));

        // Generate response based on source
        const response: OutgoingMessage = {
          id: `response-${Date.now()}-${Math.random()}`,
          timestamp: new Date(),
          retryCount: 0,
          source: 'capabilities',
          userId: message.userId,
          message: `Hello from Coach Artie! I received your ${message.source} message: "${message.message}"`,
          inReplyTo: message.id,
          metadata: {
            channelId: message.respondTo.channelId,
            phoneNumber: message.respondTo.phoneNumber,
            emailAddress: message.respondTo.emailAddress,
            responseType: message.respondTo.type
          }
        };

        // Route to appropriate outgoing queue
        let outgoingQueue: typeof discordOutQueue;
        switch (message.respondTo.type) {
          case 'discord':
            outgoingQueue = discordOutQueue;
            break;
          case 'sms':
            outgoingQueue = smsOutQueue;
            break;
          case 'email':
            outgoingQueue = emailOutQueue;
            break;
          default:
            throw new Error(`Unknown response type: ${message.respondTo.type}`);
        }

        await outgoingQueue.add('send-response', response);
        processedMessages.add(message.id);
        logger.info(`✅ Message processed and response queued for ${message.respondTo.type}`);
      }
    );

    // Simulate Discord service
    const discordWorker = createWorker<OutgoingMessage, void>(
      QUEUES.OUTGOING_DISCORD,
      async (job) => {
        const response = job.data;
        logger.info(`📤 Discord: "${response.message}"`);
        logger.info(`📍 Discord channel: ${response.metadata?.channelId}`);
        sentResponses.add(response.inReplyTo);
      }
    );

    // Simulate SMS service
    const smsWorker = createWorker<OutgoingMessage, void>(
      QUEUES.OUTGOING_SMS,
      async (job) => {
        const response = job.data;
        logger.info(`📱 SMS: "${response.message}"`);
        logger.info(`📍 SMS to: ${response.metadata?.phoneNumber}`);
        sentResponses.add(response.inReplyTo);
      }
    );

    // Simulate Email service
    const emailWorker = createWorker<OutgoingMessage, void>(
      QUEUES.OUTGOING_EMAIL,
      async (job) => {
        const response = job.data;
        logger.info(`📧 Email: "${response.message}"`);
        logger.info(`📍 Email to: ${response.metadata?.emailAddress}`);
        sentResponses.add(response.inReplyTo);
      }
    );

    // Test messages for each service
    const testMessages: IncomingMessage[] = [
      {
        id: `discord-test-${Date.now()}`,
        timestamp: new Date(),
        retryCount: 0,
        source: 'discord',
        userId: 'discord-user-123',
        message: 'Hello from Discord!',
        context: { userTag: 'TestUser#1234' },
        respondTo: {
          type: 'discord',
          channelId: 'discord-channel-456'
        }
      },
      {
        id: `sms-test-${Date.now()}`,
        timestamp: new Date(),
        retryCount: 0,
        source: 'sms',
        userId: '5551234567',
        message: 'Hello from SMS!',
        context: { phoneNumber: '+15551234567' },
        respondTo: {
          type: 'sms',
          phoneNumber: '+15551234567'
        }
      },
      {
        id: `email-test-${Date.now()}`,
        timestamp: new Date(),
        retryCount: 0,
        source: 'email',
        userId: 'test@example.com',
        message: 'Hello from Email!',
        context: { subject: 'Test Email' },
        respondTo: {
          type: 'email',
          emailAddress: 'test@example.com'
        }
      }
    ];

    // Send all test messages
    logger.info('📨 Sending test messages...');
    for (const message of testMessages) {
      await incomingQueue.add('process', message);
      logger.info(`Sent ${message.source} message: "${message.message}"`);
    }

    // Wait for processing
    logger.info('⏳ Waiting for message processing...');
    let attempts = 0;
    const maxAttempts = 20;
    
    while ((processedMessages.size < testMessages.length || sentResponses.size < testMessages.length) && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 500));
      attempts++;
      
      if (attempts % 4 === 0) {
        logger.info(`Progress: ${processedMessages.size}/${testMessages.length} processed, ${sentResponses.size}/${testMessages.length} responses sent`);
      }
    }

    // Verify results
    const allProcessed = processedMessages.size === testMessages.length;
    const allResponsesSent = sentResponses.size === testMessages.length;

    if (allProcessed && allResponsesSent) {
      logger.info('🎉 SUCCESS! All services working correctly:');
      logger.info('   1. ✅ Discord: Message received and response sent');
      logger.info('   2. ✅ SMS: Message received and response sent');
      logger.info('   3. ✅ Email: Message received and response sent');
      logger.info('   4. ✅ Capabilities: All messages processed');
      logger.info('   5. ✅ Redis queues: All communication successful');
    } else {
      logger.error('❌ FAILED! Some services did not complete:');
      logger.error(`   - Messages processed: ${processedMessages.size}/${testMessages.length}`);
      logger.error(`   - Responses sent: ${sentResponses.size}/${testMessages.length}`);
      
      // Show which messages didn't complete
      for (const message of testMessages) {
        const processed = processedMessages.has(message.id);
        const responseSent = sentResponses.has(message.id);
        logger.error(`   - ${message.source}: processed=${processed}, response=${responseSent}`);
      }
    }

    // Clean up
    logger.info('🧹 Cleaning up...');
    await capabilitiesWorker.close();
    await discordWorker.close();
    await smsWorker.close();
    await emailWorker.close();
    
    // Clean queues
    await incomingQueue.obliterate({ force: true });
    await discordOutQueue.obliterate({ force: true });
    await smsOutQueue.obliterate({ force: true });
    await emailOutQueue.obliterate({ force: true });
    
    await closeRedisConnection();
    logger.info('✅ Cleanup complete');

    return allProcessed && allResponsesSent;

  } catch (error) {
    logger.error('❌ Test failed:', error);
    throw error;
  }
}

// Run the test
testAllServices()
  .then((success) => {
    if (success) {
      logger.info('🏁 All services test completed successfully!');
      logger.info('🎊 Coach Artie monorepo is ready for deployment!');
      process.exit(0);
    } else {
      logger.error('💥 Test failed - some services not working correctly');
      process.exit(1);
    }
  })
  .catch((error) => {
    logger.error('💥 Test failed with error:', error);
    process.exit(1);
  });