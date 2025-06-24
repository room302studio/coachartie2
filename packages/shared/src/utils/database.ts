import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { logger } from './logger.js';
import path from 'path';

let db: Database<sqlite3.Database, sqlite3.Statement> | null = null;

export async function getDatabase(): Promise<Database<sqlite3.Database, sqlite3.Statement>> {
  if (db) {
    return db;
  }

  try {
    // Use environment variable for database path, with fallback
    const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'coachartie.db');
    
    // Ensure the directory exists
    const fs = await import('fs');
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    db = await open({
      filename: dbPath,
      driver: sqlite3.Database
    });

    logger.info(`🗄️ SQLite database connected: ${dbPath}`);
    
    // Initialize database schema
    await initializeDatabase(db);
    
    return db;
  } catch (error) {
    logger.error('❌ Failed to connect to database:', error);
    throw error;
  }
}

async function initializeDatabase(database: Database): Promise<void> {
  try {
    // Create prompts table with versioning and metadata
    await database.exec(`
      CREATE TABLE IF NOT EXISTS prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        version INTEGER NOT NULL DEFAULT 1,
        content TEXT NOT NULL,
        description TEXT,
        category TEXT DEFAULT 'general',
        is_active BOOLEAN DEFAULT 1,
        metadata JSONB DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_prompts_name_active ON prompts(name, is_active);
      CREATE INDEX IF NOT EXISTS idx_prompts_category ON prompts(category);
      
      -- Capabilities configuration table
      CREATE TABLE IF NOT EXISTS capabilities_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        version INTEGER NOT NULL DEFAULT 1,
        config JSONB NOT NULL,
        description TEXT,
        is_enabled BOOLEAN DEFAULT 1,
        metadata JSONB DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_capabilities_name_enabled ON capabilities_config(name, is_enabled);

      -- Prompt history table for versioning
      CREATE TABLE IF NOT EXISTS prompt_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        changed_by TEXT,
        change_reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (prompt_id) REFERENCES prompts(id)
      );

      -- Triggers to auto-update timestamps and create history
      CREATE TRIGGER IF NOT EXISTS update_prompts_timestamp 
        AFTER UPDATE ON prompts
        BEGIN
          UPDATE prompts SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
        END;

      CREATE TRIGGER IF NOT EXISTS update_capabilities_timestamp 
        AFTER UPDATE ON capabilities_config
        BEGIN
          UPDATE capabilities_config SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
        END;

      CREATE TRIGGER IF NOT EXISTS create_prompt_history 
        AFTER UPDATE OF content ON prompts
        BEGIN
          INSERT INTO prompt_history (prompt_id, version, content, changed_by, change_reason)
          VALUES (NEW.id, OLD.version, OLD.content, 'system', 'Content updated');
          
          UPDATE prompts SET version = version + 1 WHERE id = NEW.id;
        END;
    `);

    // Insert default capability instructions if not exists
    await insertDefaultPrompts(database);
    
    logger.info('✅ Database schema initialized successfully');
  } catch (error) {
    logger.error('❌ Failed to initialize database schema:', error);
    throw error;
  }
}

async function insertDefaultPrompts(database: Database): Promise<void> {
  const defaultPrompt = `You are Coach Artie, a helpful AI assistant with access to various capabilities. You can use XML tags to execute capabilities when needed.

Available capabilities:
- <capability name="calculator" action="calculate" expression="2+2" /> - Perform calculations
- <capability name="web" action="search" query="search terms" /> - Search the web
- <capability name="web" action="fetch" url="https://example.com" /> - Fetch web content
- <capability name="memory" action="remember" content="information to store" /> - Store information
- <capability name="memory" action="recall" query="what to remember" /> - Recall stored information
- <capability name="wolfram" action="query" input="moon phase today" /> - Query Wolfram Alpha for data
- <capability name="github" action="search" query="search repos" /> - Search GitHub
- <capability name="briefing" action="create" topic="topic" /> - Create briefings
- <capability name="scheduler" action="remind" message="reminder text" delay="60000" /> - Set reminder (delay in ms)
- <capability name="scheduler" action="schedule" name="task name" cron="0 9 * * *" message="task description" /> - Schedule recurring task
- <capability name="scheduler" action="list" /> - List scheduled tasks
- <capability name="scheduler" action="cancel" taskId="task-id" /> - Cancel scheduled task

Instructions:
1. Respond naturally to the user's message
2. If you need to perform calculations, searches, or other actions, include the appropriate capability tags
3. You can use multiple capabilities in one response
4. Place capability tags where you want the results to appear in your response

User's message: {{USER_MESSAGE}}`;

  try {
    // Check if default prompt exists
    const existing = await database.get(
      'SELECT id FROM prompts WHERE name = ?',
      ['capability_instructions']
    );

    if (!existing) {
      await database.run(
        `INSERT INTO prompts (name, content, description, category, metadata) 
         VALUES (?, ?, ?, ?, ?)`,
        [
          'capability_instructions',
          defaultPrompt,
          'Main capability instruction prompt for Coach Artie',
          'capabilities',
          JSON.stringify({
            variables: ['USER_MESSAGE'],
            version: '1.0.0',
            author: 'system'
          })
        ]
      );
      
      logger.info('✅ Default capability instructions prompt created');
    }
  } catch (error) {
    logger.error('❌ Failed to insert default prompts:', error);
  }
}

export async function closeDatabase(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
    logger.info('🗄️ Database connection closed');
  }
}

// Graceful shutdown
process.on('SIGINT', closeDatabase);
process.on('SIGTERM', closeDatabase);
