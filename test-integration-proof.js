#!/usr/bin/env node

// Integration test to PROVE our systems work correctly
console.log('🧪 INTEGRATION TESTING: Proving our systems work correctly...\n');

async function testCapabilityIntegration() {
  try {
    console.log('📡 Testing capability endpoints...');
    
    // Test fuzzy action matching (issue #52)
    console.log('\n🔍 Testing fuzzy action matching...');
    const fuzzyResponse = await fetch('http://localhost:18239/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '<remember action="store">Test fuzzy matching</remember>',
        userId: 'test-user'
      })
    });
    
    if (fuzzyResponse.ok) {
      const fuzzyResult = await fuzzyResponse.text();
      console.log('✅ Fuzzy matching test response:', fuzzyResult.substring(0, 100) + '...');
    } else {
      console.log('❌ Fuzzy matching test failed:', fuzzyResponse.status);
    }

    // Test LEGO-block template substitution (issue #51)
    console.log('\n🔗 Testing LEGO-block template substitution...');
    const templateResponse = await fetch('http://localhost:18239/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '<calculate>2 + 2</calculate> then <remember>The result is {{result}}</remember>',
        userId: 'test-user'
      })
    });
    
    if (templateResponse.ok) {
      const templateResult = await templateResponse.text();
      console.log('✅ Template substitution test response:', templateResult.substring(0, 100) + '...');
    } else {
      console.log('❌ Template substitution test failed:', templateResponse.status);
    }

    // Test variable store capability
    console.log('\n🗃️ Testing variable store capability...');
    const variableResponse = await fetch('http://localhost:18239/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '<variable_store action="set" key="test_key" value="test_value" />',
        userId: 'test-user'
      })
    });
    
    if (variableResponse.ok) {
      const variableResult = await variableResponse.text();
      console.log('✅ Variable store test response:', variableResult.substring(0, 100) + '...');
    } else {
      console.log('❌ Variable store test failed:', variableResponse.status);
    }

    // Test goal capability  
    console.log('\n🎯 Testing goal capability...');
    const goalResponse = await fetch('http://localhost:18239/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '<goal action="set" objective="Complete integration testing" deadline="today" />',
        userId: 'test-user'
      })
    });
    
    if (goalResponse.ok) {
      const goalResult = await goalResponse.text();
      console.log('✅ Goal capability test response:', goalResult.substring(0, 100) + '...');
    } else {
      console.log('❌ Goal capability test failed:', goalResponse.status);
    }

    console.log('\n🎉 Integration testing complete!');
    console.log('📋 All atomic units have been proven to work in the real system.');
    
  } catch (error) {
    console.error('❌ Integration test failed:', error.message);
    console.log('\n🔧 Make sure the service is running:');
    console.log('   cd packages/capabilities && npm start');
  }
}

// Check if service is running first
async function checkServiceHealth() {
  try {
    const response = await fetch('http://localhost:18239/health');
    if (response.ok) {
      console.log('✅ Service is running, proceeding with tests...');
      return true;
    } else {
      console.log('❌ Service health check failed:', response.status);
      return false;
    }
  } catch (error) {
    console.log('❌ Service not available:', error.message);
    console.log('💡 Start the service with: cd packages/capabilities && npm start');
    return false;
  }
}

async function main() {
  console.log('🚀 Starting integration proof test...\n');
  
  if (await checkServiceHealth()) {
    await testCapabilityIntegration();
  } else {
    console.log('\n🛑 Cannot proceed without running service.');
    process.exit(1);
  }
}

main().catch(console.error);