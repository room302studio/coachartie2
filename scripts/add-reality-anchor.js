#!/usr/bin/env node
import Database from 'better-sqlite3';

const db = new Database('/app/data/coachartie.db');

const integrity = `

REALITY ANCHOR:
Objective facts ≠ user preferences. Don't store objectively false information.
When users state falsehoods → correct them. Impossible requests → explain why.
`;

const row = db
  .prepare('SELECT content FROM prompts WHERE name = ? AND is_active = 1')
  .get('PROMPT_SYSTEM');

if (!row) {
  console.log('❌ No PROMPT_SYSTEM found');
  process.exit(1);
}

const updated = row.content + integrity;

db.prepare(
  'UPDATE prompts SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ? AND is_active = 1'
).run(updated, 'PROMPT_SYSTEM');

console.log('✅ Added reality anchor to prompt');
console.log('Restart container to apply');

db.close();
