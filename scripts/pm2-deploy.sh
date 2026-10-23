#!/bin/bash

# Coach Artie 2 - PM2 Native Deploy Script
# Always builds before restarting to prevent stale dist/ issues
#
# One process now (wave 9/12): engine + gateway run as the single PM2 app `coach-artie`.
# Superseded by scripts/deploy.sh (wave 12) once that has shipped once; kept until then.
#
# Usage: ./scripts/pm2-deploy.sh

set -e

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

# 4. Restart the service. Wave 12 collapsed capabilities+discord into one PM2 app,
# coach-artie (see ecosystem.config.cjs, CUTOVER.md). This script restarts in place —
# CUTOVER.md's PM2 steps (delete the two old apps, start coach-artie fresh) are the
# one-time migration; after that, `pm2 restart` here is fine for routine deploys.
echo "🔄 Restarting coach-artie..."
pm2 restart coach-artie --update-env

# 5. Wait and show status
sleep 5
echo ""
echo "📊 Service status:"
pm2 status | grep coach-artie
echo ""

# 6. Quick health check
echo "🩺 Health checks:"
sleep 3
curl -sf http://localhost:47324/health/ready >/dev/null && echo "  ✅ Engine healthy (:47324)" || echo "  ❌ Engine unhealthy (:47324)"
curl -sf http://127.0.0.1:47319/health >/dev/null && echo "  ✅ Gateway healthy (:47319)" || echo "  ❌ Gateway unhealthy (:47319)"
echo ""

echo "✅ Deploy complete!"
