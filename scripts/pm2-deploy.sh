#!/bin/bash

# Coach Artie 2 - PM2 Native Deploy Script
# Always builds before restarting to prevent stale dist/ issues
#
# Usage: ./scripts/pm2-deploy.sh [service]
# Examples:
#   ./scripts/pm2-deploy.sh          # Rebuild all, restart all
#   ./scripts/pm2-deploy.sh discord  # Rebuild all, restart discord only

set -e

SERVICE=${1:-"all"}
ROOT_DIR="/data2/apps/coachartie2"

cd "$ROOT_DIR"

echo "========================================"
echo "  Coach Artie PM2 Deploy"
echo "========================================"
echo ""

# 1. Pull latest code
echo "📦 Pulling latest code..."
git pull origin main 2>&1 | tail -5
echo ""

# 2. Install dependencies (in case package.json changed)
echo "📥 Installing dependencies..."
pnpm install --frozen-lockfile 2>&1 | tail -3
echo ""

# 3. Build ALL packages (critical - prevents stale dist/)
echo "🔨 Building all packages..."
pnpm build
echo ""

# 4. Restart services
if [ "$SERVICE" = "all" ]; then
    echo "🔄 Restarting all services..."
    pm2 restart coach-artie-capabilities coach-artie-discord coach-artie-sms --update-env
else
    echo "🔄 Restarting $SERVICE..."
    pm2 restart "coach-artie-$SERVICE" --update-env
fi

# 5. Wait and show status
sleep 5
echo ""
echo "📊 Service status:"
pm2 status | grep coach-artie
echo ""

# 6. Quick health check
echo "🩺 Health checks:"
sleep 3
curl -sf http://localhost:47324/health >/dev/null && echo "  ✅ Capabilities healthy" || echo "  ❌ Capabilities unhealthy"
curl -sf http://localhost:47319/health >/dev/null && echo "  ✅ Discord healthy" || echo "  ❌ Discord unhealthy"
echo ""

echo "✅ Deploy complete!"
