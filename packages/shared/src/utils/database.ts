/**
 * DEPRECATED: This module uses sql.js and is being phased out.
 *
 * For new code, use the Drizzle ORM client instead:
 * @see {@link ../db/client.ts} for the new database client
 *
 * Migration guide:
 * - Replace `getDatabase()` with `getDb()` from '@coachartie/shared'
 * - Replace `closeDatabase()` with `closeDb()` from '@coachartie/shared'
 * - Use Drizzle ORM queries instead of raw SQL where possible
 *
 * @deprecated This module will be removed in a future version
 */

import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { logger } from './logger.js';
import path from 'path';
import fs from 'fs';

let db: SqlJsDatabase | null = null;
let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;
let dbPath: string = '';
let deprecationWarningShown = false;

// Wrapper to provide async-like interface matching old sqlite API
interface RunResult {
  lastID: number;
  changes: number;
}

interface DatabaseWrapper {
  run(sql: string, params?: any[]): Promise<RunResult>;
  get<T = any>(sql: string, params?: any[]): Promise<T | undefined>;
  all<T = any>(sql: string, params?: any[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

let saveInterval: ReturnType<typeof setInterval> | null = null;

function createWrapper(database: SqlJsDatabase, filePath: string): DatabaseWrapper {
  const save = () => {
    try {
      const data = database.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(filePath, buffer);
    } catch (e) {
      // Ignore save errors during shutdown
    }
  };

  // Auto-save every 30 seconds (only set once)
  if (!saveInterval) {
    saveInterval = setInterval(save, 30000);
  }

  return {
    async run(sql: string, params: any[] = []): Promise<RunResult> {
      database.run(sql, params);
      save();
      // sql.js doesn't directly expose lastID, so we query it
      const lastIdResult = database.exec('SELECT last_insert_rowid() as lastID');
      const changesResult = database.exec('SELECT changes() as changes');
      return {
        lastID: (lastIdResult[0]?.values[0]?.[0] as number) || 0,
        changes: (changesResult[0]?.values[0]?.[0] as number) || 0,
      };
    },

    async get<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
      const stmt = database.prepare(sql);
      stmt.bind(params);
      if (stmt.step()) {
        const row = stmt.getAsObject() as T;
        stmt.free();
        return row;
      }
      stmt.free();
      return undefined;
    },

    async all<T = any>(sql: string, params: any[] = []): Promise<T[]> {
      const results: T[] = [];
      const stmt = database.prepare(sql);
      stmt.bind(params);
      while (stmt.step()) {
        results.push(stmt.getAsObject() as T);
      }
      stmt.free();
      return results;
    },

    async exec(sql: string): Promise<void> {
      database.exec(sql);
      save();
    },

    async close(): Promise<void> {
      if (saveInterval) {
        clearInterval(saveInterval);
        saveInterval = null;
      }
      save();
      database.close();
    },
  };
}

/**
 * Get the legacy sql.js database instance.
 *
 * @deprecated Use `getDb()` from '@coachartie/shared' instead.
 * This function uses sql.js which is being phased out in favor of Drizzle ORM with better-sqlite3.
 *
 * @example
 * ```typescript
 * // OLD (deprecated):
 * import { getDatabase } from '@coachartie/shared';
 * const db = await getDatabase();
 *
 * // NEW (recommended):
 * import { getDb } from '@coachartie/shared';
 * const db = getDb();
 * ```
 *
 * @returns Promise resolving to a DatabaseWrapper instance
 */
export async function getDatabase(): Promise<DatabaseWrapper> {
  if (!deprecationWarningShown) {
    console.warn(
      'DEPRECATED: getDatabase() is deprecated. Use getDb() from @coachartie/shared instead.'
    );
    deprecationWarningShown = true;
  }

  if (db) {
    return createWrapper(db, dbPath);
  }

  try {
    // Initialize sql.js
    if (!SQL) {
      SQL = await initSqlJs();
    }

    // Use environment variable for database path, with fallback
    dbPath = process.env.DATABASE_PATH || '/app/data/coachartie.db';

    // Ensure the directory exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // Load existing database or create new one
    if (fs.existsSync(dbPath)) {
      try {
        const fileBuffer = fs.readFileSync(dbPath);
        db = new SQL.Database(fileBuffer);
        logger.info(`🗄️ SQLite database loaded: ${dbPath} (sql.js WASM)`);
      } catch (loadError) {
        const errorMsg = loadError instanceof Error ? loadError.message : String(loadError);
        if (errorMsg.includes('file is not a database') || errorMsg.includes('malformed')) {
          // Database file is corrupted - back it up and create fresh
          const backupPath = `${dbPath}.corrupted.${Date.now()}`;
          logger.warn(
            `⚠️ Database file corrupted, backing up to ${backupPath} and creating fresh database`
          );
          try {
            fs.renameSync(dbPath, backupPath);
          } catch {
            // If rename fails, just delete
            fs.unlinkSync(dbPath);
          }
          db = new SQL.Database();
          logger.info(`🗄️ SQLite database created fresh: ${dbPath} (sql.js WASM)`);
        } else {
          throw loadError;
        }
      }
    } else {
      db = new SQL.Database();
      logger.info(`🗄️ SQLite database created: ${dbPath} (sql.js WASM)`);
    }

    const wrapper = createWrapper(db, dbPath);

    // Initialize database schema
    await initializeDatabase(wrapper);

    // Run migrations
    await runMigrations(wrapper);

    return wrapper;
  } catch (error) {
    logger.error('❌ Failed to connect to database:', error);
    throw error;
  }
}

async function initializeDatabase(database: DatabaseWrapper): Promise<void> {
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
        metadata TEXT DEFAULT '{}',
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
        config TEXT NOT NULL,
        description TEXT,
        is_enabled BOOLEAN DEFAULT 1,
        metadata TEXT DEFAULT '{}',
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
        raw_response TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_credit_provider_time ON credit_balance(provider, last_updated);

      -- Credit usage alerts table
      CREATE TABLE IF NOT EXISTS credit_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_type TEXT NOT NULL,
        threshold_value REAL,
        current_value REAL,
        message TEXT,
        severity TEXT DEFAULT 'info',
        acknowledged BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_alerts_type_time ON credit_alerts(alert_type, created_at);

      -- OAuth tokens table for secure token storage
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at DATETIME,
        scopes TEXT,
        metadata TEXT,
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
        embedding TEXT,
        related_message_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);
      CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);

      -- Meetings table for scheduling
      CREATE TABLE IF NOT EXISTS meetings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        scheduled_time DATETIME NOT NULL,
        duration_minutes INTEGER DEFAULT 30,
        timezone TEXT DEFAULT 'UTC',
        participants TEXT DEFAULT '[]',
        status TEXT DEFAULT 'scheduled',
        created_via TEXT DEFAULT 'api',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_meetings_user_id ON meetings(user_id);
      CREATE INDEX IF NOT EXISTS idx_meetings_scheduled_time ON meetings(scheduled_time);
      CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);

      -- Meeting participants table
      CREATE TABLE IF NOT EXISTS meeting_participants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id INTEGER NOT NULL,
        participant_id TEXT NOT NULL,
        participant_type TEXT DEFAULT 'email',
        status TEXT DEFAULT 'pending',
        responded_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_meeting_participants_meeting_id ON meeting_participants(meeting_id);

      -- Meeting reminders table
      CREATE TABLE IF NOT EXISTS meeting_reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id INTEGER NOT NULL,
        reminder_time DATETIME NOT NULL,
        sent BOOLEAN DEFAULT 0,
        sent_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_meeting_reminders_reminder_time ON meeting_reminders(reminder_time);
    `);

    // Insert default capability instructions if not exists
    await insertDefaultPrompts(database);

    logger.info('✅ Database schema initialized successfully');
  } catch (error) {
    logger.error('❌ Failed to initialize database schema:', error);
    throw error;
  }
}

async function insertDefaultPrompts(database: DatabaseWrapper): Promise<void> {
  const defaultPrompts = [
    {
      name: 'capability_instructions',
      content: 'You are Coach Artie, a helpful AI assistant with access to various capabilities.',
      description: 'Main capability instruction prompt for Coach Artie',
      category: 'capabilities',
    },
    {
      name: 'PROMPT_SYSTEM',
      content: `You are Coach Artie, a helpful AI assistant for the Metro game community.
You help players with their save files, game questions, and general chat.
Be friendly, casual, and helpful. Keep responses concise.`,
      description: 'Main system prompt for Coach Artie',
      category: 'system',
    },
    {
      name: 'PROMPT_DISCORD_UI_MODALITY',
      content: `Format your responses for Discord:
- Use **bold** for emphasis (not markdown headers)
- Keep messages under 2000 characters
- Use line breaks for readability
- Be casual and friendly`,
      description: 'Discord-specific formatting rules',
      category: 'discord',
    },
    {
      name: 'PROMPT_REFLECTION_GENERAL',
      content: 'Briefly reflect on this interaction to extract key learnings.',
      description: 'General reflection prompt after interactions',
      category: 'reflection',
    },
  ];

  try {
    for (const prompt of defaultPrompts) {
      const existing = await database.get('SELECT id FROM prompts WHERE name = ?', [prompt.name]);
      if (!existing) {
        await database.run(
          `INSERT INTO prompts (name, content, description, category, metadata)
           VALUES (?, ?, ?, ?, ?)`,
          [
            prompt.name,
            prompt.content,
            prompt.description,
            prompt.category,
            JSON.stringify({ version: '1.0.0', author: 'system' }),
          ]
        );
        logger.info(`✅ Default prompt '${prompt.name}' created`);
      }
    }
  } catch (error) {
    logger.error('❌ Failed to insert default prompts:', error);
  }
}

async function runMigrations(database: DatabaseWrapper): Promise<void> {
  try {
    logger.info('🔄 Running database migrations...');

    // Check if metadata column exists in memories table
    const columns = await database.all('PRAGMA table_info(memories)');
    const hasMetadata = columns.some((col: any) => col.name === 'metadata');

    if (!hasMetadata) {
      logger.info('📝 Adding metadata column to memories table');
      await database.exec(`ALTER TABLE memories ADD COLUMN metadata TEXT DEFAULT '{}'`);
    }

    // Check if messages table exists
    const tables = await database.all(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='messages'
    `);

    if (tables.length === 0) {
      logger.info('📝 Creating messages table');
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
          related_message_id TEXT,
          metadata TEXT DEFAULT '{}',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
        CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
      `);
    }

    // Check if global_variables table exists
    const globalVarTables = await database.all(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='global_variables'
    `);

    if (globalVarTables.length === 0) {
      logger.info('📝 Creating global_variables table');
      await database.exec(`
        CREATE TABLE IF NOT EXISTS global_variables (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          value_type TEXT DEFAULT 'string',
          description TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS global_variables_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          value_type TEXT DEFAULT 'string',
          changed_by TEXT DEFAULT 'system',
          change_reason TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
    }

    logger.info('✅ Database migrations completed');
  } catch (error) {
    logger.error('❌ Failed to run migrations:', error);
  }
}

/**
 * Close the legacy sql.js database connection.
 *
 * @deprecated Use `closeDb()` from '@coachartie/shared' instead.
 * This function uses sql.js which is being phased out in favor of Drizzle ORM with better-sqlite3.
 *
 * @example
 * ```typescript
 * // OLD (deprecated):
 * import { closeDatabase } from '@coachartie/shared';
 * await closeDatabase();
 *
 * // NEW (recommended):
 * import { closeDb } from '@coachartie/shared';
 * closeDb();
 * ```
 */
export async function closeDatabase(): Promise<void> {
  // Silently deprecated - warning shown by getDatabase() already

  if (db) {
    const wrapper = createWrapper(db, dbPath);
    await wrapper.close();
    db = null;
    logger.info('🗄️ Database connection closed');
  }
}

// Graceful shutdown
process.on('SIGINT', closeDatabase);
process.on('SIGTERM', closeDatabase);
