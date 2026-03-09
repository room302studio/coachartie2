#!/bin/bash
# Quick rebuild without full Docker image rebuild
# This is faster than 'docker compose build' because it:
# 1. Builds TypeScript directly in the running container
# 2. Restarts the process
# Usage: ./reload.sh

set -e
cd "$(dirname "$0")"

echo "🔨 Rebuilding TypeScript in container..."
docker compose exec -T capabilities sh -c "pnpm --filter @coachartie/shared build && pnpm --filter @coachartie/capabilities build"

echo "🔄 Restarting capabilities..."
docker compose restart capabilities

echo "⏳ Waiting for health..."
sleep 5

echo "🏥 Checking health..."
curl -s http://localhost:47324/health | jq .

echo "✅ Reload complete!"
