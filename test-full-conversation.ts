#!/usr/bin/env tsx

const BASE_URL = 'http://localhost:47324';

async function testFullConversation() {
  console.log('🧪 FULL CONVERSATION TEST\n');
  console.log('Testing multi-capability conversation with all fixes applied\n');

  // Test 1: Create a todo list with calculator
  console.log('📋 Test 1: Todo list creation + calculation');
  console.log('─'.repeat(60));

  const messageId1 = `test-full-${Date.now()}`;
  const response1 = await fetch(`${BASE_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: 'test-user-full',
      message: 'Create a shopping todo list with: Milk, Eggs, Bread. Also calculate 25 * 4 for me.',
      messageId: messageId1
    })
  });

  const data1 = await response1.json();
  console.log(`📨 Job created: ${data1.messageId}`);
  console.log(`🔗 Status: ${data1.status}\n`);

  // Poll for completion
  console.log('⏳ Polling for completion...');
  let attempts = 0;
  let completed = false;
  let finalResponse = null;

  while (attempts < 20 && !completed) {
    await new Promise(resolve => setTimeout(resolve, 2000));

    const statusResponse = await fetch(`${BASE_URL}/chat/${data1.messageId}`);
    const statusData = await statusResponse.json();

    process.stdout.write(`   [${attempts + 1}] ${statusData.status}${statusData.status === 'processing' ? '...' : ''}\r`);

    if (statusData.status === 'completed') {
      completed = true;
      finalResponse = statusData.response;
      console.log('\n');
    } else if (statusData.status === 'failed') {
      console.log('\n❌ Job failed:', statusData.error);
      break;
    }

    attempts++;
  }

  if (completed && finalResponse) {
    console.log('✅ Job completed successfully!\n');
    console.log('📄 Response:');
    console.log('─'.repeat(60));
    console.log(finalResponse);
    console.log('─'.repeat(60));

    // Verify response contains expected elements
    const checks = [
      { name: 'Todo capability', test: () => finalResponse.includes('<capability name="todo"') },
      { name: 'Shopping list', test: () => finalResponse.toLowerCase().includes('shopping') || finalResponse.toLowerCase().includes('todo') },
      { name: 'Calculator result', test: () => finalResponse.includes('100') },
      { name: 'Multi-line content', test: () => finalResponse.includes('Milk') && finalResponse.includes('Eggs') && finalResponse.includes('Bread') }
    ];

    console.log('\n🔍 Verification:');
    checks.forEach(check => {
      const passed = check.test();
      console.log(`   ${passed ? '✅' : '❌'} ${check.name}`);
    });

  } else if (!completed) {
    console.log('\n⚠️  Job did not complete in time');
    console.log(`   Check status: ${BASE_URL}/chat/${data1.messageId}`);
  }

  // Test 2: Pure todo list test
  console.log('\n\n📋 Test 2: Pure todo list test');
  console.log('─'.repeat(60));

  const messageId2 = `test-todo-${Date.now()}`;
  const response2 = await fetch(`${BASE_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: 'test-user-full',
      message: 'Create a workout plan todo list with these exercises: Warmup stretches, 30 min cardio, Weight training, Cool down',
      messageId: messageId2
    })
  });

  const data2 = await response2.json();
  console.log(`📨 Job created: ${data2.messageId}\n`);

  // Poll for completion
  console.log('⏳ Polling for completion...');
  attempts = 0;
  completed = false;
  finalResponse = null;

  while (attempts < 20 && !completed) {
    await new Promise(resolve => setTimeout(resolve, 2000));

    const statusResponse = await fetch(`${BASE_URL}/chat/${data2.messageId}`);
    const statusData = await statusResponse.json();

    process.stdout.write(`   [${attempts + 1}] ${statusData.status}${statusData.status === 'processing' ? '...' : ''}\r`);

    if (statusData.status === 'completed') {
      completed = true;
      finalResponse = statusData.response;
      console.log('\n');
    } else if (statusData.status === 'failed') {
      console.log('\n❌ Job failed:', statusData.error);
      break;
    }

    attempts++;
  }

  if (completed && finalResponse) {
    console.log('✅ Job completed successfully!\n');
    console.log('📄 Response:');
    console.log('─'.repeat(60));
    console.log(finalResponse);
    console.log('─'.repeat(60));

    // Verify response contains expected elements
    const checks = [
      { name: 'Todo capability tag', test: () => finalResponse.includes('<capability name="todo"') },
      { name: 'Workout reference', test: () => finalResponse.toLowerCase().includes('workout') },
      { name: 'All 4 exercises', test: () =>
        finalResponse.includes('Warmup') &&
        finalResponse.includes('cardio') &&
        finalResponse.includes('Weight') &&
        finalResponse.includes('Cool down')
      }
    ];

    console.log('\n🔍 Verification:');
    checks.forEach(check => {
      const passed = check.test();
      console.log(`   ${passed ? '✅' : '❌'} ${check.name}`);
    });
  } else if (!completed) {
    console.log('\n⚠️  Job did not complete in time');
  }

  console.log('\n\n' + '='.repeat(60));
  console.log('🎉 FULL CONVERSATION TEST COMPLETE');
  console.log('='.repeat(60));
}

testFullConversation().catch(console.error);
