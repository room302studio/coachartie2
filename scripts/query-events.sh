#!/bin/bash
# Query the metro-maker event pool
# Usage: ./query-events.sh [query] [limit]
#
# Examples:
#   ./query-events.sh                              # Get last 100 events
#   ./query-events.sh "SELECT * WHERE type='click'" 50
#   ./query-events.sh recent                       # Preset: events in last hour
#   ./query-events.sh types                        # Preset: event types summary

set -euo pipefail

# Configuration
ENDPOINT="https://catalog.cloudflarestorage.com/a5d6e80b1df831981a1d0ca249cf082e/subway-builder-warehouse"
EVENT_TABLE="subway_builder_warehouse.logging.event_ingestion"
LIMIT="${2:-100}"

# Check for duckdb
if ! command -v duckdb &> /dev/null; then
    echo "❌ duckdb not found. Install: brew install duckdb"
    exit 1
fi

# Preset queries
case "${1:-all}" in
    "recent")
        QUERY="SELECT * FROM $EVENT_TABLE WHERE created_at > now() - interval 1 hour ORDER BY created_at DESC"
        ;;
    "types")
        QUERY="SELECT type, COUNT(*) as count FROM $EVENT_TABLE GROUP BY type ORDER BY count DESC"
        ;;
    "summary")
        QUERY="SELECT DATE(created_at) as date, COUNT(*) as events FROM $EVENT_TABLE GROUP BY DATE(created_at) ORDER BY date DESC LIMIT 30"
        ;;
    "all")
        QUERY="SELECT * FROM $EVENT_TABLE ORDER BY created_at DESC LIMIT $LIMIT"
        ;;
    *)
        QUERY="${1} LIMIT $LIMIT"
        ;;
esac

# Execute query
duckdb :memory: <<EOF
INSTALL iceberg; LOAD iceberg;
INSTALL httpfs; LOAD httpfs;
CREATE PERSISTENT SECRET subway_builder_warehouse (
    TYPE ICEBERG,
    TOKEN '${EVENT_API_TOKEN:-placeholder}'
);
ATTACH 'a5d6e80b1df831981a1d0ca249cf082e_subway-builder-warehouse' AS subway_builder_warehouse (
    READ_ONLY,
    TYPE ICEBERG,
    SECRET subway_builder_warehouse,
    ENDPOINT '$ENDPOINT'
);
$QUERY;
EOF
