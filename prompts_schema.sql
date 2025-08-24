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
CREATE INDEX idx_prompts_name_active ON prompts(name, is_active);
CREATE INDEX idx_prompts_category ON prompts(category);
CREATE TRIGGER update_prompts_timestamp 
        AFTER UPDATE ON prompts
        BEGIN
          UPDATE prompts SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
        END;
CREATE TRIGGER create_prompt_history 
        AFTER UPDATE OF content ON prompts
        BEGIN
          INSERT INTO prompt_history (prompt_id, version, content, changed_by, change_reason)
          VALUES (NEW.id, OLD.version, OLD.content, 'system', 'Content updated');
          
          UPDATE prompts SET version = version + 1 WHERE id = NEW.id;
        END;
