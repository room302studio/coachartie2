-- Create messages table for storing Discord/SMS messages
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

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);

-- Create trigger to auto-update timestamps
CREATE TRIGGER IF NOT EXISTS update_messages_timestamp
  AFTER UPDATE ON messages
  BEGIN
    UPDATE messages SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  END;

-- Create queue table for task management
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  task_type TEXT NOT NULL,
  payload TEXT DEFAULT '{}',
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  responded BOOLEAN DEFAULT 0
);

-- Create indexes for queue
CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);
CREATE INDEX IF NOT EXISTS idx_queue_created_at ON queue(created_at);

-- Create todos table
CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'pending',
  data TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create goals table
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  target_date DATETIME,
  status TEXT DEFAULT 'active',
  progress INTEGER DEFAULT 0,
  metadata TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Add some test data for messages
INSERT INTO messages (value, user_id, message_type, channel_id)
VALUES
  ('Welcome to Coach Artie!', 'system', 'system', 'general'),
  ('How can I help you today?', 'artie', 'discord', 'general'),
  ('Test message from user', 'user123', 'discord', 'general');