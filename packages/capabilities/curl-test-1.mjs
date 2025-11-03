import { Queue } from 'bullmq';
import Redis from 'ioredis';

const USER_ID = `curl-test-1-${Date.now()}`;

async function test1() {
  const connection = new Redis({ host: 'localhost', port: 47320, maxRetriesPerRequest: null });
  const queue = new Queue('coachartie-messages-incoming', { connection });

  console.log('============================================');
  console.log('TEST 1: Memory Content Interpolation');
  console.log('============================================\n');
  console.log(`📝 User ID: ${USER_ID}\n`);

  // Step 1: Set variable
  console.log('STEP 1: Setting variable "city" to "Tokyo"...');
  await queue.add('set-city', {
    id: `set-city-${USER_ID}`,
    userId: USER_ID,
    message: 'Set city to Tokyo',
    timestamp: new Date(),
    retryCount: 0,
    source: 'curl-test',
    respondTo: { type: 'api' }
  });
  console.log('✅ Set variable message queued');
  console.log('⏳ Waiting 6 seconds...\n');
  await new Promise(r => setTimeout(r, 6000));

  // Step 2: Use variable
  console.log('STEP 2: Storing memory with ${city} interpolation...');
  await queue.add('use-city', {
    id: `use-city-${USER_ID}`,
    userId: USER_ID,
    message: 'Remember: I am traveling to ${city} next month',
    timestamp: new Date(),
    retryCount: 0,
    source: 'curl-test',
    respondTo: { type: 'api' }
  });
  console.log('✅ Memory message queued');
  console.log('⏳ Waiting 8 seconds...\n');
  await new Promise(r => setTimeout(r, 8000));

  await connection.quit();

  console.log('\n✅ TEST 1 MESSAGES SENT');
  console.log('Check logs with: docker-compose logs --since 30s capabilities | grep -E "Set variable city|Interpolated.*city|traveling to Tokyo"');
  process.exit(0);
}

test1().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
