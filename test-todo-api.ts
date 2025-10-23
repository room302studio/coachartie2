#!/usr/bin/env tsx

const BASE_URL = 'http://localhost:47324';

async function testTodoCapability() {
  console.log('🧪 Testing Todo Capability\n');

  // Test 1: Create a todo list
  console.log('📋 Test 1: Creating a todo list called "daily_tasks"...');
  const createResponse = await fetch(`${BASE_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: 'test-user',
      message: 'Create a todo list called daily_tasks with these items: Morning workout, Review code, Write documentation, Team meeting',
      messageId: `test-todo-create-${Date.now()}`
    })
  });

  const createData = await createResponse.json();
  console.log(`📨 Job created: ${createData.messageId}`);
  console.log(`🔗 Status: ${createData.status}\n`);

  // Wait for processing
  console.log('⏳ Waiting for job to complete...');
  let attempts = 0;
  let completed = false;
  let finalResponse = null;

  while (attempts < 30 && !completed) {
    await new Promise(resolve => setTimeout(resolve, 2000));

    const statusResponse = await fetch(`${BASE_URL}/chat/${createData.messageId}`);
    const statusData = await statusResponse.json();

    console.log(`   [${attempts + 1}] Status: ${statusData.status}`);

    if (statusData.status === 'completed') {
      completed = true;
      finalResponse = statusData.response;
    } else if (statusData.status === 'failed') {
      console.log('❌ Job failed:', statusData.error);
      break;
    }

    attempts++;
  }

  if (completed && finalResponse) {
    console.log('\n✅ Job completed successfully!');
    console.log('\n📄 Response:');
    console.log(finalResponse);
    console.log('\n');
  } else if (!completed) {
    console.log('\n⚠️  Job did not complete in time (still processing)');
    console.log('   You can check status manually at:', `${BASE_URL}/chat/${createData.messageId}`);
  }

  // Test 2: List all todo lists
  console.log('\n📋 Test 2: Listing all todo lists...');
  const listResponse = await fetch(`${BASE_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: 'test-user',
      message: 'List all my todo lists',
      messageId: `test-todo-list-${Date.now()}`
    })
  });

  const listData = await listResponse.json();
  console.log(`📨 Job created: ${listData.messageId}`);
  console.log(`🔗 Check status: ${BASE_URL}/chat/${listData.messageId}\n`);

  console.log('✅ Todo capability test complete!');
}

testTodoCapability().catch(console.error);
