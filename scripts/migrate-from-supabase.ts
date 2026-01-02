#!/usr/bin/env tsx
/**
 * Migrate data from old Supabase to local SQLite
 */

import { getSyncDb, initializeDb } from '../packages/shared/src/db/client.js';

const SUPABASE_URL = 'https://avifojtjjlshjzvqibdo.supabase.co';
const SUPABASE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF2aWZvanRqamxzaGp6dnFpYmRvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTcwMjU5NjI0NiwiZXhwIjoyMDE4MTcyMjQ2fQ.w5KZIPckFL-otI3G0pvCSIy_xPW7X-NgJG5hzWiQ16k';

async function fetchFromSupabase(
  table: string,
  select = '*',
  limit = 1000,
  offset = 0
): Promise<any[]> {
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=${select}&limit=${limit}&offset=${offset}`;
  const response = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${table}: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function fetchAllMemories(): Promise<any[]> {
  console.log('📥 Fetching memories from Supabase...');
  const allMemories: any[] = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const batch = await fetchFromSupabase('memories', '*', limit, offset);
    if (batch.length === 0) break;

    allMemories.push(...batch);
    console.log(`  fetched ${allMemories.length} memories...`);
    offset += limit;

    if (batch.length < limit) break;
  }

  return allMemories;
}

async function fetchAllPrompts(): Promise<any[]> {
  console.log('📥 Fetching prompts from Supabase...');
  return fetchFromSupabase('prompts', '*');
}

async function fetchAllMessages(): Promise<any[]> {
  console.log('📥 Fetching messages from Supabase...');
  const allMessages: any[] = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const batch = await fetchFromSupabase('messages', '*', limit, offset);
    if (batch.length === 0) break;

    allMessages.push(...batch);
    console.log(`  fetched ${allMessages.length} messages...`);
    offset += limit;

    if (batch.length < limit) break;
  }

  return allMessages;
}

async function migrate() {
  console.log('🚀 Starting migration from Supabase to SQLite...\n');

  // Initialize database
  initializeDb();
  const db = getSyncDb();

  // Fetch all data from Supabase
  const [memories, prompts, messages] = await Promise.all([
    fetchAllMemories(),
    fetchAllPrompts(),
    fetchAllMessages(),
  ]);

  console.log(`\n📊 Data fetched:`);
  console.log(`  - ${memories.length} memories`);
  console.log(`  - ${prompts.length} prompts`);
  console.log(`  - ${messages.length} messages`);

  // Migrate prompts
  console.log('\n📝 Migrating prompts...');
  let promptsImported = 0;
  let promptsSkipped = 0;

  for (const prompt of prompts) {
    try {
      const name = prompt.prompt_name;
      const content = prompt.prompt_text;
      const category = prompt.type || 'general';
      const description = prompt.notes || null;
      const isActive = !prompt.archived;

      // Check if exists
      const existing = db.get('SELECT id FROM prompts WHERE name = ?', [name]);

      if (existing) {
        // Update if supabase version is newer or different
        db.run(
          'UPDATE prompts SET content = ?, description = ?, category = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?',
          [content, description, category, isActive ? 1 : 0, name]
        );
        console.log(`  ✅ Updated: ${name}`);
      } else {
        db.run(
          'INSERT INTO prompts (name, content, description, category, is_active) VALUES (?, ?, ?, ?, ?)',
          [name, content, description, category, isActive ? 1 : 0]
        );
        console.log(`  ✅ Created: ${name}`);
      }
      promptsImported++;
    } catch (error) {
      console.error(`  ❌ Failed: ${prompt.prompt_name}`, error);
      promptsSkipped++;
    }
  }

  // Migrate memories
  console.log('\n🧠 Migrating memories...');
  let memoriesImported = 0;
  let memoriesSkipped = 0;

  for (const memory of memories) {
    try {
      // Check if memory already exists by content hash or timestamp
      const existing = db.get(
        'SELECT id FROM memories WHERE user_id = ? AND content = ? AND timestamp = ?',
        [
          memory.user_id || 'system',
          memory.value || memory.content,
          memory.created_at || memory.timestamp,
        ]
      );

      if (existing) {
        memoriesSkipped++;
        continue;
      }

      const tags = Array.isArray(memory.tags) ? JSON.stringify(memory.tags) : memory.tags || '[]';
      const metadata =
        typeof memory.metadata === 'object'
          ? JSON.stringify(memory.metadata)
          : memory.metadata || '{}';

      db.run(
        `INSERT INTO memories (user_id, content, tags, context, timestamp, importance, metadata, embedding, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          memory.user_id || 'system',
          memory.value || memory.content || '',
          tags,
          memory.context || '',
          memory.created_at || memory.timestamp || new Date().toISOString(),
          memory.importance || 5,
          metadata,
          memory.embedding ? JSON.stringify(memory.embedding) : null,
          memory.created_at || new Date().toISOString(),
        ]
      );
      memoriesImported++;

      if (memoriesImported % 500 === 0) {
        console.log(`  imported ${memoriesImported} memories...`);
      }
    } catch (error) {
      memoriesSkipped++;
    }
  }
  console.log(`  ✅ Imported ${memoriesImported} memories (${memoriesSkipped} skipped/duplicates)`);

  // Migrate messages
  console.log('\n💬 Migrating messages...');
  let messagesImported = 0;
  let messagesSkipped = 0;

  for (const message of messages) {
    try {
      // Check if message already exists
      const existing = db.get(
        'SELECT id FROM messages WHERE user_id = ? AND value = ? AND created_at = ?',
        [message.user_id || 'system', message.value || message.content || '', message.created_at]
      );

      if (existing) {
        messagesSkipped++;
        continue;
      }

      const metadata =
        typeof message.metadata === 'object'
          ? JSON.stringify(message.metadata)
          : message.metadata || '{}';

      db.run(
        `INSERT INTO messages (value, user_id, message_type, channel_id, guild_id, conversation_id, role, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          message.value || message.content || '',
          message.user_id || 'system',
          message.message_type || 'discord',
          message.channel_id || null,
          message.guild_id || null,
          message.conversation_id || null,
          message.role || null,
          metadata,
          message.created_at || new Date().toISOString(),
        ]
      );
      messagesImported++;

      if (messagesImported % 500 === 0) {
        console.log(`  imported ${messagesImported} messages...`);
      }
    } catch (error) {
      messagesSkipped++;
    }
  }
  console.log(`  ✅ Imported ${messagesImported} messages (${messagesSkipped} skipped/duplicates)`);

  // Final counts
  const finalMemories = db.get('SELECT COUNT(*) as count FROM memories');
  const finalMessages = db.get('SELECT COUNT(*) as count FROM messages');
  const finalPrompts = db.get('SELECT COUNT(*) as count FROM prompts');

  console.log('\n🎉 Migration complete!');
  console.log(`\n📊 Final database counts:`);
  console.log(`  - ${finalMemories?.count || 0} memories`);
  console.log(`  - ${finalMessages?.count || 0} messages`);
  console.log(`  - ${finalPrompts?.count || 0} prompts`);
}

migrate().catch(console.error);
