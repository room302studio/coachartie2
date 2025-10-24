#!/bin/bash
# Coach Artie 2 - Database Backup Script
# Backs up the SQLite database with timestamp

set -e

# Configuration
PROJECT_DIR="/Users/ejfox/code/coachartie2"
DB_PATH="$PROJECT_DIR/packages/capabilities/data/coachartie.db"
BACKUP_DIR="$PROJECT_DIR/backups"
TIMESTAMP=$(date +"%Y%m%d-%H%M%S")
BACKUP_FILE="$BACKUP_DIR/coachartie-$TIMESTAMP.db"

# Keep only last 48 backups (2 days if running hourly)
MAX_BACKUPS=48

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Check if database exists
if [ ! -f "$DB_PATH" ]; then
  echo "❌ Database not found: $DB_PATH"
  exit 1
fi

# Create backup
echo "🔄 Backing up database..."
cp "$DB_PATH" "$BACKUP_FILE"

# Verify backup
if [ -f "$BACKUP_FILE" ]; then
  SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
  echo "✅ Backup created: $BACKUP_FILE ($SIZE)"
else
  echo "❌ Backup failed!"
  exit 1
fi

# Clean up old backups (keep last MAX_BACKUPS)
echo "🧹 Cleaning old backups (keeping last $MAX_BACKUPS)..."
ls -t "$BACKUP_DIR"/coachartie-*.db 2>/dev/null | tail -n +$((MAX_BACKUPS + 1)) | xargs rm -f 2>/dev/null || true

# Count remaining backups
BACKUP_COUNT=$(ls "$BACKUP_DIR"/coachartie-*.db 2>/dev/null | wc -l | tr -d ' ')
echo "📊 Total backups: $BACKUP_COUNT"

echo "✅ Backup complete!"
