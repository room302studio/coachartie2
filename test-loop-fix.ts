#!/usr/bin/env tsx

const BASE_URL = 'http://localhost:47324';

async function testLoopFix() {
  console.log('🧪 Testing Intermediate Response Loop Fix\n');

  const messageId = `test-loop-fix-${Date.now()}`;
  console.log(`📨 Submitting test with messageId: ${messageId}`);

  const createResponse = await fetch(`${BASE_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: 'test-user-loop-fix',
      message: 'Create a todo list called workout with these items: Warmup, Cardio, Weights',
      messageId
    })
  });

  const createData = await createResponse.json();
  console.log(`📊 Job Status: ${createData.status}\n`);

  // Wait and check for completion
  console.log('⏳ Waiting 20 seconds for processing...');
  await new Promise(resolve => setTimeout(resolve, 20000));

  const statusResponse = await fetch(`${BASE_URL}/chat/${createData.messageId}`);
  const statusData = await statusResponse.json();

  console.log(`\n✅ Final Status: ${statusData.status}`);

  if (statusData.status === 'completed') {
    console.log('✅ SUCCESS: Job completed without infinite loop!');
    console.log(`\n📄 Response:\n${statusData.response}`);
  } else if (statusData.status === 'processing') {
    console.log('⚠️  STILL PROCESSING: May be stuck in loop (check logs)');
  } else if (statusData.status === 'failed') {
    console.log('❌ FAILED:', statusData.error);
  }
}

testLoopFix().catch(console.error);
