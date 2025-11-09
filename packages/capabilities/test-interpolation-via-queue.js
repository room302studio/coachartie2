const { Queue } = require('bullmq');
const Redis = require('ioredis');

async function testInterpolation() {
  const connection = new Redis({
    host: 'localhost',
    port: 47320,
    maxRetriesPerRequest: null,
  });

  const queue = new Queue('coachartie-messages-incoming', { connection });

  console.log('📤 Sending test message with variable interpolation...');

  await queue.add('test-interpolation', {
    id: `test-interp-${Date.now()}`,
    userId: 'test-CORRECT-user',
    message: 'Store this important fact in memory: I need to buy food for my ${animal}',
    timestamp: new Date(),
    retryCount: 0,
    source: 'test',
    respondTo: { type: 'api' },
  });

  console.log(
    '✅ Message sent! LLM should extract memory capability with ${animal} in the content'
  );
  console.log('   The Handlebars interpolation should replace ${animal} with "cat"');

  await connection.quit();
  process.exit(0);
}

testInterpolation().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});
