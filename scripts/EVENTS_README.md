# Metro Maker Event Pool Scripts

Simple Unix-style scripts for querying the metro-maker event pool. Artie can run these autonomously using his `shell` capability.

## Setup

### 1. Install Dependencies

```bash
# DuckDB (for direct queries)
brew install duckdb

# jq (for JSON parsing)
brew install jq
```

### 2. Set Environment Variable

```bash
export EVENT_API_TOKEN="your-iceberg-token"
```

Or add to `.env`:
```bash
EVENT_API_TOKEN=your-token-here
```

### 3. Make Scripts Executable

```bash
chmod +x scripts/*.sh
```

## Usage

### Option 1: Bash Script (Direct DuckDB)

```bash
# Get last 100 events
./scripts/query-events.sh

# Preset queries
./scripts/query-events.sh recent    # Last hour
./scripts/query-events.sh types     # Event types summary
./scripts/query-events.sh summary   # Daily counts

# Custom SQL query
./scripts/query-events.sh "SELECT * FROM subway_builder_warehouse.logging.event_ingestion WHERE type='click'" 50
```

### Option 2: Node.js Script (JSON output)

```bash
# Preset queries
node scripts/query-events.js recent
node scripts/query-events.js types
node scripts/query-events.js hourly

# Custom query
node scripts/query-events.js "SELECT COUNT(*) FROM subway_builder_warehouse.logging.event_ingestion"

# Pipe to jq for filtering
node scripts/query-events.js recent | jq '.[] | select(.type == "click")'
```

### Option 3: Makefile (Common queries)

```bash
# Show help
make -f scripts/events.Makefile help

# Run preset queries
make -f scripts/events.Makefile recent-events
make -f scripts/events.Makefile event-types
make -f scripts/events.Makefile hourly-stats

# Custom query
make -f scripts/events.Makefile custom-query QUERY="SELECT * WHERE type='navigation'"
```

### Option 4: Curl (If HTTP API exists)

```bash
# Update EVENT_API_URL first
export EVENT_API_URL="http://your-api.com"

./scripts/curl-events.sh recent
./scripts/curl-events.sh types
./scripts/curl-events.sh custom "type=click&limit=10"
```

## Artie Usage

Artie can run these via his shell capability:

```xml
<!-- Query recent events -->
<capability name="shell" action="execute"
  command="cd /workspace && ./scripts/query-events.sh recent" />

<!-- Get event types summary -->
<capability name="shell" action="execute"
  command="make -f scripts/events.Makefile event-types" />

<!-- Custom query with JSON parsing -->
<capability name="shell" action="execute"
  command="node scripts/query-events.js recent | jq '.[] | select(.type == \"click\") | .count'" />
```

## Event Pool Schema

The event pool is stored in Cloudflare R2 using Apache Iceberg format:

- **Catalog**: `subway_builder_warehouse`
- **Table**: `logging.event_ingestion`
- **Format**: Iceberg (queryable via DuckDB)
- **Access**: Read-only via secure token

### Available Fields (example)

- `id` - Event ID
- `type` - Event type (click, navigation, etc.)
- `created_at` - Timestamp
- `user_id` - User identifier
- `metadata` - JSON blob with event-specific data

## Unix Pipeline Examples

```bash
# Count events by type in last hour
./scripts/query-events.sh recent | jq '.[] | .type' | sort | uniq -c

# Get average events per day
node scripts/query-events.js summary | jq '[.[] | .events] | add / length'

# Find users with most events
./scripts/query-events.sh "SELECT user_id, COUNT(*) as count FROM subway_builder_warehouse.logging.event_ingestion GROUP BY user_id ORDER BY count DESC LIMIT 10"
```

## Troubleshooting

### DuckDB not found
```bash
brew install duckdb
```

### Token issues
```bash
# Check token is set
echo $EVENT_API_TOKEN

# Set token
export EVENT_API_TOKEN="your-token"
```

### Permission denied
```bash
chmod +x scripts/*.sh
```

## Philosophy

These scripts follow Unix philosophy:
- Do one thing well
- Output parseable text (JSON)
- Composable via pipes
- No unnecessary abstraction
- curl and jq are your friends
