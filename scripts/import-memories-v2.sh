#!/bin/bash

CSV_PATH="/Users/ejfox/Downloads/memories_rows_noembeddings.csv"
DB_PATH="/Users/ejfox/code/coachartie2/packages/capabilities/data/coachartie.db"

echo "Importing memories from CSV..."
echo "CSV: $CSV_PATH"
echo "DB: $DB_PATH"

# Create a temporary SQL file for import
TMP_SQL=$(mktemp)

# Write SQL commands to temp file
cat > "$TMP_SQL" << 'SQLEOF'
-- Create temp table matching CSV structure exactly (11 columns)
CREATE TEMP TABLE csv_import (
  id TEXT,
  created_at TEXT,
  value TEXT,
  user_id TEXT,
  related_message_id TEXT,
  embedding2 TEXT,
  embedding3 TEXT,
  key TEXT,
  resource_id TEXT,
  memory_type TEXT,
  conversation_id TEXT
);

-- Import CSV with proper settings
.mode csv
.import /Users/ejfox/Downloads/memories_rows_noembeddings.csv csv_import

-- Insert from CSV into memories table, filtering and mapping columns
INSERT INTO memories (content, user_id, created_at, timestamp, related_message_id, tags, context, importance)
SELECT
  value,
  user_id,
  created_at,
  created_at,
  CASE WHEN related_message_id = '' THEN NULL ELSE related_message_id END,
  '[]',
  '',
  5
FROM csv_import
WHERE id != 'id'  -- Skip header row
  AND user_id IS NOT NULL
  AND user_id != ''
  AND user_id != 'undefined'
  AND value IS NOT NULL
  AND value != ''
  AND LENGTH(value) > 10;  -- Skip very short/invalid memories

SELECT 'Total rows in CSV: ' || (SELECT COUNT(*) FROM csv_import);
SELECT 'Imported memories: ' || changes();
SELECT 'Unique users: ' || (SELECT COUNT(DISTINCT user_id) FROM memories);
SQLEOF

# Run the SQL
sqlite3 "$DB_PATH" < "$TMP_SQL" 2>&1 | grep -v "expected 12 columns"

# Clean up
rm "$TMP_SQL"

echo "Done!"
