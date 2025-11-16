#!/bin/bash

# Coach Artie 2 - Rebuild Script
# Usage: ./scripts/rebuild.sh [service] [--clean]
# Example: ./scripts/rebuild.sh capabilities
# Example: ./scripts/rebuild.sh capabilities --clean

SERVICE=${1:-capabilities}
CLEAN_BUILD=${2}
COMPOSE_FILE=${COMPOSE_FILE:-"docker-compose.prod.yml"}

if [ "$CLEAN_BUILD" = "--clean" ]; then
  echo "🧹 CLEAN REBUILD (force full build without cache)"
  CACHE_FLAG="--no-cache"
else
  echo "🚀 Fast rebuild with Docker layer cache (10-30s typically)"
  CACHE_FLAG=""
fi

echo ""

# Pull latest code
echo "📦 Pulling latest code..."
git pull origin main 2>&1 | tail -3

# Stop old container
echo "🛑 Stopping $SERVICE..."
docker-compose -f $COMPOSE_FILE stop $SERVICE 2>&1 || true

# Rebuild
echo "🐳 Building $SERVICE..."
echo ""

START_TIME=$(date +%s)
docker-compose -f $COMPOSE_FILE build $CACHE_FLAG $SERVICE 2>&1 | tail -10
BUILD_TIME=$(($(date +%s) - START_TIME))

if [ $? -ne 0 ]; then
  echo "❌ Build failed!"
  exit 1
fi

echo ""
echo "⏱️  Build completed in ${BUILD_TIME}s"

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
echo "✅ Done! (${BUILD_TIME}s)"
[ "$CLEAN_BUILD" != "--clean" ] && echo "Tip: Use --clean flag for full rebuild: ./scripts/rebuild.sh $SERVICE --clean"
