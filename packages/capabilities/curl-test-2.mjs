import { Queue } from 'bullmq';
import Redis from 'ioredis';

const USER_ID = `curl-test-2-${Date.now()}`;

async function test2() {
  const connection = new Redis({ host: 'localhost', port: 47320, maxRetriesPerRequest: null });
  const queue = new Queue('coachartie-messages-incoming', { connection });

  console.log('============================================');
  console.log('TEST 2: Reminder Message Interpolation');
  console.log('============================================\n');
  console.log(`📝 User ID: ${USER_ID}\n`);

  // Step 1: Set variable
  console.log('STEP 1: Setting variable "task" to "deploy website"...');
  await queue.add('set-task', {
    id: `set-task-${USER_ID}`,
    userId: USER_ID,
    message: 'Set task to deploy website',
    timestamp: new Date(),
    retryCount: 0,
    source: 'curl-test',
    respondTo: { type: 'api' }
  });
  console.log('✅ Set variable message queued');
  console.log('⏳ Waiting 6 seconds...\n');
  await new Promise(r => setTimeout(r, 6000));

  // Step 2: Create reminder
  console.log('STEP 2: Creating reminder with ${task} interpolation...');
  await queue.add('use-task', {
    id: `use-task-${USER_ID}`,
    userId: USER_ID,
    message: 'Remind me in 2 minutes: Time to ${task}!',
    timestamp: new Date(),
    retryCount: 0,
    source: 'curl-test',
    respondTo: { type: 'api' }
  });
  console.log('✅ Reminder message queued');
  console.log('⏳ Waiting 8 seconds...\n');
  await new Promise(r => setTimeout(r, 8000));

  await connection.quit();

  console.log('\n✅ TEST 2 MESSAGES SENT');
  console.log('Check logs with: docker-compose logs --since 30s capabilities | grep -E "Set variable task|Interpolated.*task|deploy website"');
  process.exit(0);
}

test2().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
