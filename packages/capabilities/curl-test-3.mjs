import { Queue } from 'bullmq';
import Redis from 'ioredis';

const USER_ID = `curl-test-3-${Date.now()}`;

async function test3() {
  const connection = new Redis({ host: 'localhost', port: 47320, maxRetriesPerRequest: null });
  const queue = new Queue('coachartie-messages-incoming', { connection });

  console.log('============================================');
  console.log('TEST 3: Handlebars {{syntax}} Interpolation');
  console.log('============================================\n');
  console.log(`📝 User ID: ${USER_ID}\n`);

  // Step 1: Set variable
  console.log('STEP 1: Setting variable "weather" to "sunny"...');
  await queue.add('set-weather', {
    id: `set-weather-${USER_ID}`,
    userId: USER_ID,
    message: 'Set weather to sunny',
    timestamp: new Date(),
    retryCount: 0,
    source: 'curl-test',
    respondTo: { type: 'api' }
  });
  console.log('✅ Set variable message queued');
  console.log('⏳ Waiting 6 seconds...\n');
  await new Promise(r => setTimeout(r, 6000));

  // Step 2: Use {{variable}} syntax
  console.log('STEP 2: Storing memory with {{weather}} syntax...');
  await queue.add('use-weather', {
    id: `use-weather-${USER_ID}`,
    userId: USER_ID,
    message: 'Remember: Today is {{weather}} so I should go outside',
    timestamp: new Date(),
    retryCount: 0,
    source: 'curl-test',
    respondTo: { type: 'api' }
  });
  console.log('✅ Memory message queued');
  console.log('⏳ Waiting 8 seconds...\n');
  await new Promise(r => setTimeout(r, 8000));

  await connection.quit();

  console.log('\n✅ TEST 3 MESSAGES SENT');
  console.log('Check logs with: docker-compose logs --since 30s capabilities | grep -E "Set variable weather|Interpolated.*weather|Today is sunny"');
  process.exit(0);
}

test3().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
