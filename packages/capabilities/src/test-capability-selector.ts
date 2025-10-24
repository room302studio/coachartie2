/**
 * Standalone test for Capability Selector
 * Tests the two-tier triage system before integration
 */

import { capabilitySelector } from './services/capability-selector.js';
import { capabilityRegistry } from './services/capability-registry.js';
import { logger } from '@coachartie/shared';

// Initialize registry with capabilities (minimal set for testing)
import { calculatorCapability } from './capabilities/calculator.js';
import { memoryCapability } from './capabilities/memory.js';
import { webCapability } from './capabilities/web.js';
import { todoCapability } from './capabilities/todo.js';
import { goalCapability } from './capabilities/goal.js';
import { variableStoreCapability } from './capabilities/variable-store.js';

console.log('\n═══════════════════════════════════════════════════');
console.log('🧪 CAPABILITY SELECTOR STANDALONE TEST');
console.log('═══════════════════════════════════════════════════\n');

async function runTest(testName: string, userMessage: string, expectedCapabilities: string[]) {
  console.log(`\n🔬 TEST: ${testName}`);
  console.log(`   Message: "${userMessage}"`);
  console.log(`   Expected: [${expectedCapabilities.join(', ')}]`);
  console.log('');

  try {
    const startTime = Date.now();

    // Run capability selection
    const nominated = await capabilitySelector.selectRelevantCapabilities(userMessage);

    const duration = Date.now() - startTime;
    const nominatedNames = nominated.map((c) => c.name);

    console.log(`   ✅ Completed in ${duration}ms`);
    console.log(`   📊 Nominated: [${nominatedNames.join(', ')}]`);

    // Check if expected capabilities were nominated
    const missingExpected = expectedCapabilities.filter((name) => !nominatedNames.includes(name));
    const unexpectedNominated = nominatedNames.filter((name) => !expectedCapabilities.includes(name));

    if (missingExpected.length === 0 && unexpectedNominated.length === 0) {
      console.log('   ✅ PASS: Nominated exactly the expected capabilities');
      return true;
    } else {
      if (missingExpected.length > 0) {
        console.log(`   ⚠️ WARNING: Missing expected: [${missingExpected.join(', ')}]`);
      }
      if (unexpectedNominated.length > 0) {
        console.log(`   ℹ️ INFO: Also nominated: [${unexpectedNominated.join(', ')}]`);
      }
      console.log('   ⚠️ PARTIAL PASS: Nominations differ from expected');
      return false;
    }
  } catch (error) {
    console.log(`   ❌ FAIL: ${error}`);
    return false;
  }
}

async function main() {
  // Register test capabilities
  console.log('📦 Registering test capabilities...');
  capabilityRegistry.register(calculatorCapability);
  capabilityRegistry.register(memoryCapability);
  capabilityRegistry.register(webCapability);
  capabilityRegistry.register(todoCapability);
  capabilityRegistry.register(goalCapability);
  capabilityRegistry.register(variableStoreCapability);
  console.log(`✅ Registered ${capabilityRegistry.size()} capabilities\n`);

  const results: boolean[] = [];

  // Test 1: Simple calculation (should nominate calculator only)
  results.push(
    await runTest(
      'Simple Calculation',
      'Calculate 123 * 456',
      ['calculator']
    )
  );

  // Test 2: Memory storage (should nominate memory only)
  results.push(
    await runTest(
      'Memory Storage',
      'Remember that I like pizza',
      ['memory']
    )
  );

  // Test 3: Multi-capability (THIS IS THE BUG WE FOUND)
  // Should nominate BOTH calculator AND memory
  results.push(
    await runTest(
      'Multi-Capability (Bug Test)',
      'Calculate 15% of $100 and remember it as my tip budget',
      ['calculator', 'memory']
    )
  );

  // Test 4: Web search (should nominate web only)
  results.push(
    await runTest(
      'Web Search',
      'Search for the latest news about AI agents',
      ['web']
    )
  );

  // Test 5: No capabilities needed (should nominate nothing)
  results.push(
    await runTest(
      'No Capabilities',
      'How are you doing today?',
      []
    )
  );

  // Test 6: Ambiguous (calculator might be nominated, but not required)
  results.push(
    await runTest(
      'Ambiguous Request',
      'Calculate it',
      [] // No clear capability needed due to ambiguity
    )
  );

  // Summary
  console.log('\n═══════════════════════════════════════════════════');
  console.log('📊 TEST SUMMARY');
  console.log('═══════════════════════════════════════════════════\n');

  const passed = results.filter((r) => r).length;
  const total = results.length;

  console.log(`   Total: ${total} tests`);
  console.log(`   Passed: ${passed}`);
  console.log(`   Failed: ${total - passed}`);
  console.log(`   Success Rate: ${((passed / total) * 100).toFixed(1)}%`);

  if (passed === total) {
    console.log('\n   ✅ ALL TESTS PASSED');
  } else {
    console.log('\n   ⚠️ SOME TESTS FAILED OR PARTIAL');
  }

  console.log('\n═══════════════════════════════════════════════════\n');

  process.exit(passed === total ? 0 : 1);
}

main().catch((error) => {
  console.error('❌ Test suite failed:', error);
  process.exit(1);
});
