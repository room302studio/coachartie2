#!/usr/bin/env node

const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const csvPath = '/Users/ejfox/Downloads/memories_rows_noembeddings.csv';
const dbPath = path.join(__dirname, 'data', 'coachartie.db');

console.log('🧠 Starting FINAL memory import from CSV...');
console.log(`📁 CSV: ${csvPath}`);
console.log(`🗄️  DB: ${dbPath}`);

const db = new sqlite3.Database(dbPath);

// Backup current database first
const backupPath = path.join(__dirname, 'data', 'coachartie_before_reimport.db');
fs.copyFileSync(dbPath, backupPath);
console.log(`📦 Created backup: ${backupPath}`);

// Clear existing memories
console.log('🗑️  Clearing existing imported memories...');
db.run('DELETE FROM memories WHERE 1=1');
db.run('DELETE FROM memories_fts WHERE 1=1');

// Read and parse CSV properly
const csvData = fs.readFileSync(csvPath, 'utf8');
const lines = csvData.split('\n');

console.log(`📊 Found ${lines.length - 1} memory rows to process`);

// Parse header
const headerLine = lines[0];
const headers = headerLine.split(',');
console.log(`📋 Headers: ${headers.join(', ')}`);

// Find column indices
const idIndex = headers.indexOf('id');
const createdAtIndex = headers.indexOf('created_at');
const valueIndex = headers.indexOf('value');
const userIdIndex = headers.indexOf('user_id');
const keyIndex = headers.indexOf('key');
const memoryTypeIndex = headers.indexOf('memory_type');
const conversationIdIndex = headers.indexOf('conversation_id');

console.log(`📍 Column mappings: id=${idIndex}, created_at=${createdAtIndex}, value=${valueIndex}, user_id=${userIdIndex}`);

// Prepare insert statement
const insertStmt = db.prepare(`
  INSERT INTO memories (user_id, content, tags, context, timestamp, importance, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

let imported = 0;
let skipped = 0;
let errors = 0;

// Better CSV parser that handles quotes properly
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  let i = 0;
  
  while (i < line.length) {
    const char = line[i];
    
    if (char === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i += 2;
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
        i++;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
      i++;
    } else {
      current += char;
      i++;
    }
  }
  
  result.push(current); // Add last field
  return result;
}

// Process each row
for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;
  
  try {
    const row = parseCSVLine(line);
    
    // Extract data safely
    const originalId = row[idIndex] || '';
    const createdAt = row[createdAtIndex] || '';
    const content = row[valueIndex] || '';
    const userId = row[userIdIndex] || '';
    const key = row[keyIndex] || '';
    const memoryType = row[memoryTypeIndex] || '';
    const conversationId = row[conversationIdIndex] || '';
    
    // Filter out invalid content
    if (!content || content.length < 3 || content === 'undefined') {
      skipped++;
      continue;
    }
    
    // PRESERVE DISCORD USER IDs: Don't change numeric user IDs
    let cleanUserId = userId.trim();
    
    // Check if it's a Discord user ID (long numeric string)
    if (/^\d{15,20}$/.test(cleanUserId)) {
      // Keep Discord IDs exactly as they are
    } else if (cleanUserId && cleanUserId !== 'undefined' && cleanUserId !== '') {
      // Keep other valid user IDs (like 'ejfox')
    } else {
      // Only use legacy_user for truly empty/undefined user IDs
      cleanUserId = 'legacy_user';
    }
    
    // Create context from available fields
    const contextParts = [];
    if (key && key !== '') contextParts.push(`key:${key}`);
    if (memoryType && memoryType !== '') contextParts.push(`type:${memoryType}`);
    if (conversationId && conversationId !== '') contextParts.push(`conversation:${conversationId}`);
    if (originalId && originalId !== '') contextParts.push(`original_id:${originalId}`);
    const context = contextParts.join(' ');
    
    // Convert timestamp safely
    let timestamp = new Date().toISOString(); // Default to now
    if (createdAt && createdAt !== '') {
      try {
        const date = new Date(createdAt);
        if (!isNaN(date.getTime())) {
          timestamp = date.toISOString();
        }
      } catch (e) {
        // Keep default timestamp
      }
    }
    
    // Generate tags based on content analysis
    const tags = [];
    const lowerContent = content.toLowerCase();
    if (lowerContent.includes('calculator') || lowerContent.includes('math')) tags.push('calculator');
    if (lowerContent.includes('memory') || lowerContent.includes('remember')) tags.push('memory');
    if (lowerContent.includes('user') && !lowerContent.includes('user id')) tags.push('user-interaction');
    if (lowerContent.includes('assistant') || lowerContent.includes('coach artie')) tags.push('assistant-interaction');
    if (lowerContent.includes('discord')) tags.push('discord');
    if (memoryType && memoryType !== '') tags.push(`type:${memoryType}`);
    
    // Determine importance based on content and user
    let importance = 5; // Default
    if (content.length > 200) importance = 6;
    if (content.length > 500) importance = 7;
    if (content.length > 1000) importance = 8;
    if (memoryType === 'user') importance = 6;
    if (cleanUserId !== 'legacy_user') importance += 1; // Boost real user memories
    if (/^\d{15,20}$/.test(cleanUserId)) importance += 1; // Extra boost for Discord users
    
    // Insert into database
    insertStmt.run([
      cleanUserId,
      content.trim(),
      JSON.stringify(tags),
      context,
      timestamp,
      Math.min(importance, 10), // Cap at 10
      timestamp,
      timestamp
    ]);
    
    imported++;
    
    if (imported % 1000 === 0) {
      console.log(`📥 Imported ${imported} memories...`);
    }
    
  } catch (err) {
    console.error(`❌ Error processing row ${i}:`, err.message);
    errors++;
  }
}

// Finalize
insertStmt.finalize((err) => {
  if (err) {
    console.error('❌ Error finalizing import:', err);
  } else {
    console.log(`✅ Memory import completed!`);
    console.log(`📊 Results:`);
    console.log(`   • Imported: ${imported} memories`);
    console.log(`   • Skipped: ${skipped} empty/invalid rows`);
    console.log(`   • Errors: ${errors} failed imports`);
    console.log(`   • Success rate: ${((imported / (lines.length - 1)) * 100).toFixed(1)}%`);
    
    // Check user distribution
    db.all(`
      SELECT user_id, COUNT(*) as count 
      FROM memories 
      GROUP BY user_id 
      ORDER BY count DESC 
      LIMIT 10
    `, (err, rows) => {
      if (!err) {
        console.log('\n👥 Top users by memory count:');
        rows.forEach(row => {
          const userType = /^\d{15,20}$/.test(row.user_id) ? '(Discord)' : 
                           row.user_id === 'legacy_user' ? '(Legacy)' : '(Named)';
          console.log(`   • ${row.user_id} ${userType}: ${row.count} memories`);
        });
      }
      
      // Final count
      db.get('SELECT COUNT(*) as count FROM memories', (err, row) => {
        if (!err) {
          console.log(`\n🗄️  Total memories in database: ${row.count}`);
        }
        db.close();
      });
    });
  }
});