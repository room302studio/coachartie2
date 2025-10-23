-- Migration script to add missing tables and columns
-- Only creates what doesn't already exist

-- Add missing columns to memories table
ALTER TABLE memories ADD COLUMN memory_type TEXT DEFAULT 'general';
ALTER TABLE memories ADD COLUMN cluster_id TEXT;
ALTER TABLE memories ADD COLUMN related_message_id INTEGER;

-- Messages table (main missing table)
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
  parent_message_id INTEGER,
  metadata TEXT DEFAULT '{}',
  embedding TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (memory_id) REFERENCES memories(id),
  FOREIGN KEY (parent_message_id) REFERENCES messages(id)
);

-- User identities table
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

-- Queue table (if not exists)
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  task_type TEXT NOT NULL,
  priority INTEGER DEFAULT 0,
  payload TEXT DEFAULT '{}',
  result TEXT,
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  assigned_to TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  completed_at DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Todos table
CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
  priority INTEGER DEFAULT 0,
  due_date DATETIME,
  completed_at DATETIME,
  data TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for new tables
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_message_type ON messages(message_type);

CREATE INDEX IF NOT EXISTS idx_memories_memory_type ON memories(memory_type);
CREATE INDEX IF NOT EXISTS idx_memories_cluster_id ON memories(cluster_id);

CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);
CREATE INDEX IF NOT EXISTS idx_queue_created_at ON queue(created_at);
CREATE INDEX IF NOT EXISTS idx_queue_priority ON queue(priority);
CREATE INDEX IF NOT EXISTS idx_queue_task_type ON queue(task_type);

CREATE INDEX IF NOT EXISTS idx_todos_user_status ON todos(user_id, status);
CREATE INDEX IF NOT EXISTS idx_goals_user_status ON goals(user_id, status);

-- Create FTS for messages
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  value,
  content='messages',
  content_rowid='id'
);

-- Update timestamp triggers for new tables
CREATE TRIGGER IF NOT EXISTS update_messages_timestamp
  AFTER UPDATE ON messages
  BEGIN
    UPDATE messages SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
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

CREATE TRIGGER IF NOT EXISTS update_user_identities_timestamp
  AFTER UPDATE ON user_identities
  BEGIN
    UPDATE user_identities SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
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

-- Insert some sample messages for testing
INSERT INTO messages (value, user_id, message_type, channel_id)
VALUES
  ('Welcome to Coach Artie 2!', 'system', 'system', 'general'),
  ('Hello! How can I help you today?', 'artie', 'discord', 'general'),
  ('I need help with my workout routine', 'user123', 'discord', 'general'),
  ('I can help you create a personalized workout plan!', 'artie', 'discord', 'general'),
  ('Great, let''s start with 3 days a week', 'user123', 'discord', 'general');