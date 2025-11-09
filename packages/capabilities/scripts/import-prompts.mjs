#!/usr/bin/env node
/**
 * Import prompts from CSV into the database
 * Usage: DATABASE_PATH=/path/to/db.sqlite node scripts/import-prompts.mjs /path/to/prompts.csv
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';

const csvPath = process.argv[2];
const dbPath = process.env.DATABASE_PATH || './artie.db';

if (!csvPath) {
  console.error('Usage: DATABASE_PATH=/path/to/db.sqlite node import-prompts.mjs /path/to/prompts.csv');
  process.exit(1);
}

console.log(`📥 Importing prompts from: ${csvPath}`);
console.log(`💾 Database: ${dbPath}`);

// Read and parse CSV
const csvContent = readFileSync(csvPath, 'utf-8');
const records = parse(csvContent, {
  columns: true,
  skip_empty_lines: true,
  relax_column_count: true,
});

console.log(`\n📊 Found ${records.length} prompts in CSV\n`);

// Open database
const db = new Database(dbPath);

// Prepare statement
const upsert = db.prepare(`
  INSERT INTO prompts (name, content, description, category, is_active)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(name) DO UPDATE SET
    content = excluded.content,
    description = excluded.description,
    category = excluded.category,
    is_active = excluded.is_active,
    updated_at = CURRENT_TIMESTAMP
`);

let imported = 0;
let skipped = 0;

for (const record of records) {
  const name = record.prompt_name?.trim();
  const content = record.prompt_text?.trim();

  if (!name || !content) {
    console.log(`⏭️  Skipping row with missing name or content`);
    skipped++;
    continue;
  }

  const description = record.notes?.trim() || null;
  const category = record.type?.trim() || 'general';
  const isActive = record.archived !== 'true' && record.active !== 'false' ? 1 : 0;

  try {
    upsert.run(name, content, description, category, isActive);
    console.log(`✅ ${name} (${category})`);
    imported++;
  } catch (error) {
    console.error(`❌ Failed to import ${name}:`, error.message);
    skipped++;
  }
}

// Verify
const prompts = db.prepare('SELECT name, category, is_active FROM prompts ORDER BY name').all();

console.log(`\n📊 Import Summary:`);
console.log(`   ✅ Imported: ${imported}`);
console.log(`   ⏭️  Skipped: ${skipped}`);
console.log(`   📋 Total in DB: ${prompts.length}`);

console.log(`\n📋 Prompts now in database:`);
prompts.forEach(p => {
  const status = p.is_active ? '✓' : '✗';
  console.log(`   ${status} ${p.name} (${p.category})`);
});

db.close();
console.log(`\n✅ Done!`);
