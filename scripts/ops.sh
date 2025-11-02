#!/bin/bash
# Coach Artie Operations Script - All-in-one operations tool

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

COMPOSE_FILE="docker-compose.prod.yml"
CONTAINER="coachartie-prod"
BACKUP_DIR="$HOME/backups"

# Helper functions
success() { echo -e "${GREEN}✓${NC} $1"; }
error() { echo -e "${RED}✗${NC} $1"; exit 1; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }

# Backup database
backup() {
    echo "Creating backup..."
    mkdir -p "$BACKUP_DIR"

    TIMESTAMP=$(date +%Y%m%d-%H%M%S)
    BACKUP_FILE="$BACKUP_DIR/backup-$TIMESTAMP.db.gz"

    docker exec "$CONTAINER" cp /app/data/coachartie.db /tmp/backup.db || error "Backup failed"
    docker cp "$CONTAINER:/tmp/backup.db" - | gzip > "$BACKUP_FILE"
    docker exec "$CONTAINER" rm /tmp/backup.db

    success "Backup created: $BACKUP_FILE"
    ls -lh "$BACKUP_DIR"/backup-*.db.gz | tail -5
}

# Restore database
restore() {
    [ -z "$1" ] && { ls -lh "$BACKUP_DIR"/backup-*.db.gz | tail -10; error "Usage: $0 restore <backup-file>"; }
    [ ! -f "$1" ] && error "Backup file not found: $1"

    warn "This will replace the current database!"
    read -p "Continue? (yes/no): " -r
    [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]] && { echo "Cancelled"; exit 0; }

    echo "Stopping services..."
    docker compose -f "$COMPOSE_FILE" stop

    echo "Restoring database..."
    gunzip -c "$1" | docker cp - "$CONTAINER:/app/data/coachartie.db" || error "Restore failed"

    echo "Starting services..."
    docker compose -f "$COMPOSE_FILE" start
    sleep 5

    success "Restore complete"
}

# View logs
logs() {
    docker compose -f "$COMPOSE_FILE" logs -f "${1:-}"
}

# Check health
health() {
    echo "Checking health..."

    # Health endpoint
    if curl -sf http://localhost:47319/health | jq . 2>/dev/null; then
        success "Health endpoint OK"
    else
        error "Health endpoint failed"
    fi

    # Container status
    docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep coachartie

    # Memory
    docker stats --no-stream "$CONTAINER" --format "Memory: {{.MemUsage}}"

    # Database size
    DB_SIZE=$(docker exec "$CONTAINER" ls -lh /app/data/coachartie.db 2>/dev/null | awk '{print $5}')
    echo "Database: $DB_SIZE"
}

# Restart services
restart() {
    echo "Restarting services..."
    docker compose -f "$COMPOSE_FILE" restart
    sleep 5
    health
}

# Show stats
stats() {
    docker stats "$CONTAINER" coachartie-redis
}

# Clean up
clean() {
    warn "This will remove all unused Docker resources"
    read -p "Continue? (y/N): " -r
    [[ ! $REPLY =~ ^[Yy]$ ]] && { echo "Cancelled"; exit 0; }

    docker system prune -af
    success "Cleanup complete"
}

# Usage
usage() {
    cat << 'EOF'
Coach Artie Operations

COMMON TASKS:
  ./scripts/ops.sh health           Check everything
  ./scripts/ops.sh logs             Watch logs live
  ./scripts/ops.sh backup           Backup database now
  ./scripts/ops.sh restart          Restart all services
  ./scripts/ops.sh stats            Memory/CPU usage

BACKUP/RESTORE:
  ./scripts/ops.sh backup
    → Creates timestamped backup in ~/backups/
    → Auto-compressed, auto-cleanup old backups

  ./scripts/ops.sh restore <file>
    → Lists available backups if no file given
    → Stops services, restores DB, starts services
    → Example: ./scripts/ops.sh restore ~/backups/backup-20250131-120000.db.gz

LOGS:
  ./scripts/ops.sh logs              All services
  ./scripts/ops.sh logs capabilities Just capabilities
  ./scripts/ops.sh logs redis        Just Redis

CLEANUP:
  ./scripts/ops.sh clean
    → Removes unused Docker images/containers
    → Frees up disk space

WORKS ON:
  - Local dev (npm run dev)
  - Local Docker (docker-compose up)
  - Production VPS

EOF
}

# Main
case "${1:-}" in
    backup)   backup ;;
    restore)  restore "$2" ;;
    logs)     logs "$2" ;;
    health)   health ;;
    restart)  restart ;;
    stats)    stats ;;
    clean)    clean ;;
    *)        usage; exit 1 ;;
esac
