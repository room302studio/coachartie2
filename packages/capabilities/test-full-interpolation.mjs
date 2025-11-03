import { Queue } from 'bullmq';
import Redis from 'ioredis';

async function testFullInterpolation() {
  const connection = new Redis({
    host: 'localhost',
    port: 47320,
    maxRetriesPerRequest: null,
  });

  const queue = new Queue('coachartie-messages-incoming', { connection });

  console.log('🧪 COMPLETE INTERPOLATION TEST');
  console.log('================================\n');

  // Step 1: Set the variable
  console.log('📝 Step 1: Setting variable "animal" to "cat"...');
  await queue.add('set-variable', {
    id: `set-animal-${Date.now()}`,
    userId: 'test-CORRECT-user',
    message: 'Set a variable: animal equals cat',
    timestamp: new Date(),
    retryCount: 0,
    source: 'test',
    respondTo: { type: 'api' }
  });

  // Wait for it to be set
  console.log('⏳ Waiting 8 seconds for variable to be set...\n');
  await new Promise(resolve => setTimeout(resolve, 8000));

  // Step 2: Use the variable
  console.log('📝 Step 2: Storing memory with ${animal} interpolation...');
  await queue.add('use-variable', {
    id: `use-animal-${Date.now()}`,
    userId: 'test-CORRECT-user',
    message: 'Store this fact in memory: I need to buy food for my ${animal}',
    timestamp: new Date(),
    retryCount: 0,
    source: 'test',
    respondTo: { type: 'api' }
  });

  console.log('✅ Both messages queued!');
  console.log('\n🔍 Watch for in logs:');
  console.log('   1. "📦 Set variable animal" (first message)');
  console.log('   2. "🔗 Interpolated content: ...${animal} → ...cat" (second message)');
  console.log('   3. "💾 Stored memory: I need to buy food for my cat"');

  await connection.quit();
  process.exit(0);
}

testFullInterpolation().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
