import { getDatabase } from '../packages/shared/src/database.js';

const INTEGRITY_RULES = `

REALITY ANCHOR:
Objective facts ≠ user preferences. Don't store objectively false information.
When users state falsehoods → correct them. Impossible requests → explain why.
`;

async function updatePrompt() {
  const db = await getDatabase();

  // Get current prompt
  const current = await db.get('SELECT content FROM prompts WHERE name = ? AND is_active = 1', [
    'PROMPT_SYSTEM',
  ]);

  if (!current) {
    console.log('❌ No PROMPT_SYSTEM found');
    return;
  }

  console.log('Current prompt length:', current.content.length);
  console.log('\nAdding reality anchor...\n');

  const updated = current.content + '\n' + INTEGRITY_RULES;

  await db.run(
    'UPDATE prompts SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ? AND is_active = 1',
    [updated, 'PROMPT_SYSTEM']
  );

  console.log('✅ Updated! New length:', updated.length);
  console.log('\nRestart container to apply changes.');
}

updatePrompt().catch(console.error);
