const fs = require('fs');
const csv = require('csv-parser');
const sqlite3 = require('sqlite3');
const path = require('path');

// Open database connection
const dbPath = '/Users/ejfox/code/coachartie2/packages/capabilities/data/coachartie.db';
const db = new sqlite3.Database(dbPath);

console.log('🎯 Starting historical memories import...');

let importCount = 0;
let skipCount = 0;
const batchSize = 1000;
let batch = [];

function processBatch(batch) {
  return new Promise((resolve, reject) => {
    if (batch.length === 0) {
      resolve();
      return;
    }

    const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(',');
    const sql = `INSERT OR IGNORE INTO memories (user_id, content, tags, context, timestamp, importance, created_at) VALUES ${placeholders}`;
    
    const values = [];
    batch.forEach(memory => {
      values.push(
        memory.user_id,
        memory.content,
        memory.tags,
        memory.context,
        memory.timestamp,
        memory.importance,
        memory.created_at
      );
    });

    db.run(sql, values, function(err) {
      if (err) {
        console.error('❌ Batch insert error:', err);
        reject(err);
      } else {
        console.log(`✅ Inserted batch of ${batch.length} memories (total: ${importCount})`);
        resolve();
      }
    });
  });
}

fs.createReadStream('/Users/ejfox/Downloads/memories_rows_noembeddings.csv')
  .pipe(csv())
  .on('data', async (row) => {
    // Skip memories without proper content or user_id
    if (!row.value || row.value.trim().length < 10 || (!row.user_id && !row.conversation_id)) {
      skipCount++;
      return;
    }

    // Map CSV columns to our memory schema
    const memory = {
      user_id: row.user_id || 'legacy_user',
      content: row.value.trim(),
      tags: '[]', // Default empty tags
      context: row.memory_type || 'imported_historical',
      timestamp: row.created_at,
      importance: 5, // Default importance
      created_at: row.created_at
    };

    batch.push(memory);
    importCount++;

    // Process batch when it reaches batchSize
    if (batch.length >= batchSize) {
      try {
        await processBatch(batch);
        batch = [];
      } catch (err) {
        console.error('❌ Error processing batch:', err);
        process.exit(1);
      }
    }
  })
  .on('end', async () => {
    // Process remaining memories in the batch
    if (batch.length > 0) {
      try {
        await processBatch(batch);
      } catch (err) {
        console.error('❌ Error processing final batch:', err);
        process.exit(1);
      }
    }

    console.log(`🎉 Import complete!`);
    console.log(`📊 Imported: ${importCount} memories`);
    console.log(`⏭️ Skipped: ${skipCount} memories`);

    // Check final counts
    db.get('SELECT COUNT(*) as count FROM memories', (err, result) => {
      if (err) {
        console.error('❌ Error counting memories:', err);
      } else {
        console.log(`🗄️ Total memories in database: ${result.count}`);
      }

      // Get date range
      db.get('SELECT MIN(created_at) as oldest, MAX(created_at) as newest FROM memories', (err, result) => {
        if (err) {
          console.error('❌ Error getting date range:', err);
        } else {
          console.log(`📅 Memory date range: ${result.oldest} to ${result.newest}`);
        }
        
        db.close();
        console.log('✅ Database connection closed');
      });
    });
  })
  .on('error', (err) => {
    console.error('❌ CSV reading error:', err);
    process.exit(1);
  });