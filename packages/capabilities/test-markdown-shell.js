import { shellCapability } from './dist/capabilities/shell.js';

const tests = [
  {
    name: 'Simple JavaScript',
    params: { action: 'exec', command: '/workspace/test1.js' },
    content: '```javascript\nconst hello = "world";\nconsole.log(hello);\n```',
  },
  {
    name: 'Python with special chars',
    params: { action: 'exec', command: '/workspace/test2.py' },
    content: '```python\nprint("Special: \${}[]()\\047")\n```',
  },
  {
    name: 'JSON with quotes',
    params: { action: 'exec', command: '/workspace/test4.json' },
    content: '```json\n{\n  "test": "value"\n}\n```',
  },
  {
    name: 'Large file 100 lines',
    params: { action: 'exec', command: '/workspace/test7.txt' },
    content: '```\n' + Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\\n') + '\n```',
  },
  {
    name: 'No language tag',
    params: { action: 'exec', command: '/workspace/test8.txt' },
    content: '```\nPlain text\n```',
  },
  {
    name: 'Regular heredoc command',
    params: {
      action: 'exec',
      command: "cat > /workspace/test_heredoc.sh << 'INNER'\n#!/bin/bash\necho test\nINNER",
    },
  },
];

(async () => {
  console.log('🧪 Markdown Shell Stress Test\\n');
  let passed = 0,
    failed = 0;

  for (const test of tests) {
    process.stdout.write(`${test.name}... `);
    try {
      const result = await shellCapability.handler(test.params, test.content);
      const parsed = JSON.parse(result);
      if (parsed.success) {
        console.log('✅');
        passed++;
      } else {
        console.log('❌', parsed.error.substring(0, 80));
        failed++;
      }
    } catch (e) {
      console.log('💥', e.message.substring(0, 80));
      failed++;
    }
  }

  console.log(`\\n📊 ${passed}/${tests.length} passed`);

  const list = await shellCapability.handler({
    action: 'exec',
    command: 'ls -lh /workspace/test* 2>&1',
  });
  console.log('\\n📁 Created files:');
  console.log(JSON.parse(list).data.stdout);

  const read = await shellCapability.handler({
    action: 'exec',
    command: 'head -5 /workspace/test1.js /workspace/test4.json',
  });
  console.log('\\n📖 Sample contents:');
  console.log(JSON.parse(read).data.stdout);

  await shellCapability.handler({
    action: 'exec',
    command: 'rm -f /workspace/test*',
  });

  console.log('\\n✨ Complete!');
  process.exit(failed > 0 ? 1 : 0);
})();
