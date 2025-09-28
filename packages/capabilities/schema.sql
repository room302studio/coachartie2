-- Coach Artie 2 Complete Database Schema
-- Single source of truth for all database tables
-- Run this to initialize a fresh database

-- =====================================================
-- CORE TABLES
-- =====================================================

-- Messages table for Discord, SMS, and other communications
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  value TEXT NOT NULL,
  user_id TEXT NOT NULL,
  message_type TEXT DEFAULT 'discord', -- 'discord', 'sms', 'email', 'system'
  channel_id TEXT,
  guild_id TEXT,
  conversation_id TEXT,
  role TEXT, -- 'user', 'assistant', 'system'
  memory_id INTEGER,
  parent_message_id INTEGER,
  metadata TEXT DEFAULT '{}',
  embedding TEXT, -- JSON array of embedding vectors
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (memory_id) REFERENCES memories(id),
  FOREIGN KEY (parent_message_id) REFERENCES messages(id)
);

-- Memories table for long-term storage
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]', -- JSON array
  context TEXT DEFAULT '',
  timestamp TEXT NOT NULL,
  importance INTEGER DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  metadata TEXT DEFAULT '{}', -- JSON object
  embedding TEXT, -- JSON array of embedding vectors
  related_message_id INTEGER,
  cluster_id TEXT,
  memory_type TEXT DEFAULT 'general',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (related_message_id) REFERENCES messages(id)
);

-- User identities for cross-platform identification
CREATE TABLE IF NOT EXISTS user_identities (
  id TEXT PRIMARY KEY,
  discord_id TEXT UNIQUE,
  phone_number TEXT UNIQUE,
  email TEXT UNIQUE,
  display_name TEXT NOT NULL,
  preferred_channel TEXT DEFAULT 'discord',
  metadata TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- TASK MANAGEMENT
-- =====================================================

-- Queue for task processing
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  task_type TEXT NOT NULL,
  priority INTEGER DEFAULT 0,
  payload TEXT DEFAULT '{}', -- JSON object
  result TEXT, -- JSON object
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  assigned_to TEXT, -- Worker ID
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  completed_at DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Todos for task tracking
CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
  priority INTEGER DEFAULT 0,
  due_date DATETIME,
  completed_at DATETIME,
  data TEXT DEFAULT '{}', -- JSON object
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Goals for long-term objectives
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  target_date DATETIME,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'abandoned')),
  progress INTEGER DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  milestones TEXT DEFAULT '[]', -- JSON array
  metadata TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- CONFIGURATION & PROMPTS
-- =====================================================

-- Prompts for AI interactions
CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  content TEXT NOT NULL,
  description TEXT,
  category TEXT DEFAULT 'general',
  variables TEXT DEFAULT '[]', -- JSON array of required variables
  is_active BOOLEAN DEFAULT 1,
  metadata TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Prompt history for versioning
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

-- Capabilities configuration
CREATE TABLE IF NOT EXISTS capabilities_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL, -- JSON object
  description TEXT,
  is_enabled BOOLEAN DEFAULT 1,
  metadata TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- ANALYTICS & MONITORING
-- =====================================================

-- Model usage statistics
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
  capability_types TEXT DEFAULT '', -- Comma-separated list
  success BOOLEAN DEFAULT 1,
  error_type TEXT,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  estimated_cost REAL DEFAULT 0.0,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

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
  raw_response TEXT -- Full credit response for debugging
);

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

-- =====================================================
-- OAUTH & INTEGRATIONS
-- =====================================================

-- OAuth tokens for external services
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

-- =====================================================
-- FULL-TEXT SEARCH
-- =====================================================

-- FTS for memories
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, tags, context,
  content='memories',
  content_rowid='id'
);

-- FTS for messages
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  value,
  content='messages',
  content_rowid='id'
);

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================

-- Messages indexes
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_message_type ON messages(message_type);

-- Memories indexes
CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);
CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
CREATE INDEX IF NOT EXISTS idx_memories_memory_type ON memories(memory_type);
CREATE INDEX IF NOT EXISTS idx_memories_cluster_id ON memories(cluster_id);

-- Queue indexes
CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);
CREATE INDEX IF NOT EXISTS idx_queue_created_at ON queue(created_at);
CREATE INDEX IF NOT EXISTS idx_queue_priority ON queue(priority);
CREATE INDEX IF NOT EXISTS idx_queue_task_type ON queue(task_type);

-- User identities indexes
CREATE INDEX IF NOT EXISTS idx_user_identities_discord_id ON user_identities(discord_id);
CREATE INDEX IF NOT EXISTS idx_user_identities_phone_number ON user_identities(phone_number);
CREATE INDEX IF NOT EXISTS idx_user_identities_email ON user_identities(email);

-- Model usage indexes
CREATE INDEX IF NOT EXISTS idx_usage_user_time ON model_usage_stats(user_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_usage_model_time ON model_usage_stats(model_name, timestamp);
CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON model_usage_stats(timestamp);

-- Other indexes
CREATE INDEX IF NOT EXISTS idx_prompts_name_active ON prompts(name, is_active);
CREATE INDEX IF NOT EXISTS idx_prompts_category ON prompts(category);
CREATE INDEX IF NOT EXISTS idx_capabilities_name_enabled ON capabilities_config(name, is_enabled);
CREATE INDEX IF NOT EXISTS idx_credit_provider_time ON credit_balance(provider, last_updated);
CREATE INDEX IF NOT EXISTS idx_alerts_type_time ON credit_alerts(alert_type, created_at);
CREATE INDEX IF NOT EXISTS idx_oauth_user_provider ON oauth_tokens(user_id, provider);
CREATE INDEX IF NOT EXISTS idx_oauth_expires ON oauth_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_todos_user_status ON todos(user_id, status);
CREATE INDEX IF NOT EXISTS idx_goals_user_status ON goals(user_id, status);

-- =====================================================
-- TRIGGERS
-- =====================================================

-- Auto-update timestamps
CREATE TRIGGER IF NOT EXISTS update_messages_timestamp
  AFTER UPDATE ON messages
  BEGIN
    UPDATE messages SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS update_memories_timestamp
  AFTER UPDATE ON memories
  BEGIN
    UPDATE memories SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS update_queue_timestamp
  AFTER UPDATE ON queue
  BEGIN
    UPDATE queue SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS update_todos_timestamp
  AFTER UPDATE ON todos
  BEGIN
    UPDATE todos SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS update_goals_timestamp
  AFTER UPDATE ON goals
  BEGIN
    UPDATE goals SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  END;

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

CREATE TRIGGER IF NOT EXISTS update_user_identities_timestamp
  AFTER UPDATE ON user_identities
  BEGIN
    UPDATE user_identities SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS update_oauth_tokens_timestamp
  AFTER UPDATE ON oauth_tokens
  BEGIN
    UPDATE oauth_tokens SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  END;

-- Prompt history creation
CREATE TRIGGER IF NOT EXISTS create_prompt_history
  AFTER UPDATE OF content ON prompts
  BEGIN
    INSERT INTO prompt_history (prompt_id, version, content, changed_by, change_reason)
    VALUES (NEW.id, OLD.version, OLD.content, 'system', 'Content updated');

    UPDATE prompts SET version = version + 1 WHERE id = NEW.id;
  END;

-- FTS sync triggers for memories
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

-- FTS sync triggers for messages
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, value)
  VALUES (new.id, new.value);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, value)
  VALUES ('delete', old.id, old.value);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, value)
  VALUES ('delete', old.id, old.value);
  INSERT INTO messages_fts(rowid, value)
  VALUES (new.id, new.value);
END;

-- =====================================================
-- INITIAL DATA
-- =====================================================

-- Insert default prompts
INSERT OR IGNORE INTO prompts (name, content, description, category)
VALUES
  ('capability_instructions', 'You are Coach Artie...', 'Main capability instruction prompt', 'capabilities'),
  ('discord_response', 'Respond as Coach Artie...', 'Discord response template', 'discord'),
  ('sms_response', 'Brief SMS response...', 'SMS response template', 'sms');

-- Insert default configurations
INSERT OR IGNORE INTO capabilities_config (name, config, description)
VALUES
  ('discord', '{"enabled": true, "prefix": "!"}', 'Discord bot configuration'),
  ('sms', '{"enabled": true, "max_length": 160}', 'SMS configuration'),
  ('memory', '{"enabled": true, "max_memories": 10000}', 'Memory system configuration');