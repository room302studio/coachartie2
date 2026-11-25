#!/bin/bash

# Coach Artie 2 - PM2 Native Deploy Script
# Always builds before restarting to prevent stale dist/ issues
#
# One process (wave 9/12): engine + gateway run as the single PM2 app `coach-artie`.
# Prod deploys from the v3 branch (since the 2026-10-26 cutover, docs/notes/CUTOVER.md).
#
# Usage: ./scripts/pm2-deploy.sh

set -euo pipefail

ROOT_DIR="/data2/apps/coachartie2"
BRANCH="v3"

cd "$ROOT_DIR"

echo "========================================"
echo "  Coach Artie PM2 Deploy ($BRANCH)"
echo "========================================"
echo ""

# 1. Pull latest code. Fast-forward only: prod never gets a merge commit of its own. And only
# from v3: a pull on some other checked-out branch would deploy that branch instead.
CURRENT="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT" != "$BRANCH" ]; then
  echo "REFUSING: prod has '$CURRENT' checked out, not '$BRANCH'." >&2
  exit 1
fi
echo "📦 Pulling latest $BRANCH..."
git pull --ff-only origin "$BRANCH" 2>&1 | tail -5
echo ""

# 2. Install dependencies (in case package.json changed)
echo "📥 Installing dependencies..."
pnpm install --frozen-lockfile 2>&1 | tail -3
echo ""

# 3. Build ALL packages (critical - prevents stale dist/). The build info goes first: with it,
# tsc emits only what it thinks changed, and after a file move that left dist/ missing modules
# and the bot dead for ~4 minutes (2026-11-24).
echo "🔎 Type-checking src and tests..."
(cd packages/artie && npm run -s typecheck)   # a type error stops the deploy here (set -e)
echo "🔨 Building all packages..."
rm -f packages/artie/tsconfig.tsbuildinfo   # a cache; if it can't go, stop (set -e)
pnpm build
echo ""

# 4. Restart the service. Wave 12 collapsed capabilities+discord into one PM2 app,
# coach-artie (see ecosystem.config.cjs, docs/notes/CUTOVER.md). NOT `pm2 restart --update-env`:
# ecosystem.config.cjs does its own fs.readFileSync of .env.production at require time —
# that's the ONLY thing that reads .env.production — and `--update-env` only forwards the
# calling shell's env, it never re-requires the config file. A routine deploy that ships an
# .env.production change would restart with the stale env and nobody would see an error.
# Delete+start forces the config file to be re-required, which re-reads .env.production.
echo "🔄 Restarting coach-artie..."
pm2 delete coach-artie 2>/dev/null || true   # ok if it's not running already
pm2 start ecosystem.config.cjs --only coach-artie

# 5. Wait and show status
sleep 5
echo ""
echo "📊 Service status:"
pm2 status | grep coach-artie
echo ""

# 6. Quick health check
echo "🩺 Health checks:"
sleep 3
HEALTHY=1
if curl -sf --connect-timeout 3 --max-time 10 http://127.0.0.1:47324/health/ready >/dev/null; then
  echo "  ✅ Engine healthy (:47324)"
else
  echo "  ❌ Engine unhealthy (:47324)"
  HEALTHY=0
fi
if curl -sf --connect-timeout 3 --max-time 10 http://127.0.0.1:47319/health >/dev/null; then
  echo "  ✅ Gateway healthy (:47319)"
else
  echo "  ❌ Gateway unhealthy (:47319)"
  HEALTHY=0
fi
echo ""

if [ "$HEALTHY" -ne 1 ]; then
  echo "❌ Deploy finished but a health check failed: pm2 logs coach-artie --err" >&2
  exit 1
fi
echo "✅ Deploy complete!"
