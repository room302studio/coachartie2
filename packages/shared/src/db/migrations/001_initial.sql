-- Migration: 001_initial.sql
-- Description: Initial Coach Artie database schema with all core tables
-- Version: 1.0.0
-- Author: System
-- Created: 2025-01-XX

-- ====================
-- SCHEMA VERSION TRACKING
-- ====================
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  filename TEXT NOT NULL,
  checksum TEXT NOT NULL, -- MD5 of migration content
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  execution_time_ms INTEGER DEFAULT 0,
  rollback_sql TEXT -- Optional rollback commands
);

-- ====================
-- CORE USER SYSTEM
-- ====================

-- User identities across platforms
CREATE TABLE IF NOT EXISTS user_identities (
  id TEXT PRIMARY KEY,
  discord_id TEXT,
  email TEXT,
  phone_number TEXT,
  display_name TEXT NOT NULL,
  metadata TEXT DEFAULT '{}', -- JSON
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_identities_discord_id ON user_identities(discord_id);
CREATE INDEX IF NOT EXISTS idx_user_identities_email ON user_identities(email);
CREATE INDEX IF NOT EXISTS idx_user_identities_phone ON user_identities(phone_number);

-- ====================
-- MESSAGE SYSTEM
-- ====================

-- All user messages and system responses
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  channel_id TEXT,
  guild_id TEXT,
  value TEXT NOT NULL,
  message_type TEXT DEFAULT 'user',
  response_id INTEGER,
  email_metadata TEXT DEFAULT '{}', -- JSON
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  embedding TEXT, -- Vector embedding for semantic search
  embedding_nomic TEXT, -- Nomic embedding model
  FOREIGN KEY (user_id) REFERENCES user_identities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_user_time ON messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(message_type);
CREATE INDEX IF NOT EXISTS idx_messages_embedding_nomic ON messages(embedding_nomic);

-- ====================
-- MEMORY SYSTEM
-- ====================

-- Enhanced user memory storage
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]', -- JSON array
  context TEXT DEFAULT '',
  timestamp TEXT NOT NULL,
  importance INTEGER DEFAULT 5 CHECK (importance >= 1 AND importance <= 10),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES user_identities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);
CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
CREATE INDEX IF NOT EXISTS idx_memories_user_time ON memories(user_id, timestamp DESC);

-- Full-text search for memories
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, tags, context,
  content='memories',
  content_rowid='id',
  tokenize='porter ascii'
);

-- Auto-update triggers for memories FTS
CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, tags, context) 
  VALUES (NEW.id, NEW.content, NEW.tags, NEW.context);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags, context) 
  VALUES ('delete', OLD.id, OLD.content, OLD.tags, OLD.context);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags, context) 
  VALUES ('delete', OLD.id, OLD.content, OLD.tags, OLD.context);
  INSERT INTO memories_fts(rowid, content, tags, context) 
  VALUES (NEW.id, NEW.content, NEW.tags, NEW.context);
END;

-- Auto-update timestamp trigger
CREATE TRIGGER IF NOT EXISTS update_memories_timestamp 
  AFTER UPDATE ON memories
  BEGIN
    UPDATE memories SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  END;

-- ====================
-- TASK QUEUE SYSTEM
-- ====================

-- Distributed async task queue
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_type TEXT NOT NULL,
  payload TEXT NOT NULL, -- JSON
  priority INTEGER DEFAULT 5 CHECK (priority >= 1 AND priority <= 10),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
  retries INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  error_message TEXT,
  assigned_to TEXT,
  created_by TEXT,
  respond_to TEXT, -- JSON
  responded INTEGER DEFAULT 0,
  memorized INTEGER DEFAULT 0,
  metadata TEXT DEFAULT '{}', -- JSON
  scheduled_for TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);
CREATE INDEX IF NOT EXISTS idx_queue_scheduled_for ON queue(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_queue_priority_created ON queue(priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_queue_task_type ON queue(task_type);
CREATE INDEX IF NOT EXISTS idx_queue_assigned_to ON queue(assigned_to);

-- ====================
-- CONFIGURATION SYSTEM
-- ====================

-- Dynamic prompt management
CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  content TEXT NOT NULL,
  description TEXT,
  category TEXT DEFAULT 'general',
  is_active BOOLEAN DEFAULT 1,
  metadata TEXT DEFAULT '{}', -- JSON
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_prompts_name_active ON prompts(name, is_active);
CREATE INDEX IF NOT EXISTS idx_prompts_category ON prompts(category);
CREATE INDEX IF NOT EXISTS idx_prompts_active ON prompts(is_active);

-- Prompt version history
CREATE TABLE IF NOT EXISTS prompt_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  changed_by TEXT DEFAULT 'system',
  change_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (prompt_id) REFERENCES prompts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_prompt_history_prompt_version ON prompt_history(prompt_id, version);

-- Capabilities configuration
CREATE TABLE IF NOT EXISTS capabilities_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL, -- JSON
  description TEXT,
  is_enabled BOOLEAN DEFAULT 1,
  metadata TEXT DEFAULT '{}', -- JSON
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_capabilities_name_enabled ON capabilities_config(name, is_enabled);

-- System configuration key-value store
CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_key TEXT NOT NULL UNIQUE,
  config_value TEXT NOT NULL,
  notes TEXT,
  history TEXT DEFAULT '[]', -- JSON array of changes
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_config_key ON config(config_key);

-- ====================
-- MONITORING & ANALYTICS
-- ====================

-- AI model usage tracking
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
  capability_types TEXT DEFAULT '', -- comma-separated list
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
CREATE INDEX IF NOT EXISTS idx_usage_success ON model_usage_stats(success);

-- Credit balance tracking
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
  raw_response TEXT -- Full API response for debugging
);

CREATE INDEX IF NOT EXISTS idx_credit_provider_time ON credit_balance(provider, last_updated);

-- Credit usage alerts
CREATE TABLE IF NOT EXISTS credit_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_type TEXT NOT NULL, -- 'low_balance', 'rate_limit', 'daily_limit', etc.
  threshold_value REAL,
  current_value REAL,
  message TEXT,
  severity TEXT DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  acknowledged BOOLEAN DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_alerts_type_time ON credit_alerts(alert_type, created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_severity_ack ON credit_alerts(severity, acknowledged);

-- ====================
-- UTILITY TABLES
-- ====================

-- System logging
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error', 'fatal')),
  message TEXT NOT NULL,
  service TEXT,
  metadata TEXT DEFAULT '{}', -- JSON
  timestamp TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
CREATE INDEX IF NOT EXISTS idx_logs_service ON logs(service);

-- Task management
CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  data TEXT DEFAULT '{}', -- JSON
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
  priority INTEGER DEFAULT 5 CHECK (priority >= 1 AND priority <= 10),
  assigned_to TEXT,
  due_date TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
CREATE INDEX IF NOT EXISTS idx_todos_priority ON todos(priority DESC);
CREATE INDEX IF NOT EXISTS idx_todos_due_date ON todos(due_date);

-- ====================
-- AUTO-UPDATE TRIGGERS
-- ====================

-- Update timestamps on record changes
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

CREATE TRIGGER IF NOT EXISTS update_config_timestamp 
  AFTER UPDATE ON config
  BEGIN
    UPDATE config SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS update_todos_timestamp 
  AFTER UPDATE ON todos
  BEGIN
    UPDATE todos SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  END;

-- Version management for prompts
CREATE TRIGGER IF NOT EXISTS create_prompt_history 
  AFTER UPDATE OF content ON prompts
  BEGIN
    INSERT INTO prompt_history (prompt_id, version, content, changed_by, change_reason)
    VALUES (NEW.id, OLD.version, OLD.content, 'system', 'Content updated');
    
    UPDATE prompts SET version = version + 1 WHERE id = NEW.id;
  END;

-- ====================
-- DEFAULT DATA
-- ====================

-- Insert initial schema migration record
INSERT OR IGNORE INTO schema_migrations (version, description, filename, checksum) 
VALUES (
  '001', 
  'Initial schema with all core tables', 
  '001_initial.sql',
  'initial_schema_checksum_placeholder'
);

-- Insert default capability instructions prompt
INSERT OR IGNORE INTO prompts (name, content, description, category, metadata) 
VALUES (
  'capability_instructions',
  'You are Coach Artie, a helpful AI assistant with access to various capabilities. You can use XML tags to execute capabilities when needed.

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
1. Respond naturally to the user''s message
2. If you need to perform calculations, searches, or other actions, include the appropriate capability tags
3. You can use multiple capabilities in one response
4. Place capability tags where you want the results to appear in your response

User''s message: {{USER_MESSAGE}}',
  'Main capability instruction prompt for Coach Artie',
  'capabilities',
  '{"variables": ["USER_MESSAGE"], "version": "1.0.0", "author": "system"}'
);

-- Insert initial system configuration
INSERT OR IGNORE INTO config (config_key, config_value, notes) VALUES 
('schema_version', '001', 'Current database schema version'),
('app_version', '2.0.0', 'Coach Artie application version'),
('migration_lock', '0', 'Migration lock flag (0=unlocked, 1=locked)'),
('last_migration', '001_initial.sql', 'Last successfully applied migration'),
('database_created', datetime('now'), 'When this database was initially created');

-- ====================
-- ROLLBACK INSTRUCTIONS
-- ====================

-- To rollback this migration (DANGEROUS - will lose all data):
-- DROP TABLE IF EXISTS schema_migrations;
-- DROP TABLE IF EXISTS user_identities;
-- DROP TABLE IF EXISTS messages;
-- DROP TABLE IF EXISTS memories;
-- DROP VIRTUAL TABLE IF EXISTS memories_fts;
-- DROP TABLE IF EXISTS queue;
-- DROP TABLE IF EXISTS prompts;
-- DROP TABLE IF EXISTS prompt_history;
-- DROP TABLE IF EXISTS capabilities_config;
-- DROP TABLE IF EXISTS config;
-- DROP TABLE IF EXISTS model_usage_stats;
-- DROP TABLE IF EXISTS credit_balance;
-- DROP TABLE IF EXISTS credit_alerts;
-- DROP TABLE IF EXISTS logs;
-- DROP TABLE IF EXISTS todos;