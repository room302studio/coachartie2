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
    const dbPath = process.env.DATABASE_PATH || '/app/data/coachartie.db';

    // Ensure the directory exists
    const fs = await import('fs');
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    db = await open({
      filename: dbPath,
      driver: sqlite3.Database,
    });

    // CONCURRENCY FIXES: Enable WAL mode and set timeouts
    await db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA cache_size = 10000;
      PRAGMA temp_store = MEMORY;
      PRAGMA mmap_size = 268435456;
    `);
    await db.run('PRAGMA busy_timeout = 30000');

    logger.info(`🗄️ SQLite database connected: ${dbPath} (WAL mode enabled)`);

    // Initialize database schema
    await initializeDatabase(db);

    // Run migrations
    await runMigrations(db);

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

      -- Model usage statistics table
      CREATE TABLE IF NOT EXISTS model_usage_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_name TEXT NOT NULL,
        user_id TEXT NOT NULL,
        message_id TEXT,
        input_length INTEGER DEFAULT 0,
        output_length INTEGER DEFAULT 0,
        response_time_ms INTEGER DEFAULT 0,
        capabilities_detected INTEGER DEFAULT 0,
        capabilities_executed INTEGER DEFAULT 0,
        capability_types TEXT DEFAULT '',
        success BOOLEAN DEFAULT 1,
        error_type TEXT,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        estimated_cost REAL DEFAULT 0.0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_usage_user_time ON model_usage_stats(user_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_usage_model_time ON model_usage_stats(model_name, timestamp);
      CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON model_usage_stats(timestamp);

      -- Credit balance tracking table
      CREATE TABLE IF NOT EXISTS credit_balance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL DEFAULT 'openrouter',
        credits_remaining REAL,
        credits_used REAL,
        daily_spend REAL DEFAULT 0.0,
        monthly_spend REAL DEFAULT 0.0,
        rate_limit_remaining INTEGER,
        rate_limit_reset DATETIME,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        raw_response TEXT -- Store the full credit response for debugging
      );

      CREATE INDEX IF NOT EXISTS idx_credit_provider_time ON credit_balance(provider, last_updated);

      -- Credit usage alerts table
      CREATE TABLE IF NOT EXISTS credit_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_type TEXT NOT NULL, -- 'low_balance', 'rate_limit', 'daily_limit', etc.
        threshold_value REAL,
        current_value REAL,
        message TEXT,
        severity TEXT DEFAULT 'info', -- 'info', 'warning', 'critical'
        acknowledged BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_alerts_type_time ON credit_alerts(alert_type, created_at);

      -- OAuth tokens table for secure token storage
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL, -- 'linkedin', 'github', 'google', etc.
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at DATETIME,
        scopes TEXT, -- JSON array of scopes
        metadata TEXT, -- JSON object for provider-specific data
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, provider)
      );

      CREATE INDEX IF NOT EXISTS idx_oauth_user_provider ON oauth_tokens(user_id, provider);
      CREATE INDEX IF NOT EXISTS idx_oauth_expires ON oauth_tokens(expires_at);

      -- Memories table for user memory storage
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        context TEXT DEFAULT '',
        timestamp TEXT NOT NULL,
        importance INTEGER DEFAULT 5,
        metadata TEXT DEFAULT '{}',
        embedding TEXT, -- JSON array of embedding vectors
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);
      CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);

      -- Full-text search for memories
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content, tags, context,
        content='memories',
        content_rowid='id'
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, tags, context) 
        VALUES (new.id, new.content, new.tags, new.context);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags, context) 
        VALUES ('delete', old.id, old.content, old.tags, old.context);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags, context) 
        VALUES ('delete', old.id, old.content, old.tags, old.context);
        INSERT INTO memories_fts(rowid, content, tags, context) 
        VALUES (new.id, new.content, new.tags, new.context);
      END;

      -- Update timestamps on memories
      CREATE TRIGGER IF NOT EXISTS update_memories_timestamp 
        AFTER UPDATE ON memories
        BEGIN
          UPDATE memories SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
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
    const existing = await database.get('SELECT id FROM prompts WHERE name = ?', [
      'capability_instructions',
    ]);

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
            author: 'system',
          }),
        ]
      );

      logger.info('✅ Default capability instructions prompt created');
    }
  } catch (error) {
    logger.error('❌ Failed to insert default prompts:', error);
  }
}

async function runMigrations(database: Database): Promise<void> {
  try {
    logger.info('🔄 Running database migrations...');

    // Check if metadata column exists in memories table
    const columns = await database.all('PRAGMA table_info(memories)');
    const hasMetadata = columns.some((col: any) => col.name === 'metadata');

    if (!hasMetadata) {
      logger.info('📝 Adding metadata column to memories table');
      await database.exec(`
        ALTER TABLE memories ADD COLUMN metadata TEXT DEFAULT '{}';
      `);
      logger.info('✅ Added metadata column to memories table');
    }

    // Check if messages table exists for Discord/SMS message history
    const tables = await database.all(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='messages'
    `);

    if (tables.length === 0) {
      logger.info('📝 Creating messages table for conversation history');
      await database.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          value TEXT NOT NULL,
          user_id TEXT NOT NULL,
          message_type TEXT DEFAULT 'discord',
          channel_id TEXT,
          guild_id TEXT,
          conversation_id TEXT,
          role TEXT,
          memory_id INTEGER,
          metadata TEXT DEFAULT '{}',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
        CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
        CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id);
        CREATE INDEX IF NOT EXISTS idx_messages_guild_id ON messages(guild_id);
        CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);

        CREATE TRIGGER IF NOT EXISTS update_messages_timestamp
          AFTER UPDATE ON messages
          BEGIN
            UPDATE messages SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
          END;
      `);
      logger.info('✅ Created messages table for conversation history');
    }

    logger.info('✅ Database migrations completed');
  } catch (error) {
    logger.error('❌ Failed to run migrations:', error);
    // Don't throw - migrations should be non-fatal
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
