import { capabilityXMLParser } from './packages/capabilities/src/utils/xml-parser.js';

const testText = `
Let me create your weekend todo list:

<capability name="todo" action="create" list="weekend">- Clean garage
- Buy groceries
- Call mom</capability>
`;

console.log('Testing XML extraction...\n');
const capabilities = capabilityXMLParser.extractCapabilities(testText);

console.log(`Found ${capabilities.length} capability(ies):`);
capabilities.forEach((cap, i) => {
  console.log(`\n[${i + 1}] ${cap.name}:${cap.action}`);
  console.log(`  Params:`, cap.params);
  console.log(`  Content: "${cap.content}"`);
  console.log(`  Content has newlines:`, cap.content.includes('\n'));
  console.log(`  Content lines:`, cap.content.split('\n'));
});

// Verify the fix
if (capabilities.length === 1) {
  console.log('\n✅ SUCCESS: Extracted exactly 1 capability (no duplicates)');
  if (capabilities[0].content.includes('Clean garage') &&
      capabilities[0].content.includes('Buy groceries') &&
      capabilities[0].content.includes('Call mom')) {
    console.log('✅ SUCCESS: Content includes all todo items');
  } else {
    console.log('❌ FAIL: Content missing some items');
  }
} else {
  console.log(`\n❌ FAIL: Expected 1 capability, got ${capabilities.length}`);
}
