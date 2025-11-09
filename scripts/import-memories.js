#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Import from workspace packages
const { open } = require(path.join(__dirname, '../node_modules/sqlite'));
const sqlite3 = require(path.join(__dirname, '../node_modules/sqlite3'));

const CSV_PATH = '/Users/ejfox/Downloads/memories_rows_noembeddings.csv';
const DB_PATH = '/Users/ejfox/code/coachartie2/packages/capabilities/data/coachartie.db';

async function importMemories() {
  console.log('Reading CSV file...');
  const csvContent = fs.readFileSync(CSV_PATH, 'utf-8');

  console.log('Parsing CSV...');
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
  });

  console.log(`Found ${records.length} memories to import`);

  const db = new sqlite3.Database(DB_PATH);

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      const stmt = db.prepare(`
        INSERT INTO memories (
          content, user_id, created_at, timestamp,
          related_message_id, tags, context, importance
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      let imported = 0;
      let skipped = 0;

      records.forEach((record) => {
        // Skip records with undefined user_id or empty value
        if (!record.user_id || record.user_id === 'undefined' || !record.value) {
          skipped++;
          return;
        }

        stmt.run(
          record.value, // content
          record.user_id, // user_id
          record.created_at, // created_at
          record.created_at, // timestamp (use same as created_at)
          record.related_message_id || null, // related_message_id
          '[]', // tags (default empty array)
          '', // context (default empty)
          5 // importance (default 5)
        );
        imported++;

        if (imported % 100 === 0) {
          console.log(`Imported ${imported} memories...`);
        }
      });

      stmt.finalize((err) => {
        if (err) {
          console.error('Error finalizing statement:', err);
          reject(err);
        } else {
          console.log(`\nImport complete!`);
          console.log(`  Imported: ${imported}`);
          console.log(`  Skipped: ${skipped}`);
          db.close();
          resolve();
        }
      });
    });
  });
}

importMemories()
  .then(() => {
    console.log('Done!');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Import failed:', err);
    process.exit(1);
  });
