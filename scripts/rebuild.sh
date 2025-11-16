#!/bin/bash

# Coach Artie 2 - Quick Local Rebuild Script
# Usage: ./scripts/rebuild.sh [service]
# Example: ./scripts/rebuild.sh capabilities

SERVICE=${1:-capabilities}
COMPOSE_FILE=${COMPOSE_FILE:-"docker-compose.prod.yml"}

echo "🔨 Rebuilding $SERVICE service..."
echo ""

# Pull latest code
echo "📦 Pulling latest code..."
git pull origin main 2>&1 | tail -3

# Stop and remove old container
echo "🛑 Stopping $SERVICE..."
docker-compose -f $COMPOSE_FILE stop $SERVICE 2>&1 || true

# Rebuild and restart the service
echo "🐳 Building $SERVICE (this may take a while)..."
docker-compose -f $COMPOSE_FILE build --no-cache $SERVICE 2>&1 | tail -5

echo "▶️  Starting $SERVICE..."
docker-compose -f $COMPOSE_FILE up -d $SERVICE

# Wait for it to be ready
echo "⏳ Waiting for $SERVICE to start..."
for i in {1..30}; do
  if docker-compose -f $COMPOSE_FILE ps $SERVICE | grep -q "Up"; then
    echo "✅ $SERVICE is running"
    break
  fi
  sleep 2
done

# Show recent logs
echo ""
echo "📋 Recent logs:"
docker-compose -f $COMPOSE_FILE logs --tail 15 $SERVICE

echo ""
echo "✅ Rebuild complete!"
