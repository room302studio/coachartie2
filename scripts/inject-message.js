#!/usr/bin/env node

const path = require('path');
const { Queue } = require(path.join(__dirname, '../node_modules/.pnpm/bullmq@5.56.1/node_modules/bullmq'));

const incomingQueue = new Queue('coachartie-messages-incoming', {
  connection: {
    host: 'localhost',
    port: 47320,
  },
});

async function injectMessage() {
  const message = {
    id: `test-${Date.now()}`,
    message: 'Hey Artie! You have 3,577 real memories in your brain now. Use the http capability to explore them: First, query http://brain:47325/api/stats/memory-users?limit=5 to see who you talk to most. Then search for interesting memories about "weird" topics using http://brain:47325/api/memories/search?q=weird&limit=5. Finally, tell me a SPECIFIC story from those memories that reveals something unexpected about your personality or our relationship. Don\'t be generic - cite actual memory content with details!',
    source: 'api',
    userId: 'ejfox',
    respondTo: {
      type: 'api',
      apiResponseId: `test-response-${Date.now()}`
    },
    context: {
      platform: 'terminal',
      userId: 'ejfox'
    }
  };

  console.log('📤 Injecting message into queue...');
  console.log('Message:', message.message);
  console.log('');

  const job = await incomingQueue.add('process-message', message);
  console.log(`✅ Message queued with job ID: ${job.id}`);
  console.log('');
  console.log('💡 Check the capabilities logs to see Artie\'s response:');
  console.log('   docker-compose logs -f capabilities');

  await incomingQueue.close();
  process.exit(0);
}

injectMessage().catch((error) => {
  console.error('❌ Error injecting message:', error);
  process.exit(1);
});
