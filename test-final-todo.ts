#!/usr/bin/env tsx

const BASE_URL = 'http://localhost:47324';

async function testFinalTodo() {
  console.log('🧪 FINAL TODO TEST - Verifying all fixes\n');

  const messageId = `test-final-${Date.now()}`;
  console.log(`📨 Creating todo list "groceries"...`);

  const response = await fetch(`${BASE_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: 'final-test-user',
      message: 'Create a todo list called groceries with these items: Bananas, Avocados, Coffee',
      messageId
    })
  });

  const data = await response.json();
  console.log(`📊 Job ID: ${data.messageId}\n`);

  // Poll for completion
  console.log('⏳ Waiting for completion...');
  let attempts = 0;

  while (attempts < 15) {
    await new Promise(resolve => setTimeout(resolve, 2000));

    const statusResponse = await fetch(`${BASE_URL}/chat/${data.messageId}`);
    const statusData = await statusResponse.json();

    console.log(`   [${attempts + 1}] ${statusData.status}`);

    if (statusData.status === 'completed') {
      console.log('\n✅ JOB COMPLETED!\n');
      console.log('📄 Response:');
      console.log('─'.repeat(60));
      console.log(statusData.response);
      console.log('─'.repeat(60));

      // Check if response indicates success
      const success = statusData.response.includes('created') ||
                     statusData.response.includes('successfully') ||
                     (statusData.response.includes('groceries') && !statusData.response.includes('technical'));

      if (success) {
        console.log('\n🎉 SUCCESS: Todo list was created!');
      } else {
        console.log('\n⚠️  WARNING: Response doesnt indicate success');
      }
      break;
    } else if (statusData.status === 'failed') {
      console.log('\n❌ Job failed:', statusData.error);
      break;
    }

    attempts++;
  }

  if (attempts >= 15) {
    console.log('\n⏱️  Timeout - job still processing');
  }
}

testFinalTodo().catch(console.error);
