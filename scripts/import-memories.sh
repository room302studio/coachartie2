#!/bin/bash

CSV_PATH="/Users/ejfox/Downloads/memories_rows_noembeddings.csv"
DB_PATH="/Users/ejfox/code/coachartie2/packages/capabilities/data/coachartie.db"

echo "Importing memories from CSV..."
echo "CSV: $CSV_PATH"
echo "DB: $DB_PATH"

# Create a temporary SQL file for import
TMP_SQL=$(mktemp)

# Write SQL commands to temp file
cat > "$TMP_SQL" << 'EOF'
.mode csv
.headers on
CREATE TEMP TABLE temp_import AS SELECT * FROM memories WHERE 0;
.import /Users/ejfox/Downloads/memories_rows_noembeddings.csv temp_import

-- Insert from temp table, mapping columns correctly
INSERT INTO memories (content, user_id, created_at, timestamp, related_message_id, tags, context, importance)
SELECT
  value as content,
  user_id,
  created_at,
  created_at as timestamp,
  NULLIF(related_message_id, '') as related_message_id,
  '[]' as tags,
  '' as context,
  5 as importance
FROM temp_import
WHERE user_id IS NOT NULL
  AND user_id != ''
  AND user_id != 'undefined'
  AND value IS NOT NULL
  AND value != '';

SELECT 'Imported ' || changes() || ' memories';
EOF

# Run the SQL
sqlite3 "$DB_PATH" < "$TMP_SQL"

# Clean up
rm "$TMP_SQL"

echo "Done!"
