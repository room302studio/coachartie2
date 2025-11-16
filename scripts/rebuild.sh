#!/bin/bash

# Coach Artie 2 - Quick Local Rebuild Script
# Usage: ./scripts/rebuild.sh [service]
# Example: ./scripts/rebuild.sh capabilities

set -e

SERVICE=${1:-capabilities}
COMPOSE_FILE=${COMPOSE_FILE:-"docker-compose.prod.yml"}

echo "🔨 Rebuilding $SERVICE service..."
echo ""

# Pull latest code
echo "📦 Pulling latest code..."
git pull origin main

# Rebuild and restart the service
echo "🐳 Rebuilding and restarting $SERVICE..."
docker-compose -f $COMPOSE_FILE up --build -d $SERVICE

# Wait for it to be ready
echo "⏳ Waiting for $SERVICE to start..."
sleep 5

# Show logs
echo ""
echo "📋 Recent logs:"
docker-compose -f $COMPOSE_FILE logs --tail 20 $SERVICE

echo ""
echo "✅ Rebuild complete!"
