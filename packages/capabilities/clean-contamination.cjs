#!/usr/bin/env node

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'data', 'coachartie.db');
const db = new sqlite3.Database(dbPath);

console.log('🧹 Cleaning contaminated system memories...');

// First, get the contaminated memory IDs
db.all(`
  SELECT id, content 
  FROM memories 
  WHERE user_id = 'system' 
  AND (content LIKE '%calcul%' OR content LIKE '%times%' OR content LIKE '%multiply%' OR content LIKE '%math%' OR content LIKE '%=%')
  LIMIT 20
`, (err, rows) => {
  if (err) {
    console.error('Error:', err);
    return;
  }
  
  console.log(`Found ${rows.length} contaminated memories`);
  
  // Delete them one by one
  let deleted = 0;
  rows.forEach(row => {
    db.run('DELETE FROM memories WHERE id = ?', [row.id], function(err) {
      if (err) {
        console.error(`Error deleting memory ${row.id}:`, err);
      } else {
        deleted++;
        console.log(`✅ Deleted memory ${row.id}: ${row.content.substring(0, 50)}...`);
      }
      
      // Close when done
      if (deleted + (rows.length - deleted) === rows.length) {
        console.log(`🎯 Cleaned ${deleted} contaminated memories`);
        db.close();
      }
    });
  });
});