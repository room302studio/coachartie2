#!/usr/bin/env tsx

const BASE_URL = 'http://localhost:47324';

async function analyzeSubwayIssues() {
  console.log('🚇 Analyzing Subway Builder GitHub Issues\n');

  const messageId = `test-subway-${Date.now()}`;

  const response = await fetch(`${BASE_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: 'ejfox',
      message: `Please go through all the GitHub issues for the subway builder repository and:
1. Read through all open issues
2. Group them by theme/category
3. Identify any duplicates
4. Provide a summary of the main issues and themes

Please use the github capability to fetch and analyze the issues.`,
      messageId
    })
  });

  const data = await response.json();
  console.log(`📨 Job ID: ${data.messageId}`);
  console.log(`📊 Initial Status: ${data.status}\n`);

  // Poll for completion
  console.log('⏳ Waiting for analysis (this may take a while)...\n');
  let attempts = 0;
  const maxAttempts = 60; // 2 minutes max

  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 2000));

    const statusResponse = await fetch(`${BASE_URL}/chat/${data.messageId}`);
    const statusData = await statusResponse.json();

    // Show progress
    process.stdout.write(`   [${attempts + 1}/${maxAttempts}] ${statusData.status}${statusData.status === 'processing' ? '...' : ''}       \r`);

    if (statusData.status === 'completed') {
      console.log('\n\n✅ ANALYSIS COMPLETE!\n');
      console.log('='.repeat(80));
      console.log(statusData.response);
      console.log('='.repeat(80));
      break;
    } else if (statusData.status === 'failed') {
      console.log('\n\n❌ Job failed:', statusData.error);
      break;
    }

    attempts++;
  }

  if (attempts >= maxAttempts) {
    console.log('\n\n⏱️  Timeout - job still processing');
    console.log(`   Check status at: ${BASE_URL}/chat/${data.messageId}`);
  }
}

analyzeSubwayIssues().catch(console.error);
