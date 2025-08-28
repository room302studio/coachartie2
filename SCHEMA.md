# Coach Artie 2 Database Schema Documentation

## Overview

Coach Artie uses SQLite with WAL (Write-Ahead Logging) mode for data persistence, optimized for concurrent access with a hybrid data layer that combines in-memory caching with SQLite storage.

**Database Location**: `packages/capabilities/data/coachartie.db`  
**Configuration**: WAL mode, 30-second busy timeout, memory temp store  
**Version Tracking**: Automatic schema versioning with migration system  

## Architecture Pattern

### Hybrid Data Layer
The system uses a sophisticated **hot cache + cold storage** pattern:

- **Hot Cache**: In-memory storage for active data (10,000 most recent memories)
- **Cold Storage**: SQLite persistence for durability
- **Async Queue**: Serialized writes to prevent concurrency issues
- **Background Sync**: 30-second intervals for persistence

## Core Tables

### 1. User Identities
```sql
CREATE TABLE user_identities (
  id TEXT PRIMARY KEY,
  discord_id TEXT,
  email TEXT,
  phone_number TEXT,
  display_name TEXT NOT NULL,
  metadata TEXT, -- JSON
  created_at TEXT,
  updated_at TEXT
);
```

**Purpose**: Unified user identification across multiple platforms  
**Indexes**: 
- `idx_user_identities_discord_id` on `discord_id`
- `idx_user_identities_email` on `email`

**Relationships**:
- Referenced by `messages.user_id`
- Referenced by `memories.user_id`

### 2. Messages (Communication History)
```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  user_id TEXT,
  channel_id TEXT,
  guild_id TEXT,
  value TEXT,
  message_type TEXT,
  response_id INTEGER,
  email_metadata TEXT, -- JSON
  created_at TEXT, 
  embedding TEXT, 
  embedding_nomic TEXT,
  FOREIGN KEY (user_id) REFERENCES user_identities(id)
);
```

**Purpose**: Stores all user messages and system responses  
**Indexes**:
- `idx_messages_user_id` on `user_id`
- `idx_messages_created_at` on `created_at`
- `idx_messages_embedding_nomic` on `embedding_nomic`

**Features**:
- Vector embeddings for semantic search
- Multiple embedding models (standard + Nomic)
- Email metadata support
- Multi-platform message tracking (Discord, email, etc.)

### 3. Memories (Enhanced Knowledge Base)
```sql
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  context TEXT DEFAULT '',
  timestamp TEXT NOT NULL,
  importance INTEGER DEFAULT 5,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**Purpose**: User-specific memory storage with contextual metadata  
**Indexes**:
- `idx_memories_user_id` on `user_id`
- `idx_memories_timestamp` on `timestamp`
- `idx_memories_importance` on `importance`

**Features**:
- JSON tags for flexible categorization
- Importance scoring (1-10 scale)
- Context preservation
- Full-text search via FTS5

**Auto-Update Triggers**:
```sql
CREATE TRIGGER update_memories_timestamp 
  AFTER UPDATE ON memories
  BEGIN
    UPDATE memories SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  END;
```

### 4. Queue (Async Task Management)
```sql
CREATE TABLE queue (
  id INTEGER PRIMARY KEY,
  task_type TEXT NOT NULL,
  payload TEXT NOT NULL, -- JSON
  priority INTEGER DEFAULT 5,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
  retries INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  error_message TEXT,
  assigned_to TEXT,
  created_by TEXT,
  respond_to TEXT, -- JSON
  responded INTEGER DEFAULT 0,
  memorized INTEGER DEFAULT 0,
  metadata TEXT, -- JSON
  scheduled_for TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**Purpose**: Distributed task queue with retry logic and status tracking  
**Indexes**:
- `idx_queue_status` on `status`
- `idx_queue_scheduled_for` on `scheduled_for`

**Status Flow**: `pending` → `in_progress` → `completed`/`failed`/`cancelled`

## Configuration & Management Tables

### 5. Prompts (Dynamic Instruction System)
```sql
CREATE TABLE prompts (
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
```

**Purpose**: Versioned prompt management for AI capabilities  
**Features**:
- Automatic versioning on content updates
- Historical tracking via `prompt_history` table
- Category-based organization
- Metadata for variables and configuration

**Versioning Trigger**:
```sql
CREATE TRIGGER create_prompt_history 
  AFTER UPDATE OF content ON prompts
  BEGIN
    INSERT INTO prompt_history (prompt_id, version, content, changed_by, change_reason)
    VALUES (NEW.id, OLD.version, OLD.content, 'system', 'Content updated');
    
    UPDATE prompts SET version = version + 1 WHERE id = NEW.id;
  END;
```

### 6. Capabilities Configuration
```sql
CREATE TABLE capabilities_config (
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
```

**Purpose**: Runtime configuration for capability system  
**Index**: `idx_capabilities_name_enabled` on `name, is_enabled`

### 7. Configuration (System Settings)
```sql
CREATE TABLE config (
  id INTEGER PRIMARY KEY,
  config_key TEXT NOT NULL UNIQUE,
  config_value TEXT NOT NULL,
  notes TEXT,
  history TEXT, -- JSON
  created_at TEXT NOT NULL
);
```

**Purpose**: Key-value configuration store with change history

## Monitoring & Analytics Tables

### 8. Model Usage Statistics
```sql
CREATE TABLE model_usage_stats (
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
```

**Purpose**: Comprehensive AI model performance tracking  
**Indexes**:
- `idx_usage_user_time` on `user_id, timestamp`
- `idx_usage_model_time` on `model_name, timestamp`
- `idx_usage_timestamp` on `timestamp`

### 9. Credit Balance Tracking
```sql
CREATE TABLE credit_balance (
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
```

**Purpose**: Monitor API usage and spending across providers  
**Index**: `idx_credit_provider_time` on `provider, last_updated`

### 10. Credit Alerts
```sql
CREATE TABLE credit_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_type TEXT NOT NULL, -- 'low_balance', 'rate_limit', 'daily_limit', etc.
  threshold_value REAL,
  current_value REAL,
  message TEXT,
  severity TEXT DEFAULT 'info', -- 'info', 'warning', 'critical'
  acknowledged BOOLEAN DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**Purpose**: Automated alerting for usage thresholds  
**Index**: `idx_alerts_type_time` on `alert_type, created_at`

## Utility Tables

### 11. Logs (System Logging)
```sql
CREATE TABLE logs (
  id INTEGER PRIMARY KEY,
  level TEXT,
  message TEXT,
  service TEXT,
  timestamp TEXT NOT NULL
);
```

### 12. Todos (Task Management)
```sql
CREATE TABLE todos (
  id INTEGER PRIMARY KEY,
  name TEXT,
  description TEXT,
  data TEXT, -- JSON
  created_at TEXT NOT NULL
);
```

## Full-Text Search (FTS5)

### Memory Search Virtual Table
```sql
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, tags, context,
  content='memories',
  content_rowid='id'
);
```

**Purpose**: High-performance full-text search for memories  
**Auto-Sync Triggers**: Automatically maintains FTS index on INSERT/UPDATE/DELETE

**Search Examples**:
```sql
-- Basic search
SELECT * FROM memories_fts WHERE memories_fts MATCH 'pizza';

-- Phrase search
SELECT * FROM memories_fts WHERE memories_fts MATCH '"user preferences"';

-- Boolean search
SELECT * FROM memories_fts WHERE memories_fts MATCH 'pizza AND italian';
```

## Data Relationships

```
user_identities (id)
    ├── messages (user_id) [1:many]
    ├── memories (user_id) [1:many]
    └── model_usage_stats (user_id) [1:many]

prompts (id)
    └── prompt_history (prompt_id) [1:many]

messages (id)
    └── queue (response_id) [1:1, optional]
```

## Performance Optimizations

### WAL Mode Configuration
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = 10000;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;
PRAGMA busy_timeout = 30000;
```

### Hybrid Data Layer Benefits
- **Read Performance**: 99% of reads served from memory cache
- **Write Consistency**: Async queue prevents SQLite lock contention  
- **Memory Management**: LRU eviction keeps cache size bounded
- **Durability**: Background persistence ensures data safety

### Critical Indexes
All high-frequency query patterns are covered by optimized indexes:
- User-based queries: Multi-column indexes on `(user_id, timestamp)`
- Time-based queries: Standalone `timestamp` indexes
- Status filtering: Enum field indexes for queue management

## Schema Evolution

### Version Tracking
The database includes automatic schema versioning:
- `version` columns in `prompts` and `capabilities_config`
- History tables for change tracking
- Automatic triggers for version increment

### Migration Strategy
1. **Schema Migrations**: Version-controlled SQL files in `/packages/shared/src/db/migrations/`
2. **Data Transformations**: TypeScript migration scripts for complex changes
3. **Rollback Support**: Reversible migrations with down() functions
4. **Validation**: Schema health checks before and after migrations

## Security Considerations

### Data Integrity
- Foreign key constraints enforce referential integrity
- CHECK constraints validate enum values
- NOT NULL constraints prevent incomplete records
- UNIQUE constraints prevent duplicates

### JSON Field Validation
While SQLite doesn't enforce JSON schema, the application layer validates:
- `metadata` fields contain valid JSON
- `tags` arrays follow expected format
- `payload` objects match task type schemas

### Privacy & Compliance
- User data isolated by `user_id`
- Message content stored separately from metadata
- Embedding vectors can be cleared without losing message history
- Configurable data retention policies via queue system

## Monitoring & Health Checks

### Database Health Metrics
```typescript
interface DatabaseHealth {
  hotCacheSize: number;
  coldStorageConnected: boolean;
  writeQueueDepth: number;
  lastSyncTime: Date;
  diskUsage: number;
  walFileSize: number;
}
```

### Performance Monitoring
- Query execution time tracking
- Cache hit/miss ratios  
- Background sync performance
- Memory usage patterns

This schema supports Coach Artie's core functionality while maintaining excellent performance through the hybrid data layer architecture and comprehensive indexing strategy.