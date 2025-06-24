#!/usr/bin/env tsx

/**
 * Test script to verify the Redis queue flow works correctly
 * This simulates a message going from Discord -> Capabilities -> Discord
 * 
 * Usage: npx tsx scripts/test-queue-flow.ts
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
} from '../packages/shared/dist/index.js';

async function testQueueFlow() {
  logger.info('🚀 Starting queue flow test...');

  try {
    // Connect to Redis
    const redis = createRedisConnection();
    await redis.ping();
    logger.info('✅ Redis connection established');

    // Create queues
    const incomingQueue = createQueue<IncomingMessage>(QUEUES.INCOMING_MESSAGES);
    const outgoingQueue = createQueue<OutgoingMessage>(QUEUES.OUTGOING_DISCORD);

    let messageProcessed = false;
    let responseReceived = false;

    // Simulate the capabilities service
    const capabilitiesWorker = createWorker<IncomingMessage, void>(
      QUEUES.INCOMING_MESSAGES,
      async (job) => {
        const message = job.data;
        logger.info(`📥 Capabilities processing: "${message.message}"`);

        // Simulate processing time
        await new Promise(resolve => setTimeout(resolve, 100));

        // Generate response
        const response: OutgoingMessage = {
          id: `response-${Date.now()}`,
          timestamp: new Date(),
          retryCount: 0,
          source: 'capabilities',
          userId: message.userId,
          message: `Hello! I received your message: "${message.message}"`,
          inReplyTo: message.id,
          metadata: {
            channelId: message.respondTo.channelId,
            responseType: 'discord'
          }
        };

        await outgoingQueue.add('send-response', response);
        messageProcessed = true;
        logger.info('✅ Message processed and response queued');
      }
    );

    // Simulate the Discord service
    const discordWorker = createWorker<OutgoingMessage, void>(
      QUEUES.OUTGOING_DISCORD,
      async (job) => {
        const response = job.data;
        logger.info(`📤 Discord would send: "${response.message}"`);
        logger.info(`📍 To channel: ${response.metadata?.channelId}`);
        responseReceived = true;
      }
    );

    // Send a test message
    const testMessage: IncomingMessage = {
      id: `test-${Date.now()}`,
      timestamp: new Date(),
      retryCount: 0,
      source: 'discord',
      userId: 'test-user-123',
      message: 'Hello, Coach Artie!',
      context: {
        userTag: 'TestUser#1234'
      },
      respondTo: {
        type: 'discord',
        channelId: 'test-channel-456'
      }
    };

    logger.info(`📨 Sending test message: "${testMessage.message}"`);
    await incomingQueue.add('process', testMessage);

    // Wait for processing
    logger.info('⏳ Waiting for message processing...');
    let attempts = 0;
    while ((!messageProcessed || !responseReceived) && attempts < 10) {
      await new Promise(resolve => setTimeout(resolve, 500));
      attempts++;
    }

    if (messageProcessed && responseReceived) {
      logger.info('🎉 SUCCESS! Message flow completed:');
      logger.info('   1. ✅ Message sent to capabilities queue');
      logger.info('   2. ✅ Capabilities processed message');
      logger.info('   3. ✅ Response sent to Discord queue');
      logger.info('   4. ✅ Discord received response');
    } else {
      logger.error('❌ FAILED! Message flow incomplete:');
      logger.error(`   - Message processed: ${messageProcessed}`);
      logger.error(`   - Response received: ${responseReceived}`);
    }

    // Clean up
    logger.info('🧹 Cleaning up...');
    await capabilitiesWorker.close();
    await discordWorker.close();
    
    // Clean queues
    await incomingQueue.obliterate({ force: true });
    await outgoingQueue.obliterate({ force: true });
    
    await closeRedisConnection();
    logger.info('✅ Cleanup complete');

  } catch (error) {
    logger.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Run the test
testQueueFlow()
  .then(() => {
    logger.info('🏁 Test completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('💥 Test failed with error:', error);
    process.exit(1);
  });