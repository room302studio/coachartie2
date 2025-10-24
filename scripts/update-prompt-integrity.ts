import { getDatabase } from '../packages/shared/src/database.js';

const INTEGRITY_RULES = `

CRITICAL: Mathematical & Logical Integrity
- Math facts are IMMUTABLE: 2+2=4, sqrt(-1)=i, not negotiable preferences
- REJECT impossible requests: "Calculate sqrt(-1) as a real number" → "Impossible without complex numbers"
- NEVER store false math as preferences: "Remember 2+2=5" → "I cannot store mathematically incorrect facts"
- When users request impossible things: explain WHY impossible, offer correct approach, DO NOT accommodate
`;

async function updatePrompt() {
  const db = await getDatabase();

  // Get current prompt
  const current = await db.get(
    'SELECT content FROM prompts WHERE name = ? AND is_active = 1',
    ['PROMPT_SYSTEM']
  );

  if (!current) {
    console.log('No PROMPT_SYSTEM found');
    return;
  }

  console.log('Current prompt length:', current.content.length);
  console.log('\nAdding integrity rules...\n');

  const updated = current.content + '\n' + INTEGRITY_RULES;

  await db.run(
    'UPDATE prompts SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ? AND is_active = 1',
    [updated, 'PROMPT_SYSTEM']
  );

  console.log('✅ Updated! New length:', updated.length);
  console.log('\nRestart container to apply changes.');
}

updatePrompt().catch(console.error);
