#!/bin/bash
# Start Artie services locally (without Docker)
cd /data2/coachartie2

# Parse .env file properly (strip comments)
while IFS='=' read -r key value; do
    # Skip comments and empty lines
    [[ $key =~ ^#.*$ ]] && continue
    [[ -z $key ]] && continue
    # Strip inline comments and trim
    value="${value%%#*}"
    value="${value%"${value##*[![:space:]]}"}"
    export "$key=$value"
done < <(grep -v '^#' .env | grep '=')

# Override for local
export REDIS_HOST=localhost
export REDIS_PORT=47320
export DATABASE_PATH=/data2/coachartie2/data/coachartie.db
export CAPABILITIES_URL=http://localhost:47324

# Kill any existing
pkill -f "node.*packages/capabilities" 2>/dev/null
pkill -f "node.*packages/discord" 2>/dev/null
sleep 2

# Start capabilities
echo "Starting capabilities..."
node packages/capabilities/dist/index.js >> /data2/coachartie2/logs/caps-local.log 2>&1 &
CAPS_PID=$!
echo "Waiting for capabilities to initialize..."

# Wait for health endpoint
for i in {1..30}; do
    if curl -s http://localhost:47324/health > /dev/null 2>&1; then
        break
    fi
    sleep 1
done

# Check if capabilities is running
if ! curl -s http://localhost:47324/health > /dev/null 2>&1; then
    echo "Capabilities failed to start!"
    tail -30 /data2/coachartie2/logs/caps-local.log
    exit 1
fi
echo "Capabilities running (PID $CAPS_PID)"

# Start discord
echo "Starting discord..."
node packages/discord/dist/index.js >> /data2/coachartie2/logs/discord-local.log 2>&1 &
DISCORD_PID=$!
sleep 10
echo "Discord running (PID $DISCORD_PID)"

echo ""
echo "Artie is running! PIDs: capabilities=$CAPS_PID discord=$DISCORD_PID"
echo "Logs:"
echo "  tail -f /data2/coachartie2/logs/caps-local.log"
echo "  tail -f /data2/coachartie2/logs/discord-local.log"
