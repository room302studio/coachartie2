/**
 * Database Client for CoachArtie
 *
 * Single source of truth for database connections.
 * All packages must use this client - no direct sqlite3/sql.js usage.
 */

import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from './schema.js';
import { sql } from 'drizzle-orm';

// Re-export schema for convenience
export * from './schema.js';

let db: BetterSQLite3Database<typeof schema> | null = null;
let rawDb: Database.Database | null = null;

/**
 * Get the default database path
 */
export function getDefaultDbPath(): string {
  return process.env.DATABASE_PATH || './data/coachartie.db';
}

/**
 * Get or create the database connection
 * Uses singleton pattern to prevent multiple connections
 */
export function getDb(dbPath?: string): BetterSQLite3Database<typeof schema> {
  if (db) return db;

  const path = dbPath || getDefaultDbPath();
  rawDb = new Database(path);

  // Enable WAL mode for better concurrent access
  rawDb.pragma('journal_mode = WAL');

  db = drizzle(rawDb, { schema });
  return db;
}

/**
 * Get the raw better-sqlite3 database for advanced operations
 */
export function getRawDb(dbPath?: string): Database.Database {
  if (rawDb) return rawDb;

  // This will also initialize db
  getDb(dbPath);
  return rawDb!;
}

/**
 * Close the database connection
 */
export function closeDb(): void {
  if (rawDb) {
    rawDb.close();
    rawDb = null;
    db = null;
  }
}

/**
 * Initialize database with schema (creates tables if they don't exist)
 * This is safe to run multiple times
 */
export function initializeDb(dbPath?: string): BetterSQLite3Database<typeof schema> {
  const database = getDb(dbPath);
  const raw = getRawDb();

  // Create tables if they don't exist using raw SQL
  // This ensures backward compatibility and doesn't require migrations for initial setup

  // Memories table
  raw.exec(`
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
    )
  `);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id)`);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp)`);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance)`);

  // Messages table
  raw.exec(`
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
    )
  `);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id)`);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)`);

  // Prompts table
  raw.exec(`
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
    )
  `);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_prompts_name_active ON prompts(name, is_active)`);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_prompts_category ON prompts(category)`);

  // Prompt history table
  raw.exec(`
    CREATE TABLE IF NOT EXISTS prompt_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      changed_by TEXT,
      change_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (prompt_id) REFERENCES prompts(id)
    )
  `);

  // Capabilities config table
  raw.exec(`
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
    )
  `);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_capabilities_name_enabled ON capabilities_config(name, is_enabled)`);

  // Global variables table
  raw.exec(`
    CREATE TABLE IF NOT EXISTS global_variables (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      value_type TEXT DEFAULT 'string',
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Global variables history table
  raw.exec(`
    CREATE TABLE IF NOT EXISTS global_variables_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      value_type TEXT DEFAULT 'string',
      changed_by TEXT DEFAULT 'system',
      change_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Model usage stats table
  raw.exec(`
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
    )
  `);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_usage_user_time ON model_usage_stats(user_id, timestamp)`);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_usage_model_time ON model_usage_stats(model_name, timestamp)`);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON model_usage_stats(timestamp)`);

  // Credit balance table
  raw.exec(`
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
    )
  `);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_credit_provider_time ON credit_balance(provider, last_updated)`);

  // Credit alerts table
  raw.exec(`
    CREATE TABLE IF NOT EXISTS credit_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_type TEXT NOT NULL,
      threshold_value REAL,
      current_value REAL,
      message TEXT,
      severity TEXT DEFAULT 'info',
      acknowledged BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_alerts_type_time ON credit_alerts(alert_type, created_at)`);

  // OAuth tokens table
  raw.exec(`
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
    )
  `);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_oauth_user_provider ON oauth_tokens(user_id, provider)`);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_oauth_expires ON oauth_tokens(expires_at)`);

  // Meetings table
  raw.exec(`
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
    )
  `);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_meetings_user_id ON meetings(user_id)`);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_meetings_scheduled_time ON meetings(scheduled_time)`);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status)`);

  // Meeting participants table
  raw.exec(`
    CREATE TABLE IF NOT EXISTS meeting_participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL,
      participant_id TEXT NOT NULL,
      participant_type TEXT DEFAULT 'email',
      status TEXT DEFAULT 'pending',
      responded_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    )
  `);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_meeting_participants_meeting_id ON meeting_participants(meeting_id)`);

  // Meeting reminders table
  raw.exec(`
    CREATE TABLE IF NOT EXISTS meeting_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL,
      reminder_time DATETIME NOT NULL,
      sent BOOLEAN DEFAULT 0,
      sent_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    )
  `);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_meeting_reminders_reminder_time ON meeting_reminders(reminder_time)`);

  // Todo lists table
  raw.exec(`
    CREATE TABLE IF NOT EXISTS todo_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      goal_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, name)
    )
  `);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_todo_lists_user_id ON todo_lists(user_id)`);

  // Todo items table
  raw.exec(`
    CREATE TABLE IF NOT EXISTS todo_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      position INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      FOREIGN KEY (list_id) REFERENCES todo_lists(id) ON DELETE CASCADE
    )
  `);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_todo_items_list_id ON todo_items(list_id)`);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_todo_items_status ON todo_items(status)`);

  // Goals table
  raw.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'active',
      priority INTEGER DEFAULT 5,
      target_date DATETIME,
      progress INTEGER DEFAULT 0,
      metadata TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_goals_user_id ON goals(user_id)`);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status)`);

  return database;
}

/**
 * Check if running in an environment that requires sql.js (browser/worker)
 * In those cases, use the legacy database.ts utilities
 */
export function requiresSqlJs(): boolean {
  // Check for browser environment
  if (typeof globalThis !== 'undefined' && 'window' in globalThis) return true;

  // Check for Cloudflare Workers
  if (typeof globalThis !== 'undefined' && 'caches' in globalThis) return true;

  return false;
}

// Export the drizzle instance type for use in other packages
export type DbClient = BetterSQLite3Database<typeof schema>;

/**
 * Sync database wrapper - provides a synchronous API compatible with legacy code
 * This wraps better-sqlite3 with methods that look like the old async API
 * but actually execute synchronously.
 */
export interface SyncDbWrapper {
  get<T = any>(sql: string, params?: any[]): T | undefined;
  all<T = any>(sql: string, params?: any[]): T[];
  run(sql: string, params?: any[]): { changes: number; lastInsertRowid: number | bigint };
  exec(sql: string): void;
  close(): void;
}

/**
 * Get a sync database wrapper that provides a simple API for raw SQL queries
 * This is useful for migrating from sql.js while still using raw SQL
 */
export function getSyncDb(): SyncDbWrapper {
  const raw = getRawDb();

  return {
    get<T = any>(sql: string, params: any[] = []): T | undefined {
      return raw.prepare(sql).get(...params) as T | undefined;
    },

    all<T = any>(sql: string, params: any[] = []): T[] {
      return raw.prepare(sql).all(...params) as T[];
    },

    run(sql: string, params: any[] = []): { changes: number; lastInsertRowid: number | bigint } {
      const result = raw.prepare(sql).run(...params);
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    },

    exec(sql: string): void {
      raw.exec(sql);
    },

    close(): void {
      raw.close();
    },
  };
}
