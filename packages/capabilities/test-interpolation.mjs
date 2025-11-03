import { Queue } from 'bullmq';
import Redis from 'ioredis';

async function testInterpolation() {
  const connection = new Redis({
    host: 'localhost',
    port: 47320,
    maxRetriesPerRequest: null,
  });

  const queue = new Queue('coachartie-messages-incoming', { connection });

  console.log('📤 Sending test message with variable interpolation...');
  console.log('   Variable "animal" is already set to "cat"');
  console.log('   Message contains: "I need to buy food for my ${animal}"');
  console.log('   Expected interpolation: "I need to buy food for my cat"');

  await queue.add('test-interpolation', {
    id: `test-interp-${Date.now()}`,
    userId: 'test-CORRECT-user',
    message: 'Store this important fact in memory: I need to buy food for my ${animal}',
    timestamp: new Date(),
    retryCount: 0,
    source: 'test',
    respondTo: { type: 'api' }
  });

  console.log('✅ Message queued! Watch for:');
  console.log('   1. LLM extracting memory:remember capability');
  console.log('   2. 🔗 Interpolated log showing ${animal} → cat');
  console.log('   3. Memory stored with "cat" not "${animal}"');

  await connection.quit();
  process.exit(0);
}

testInterpolation().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
