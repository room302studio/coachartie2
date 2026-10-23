#!/usr/bin/env bash
# Coach Artie deploy (wave 12). WRITTEN, NOT RUN as part of this wave — read it, don't
# execute it, until CUTOVER.md's migration steps have happened on the VPS at least once.
#
# Bundles the committed branch, ships it to prod, installs with a frozen lockfile, builds,
# and restarts the one PM2 app (coach-artie). Modeled on verify-v3.sh's bundle/fetch pattern,
# aimed at prod instead of a scratch clone.
#
# Usage:
#   scripts/deploy.sh [branch]        # default branch: main
#
# Env:
#   DEPLOY_HOST   SSH host for the VPS (default: vps, i.e. your ~/.ssh/config alias)
#   DEPLOY_PATH   prod path on the VPS (default: /data2/apps/coachartie2)
#
# What it does NOT do: it never runs `pm2 restart` across an ecosystem.config.cjs change
# (CUTOVER.md's PM2 section explains why — a script change under a running app needs
# delete+start, not restart). This script assumes ecosystem.config.cjs is already current
# on prod (true after CUTOVER.md's one-time migration); it only rebuilds and restarts.

set -euo pipefail

BRANCH="${1:-main}"
DEPLOY_HOST="${DEPLOY_HOST:-vps}"
DEPLOY_PATH="${DEPLOY_PATH:-/data2/apps/coachartie2}"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

echo "=== Coach Artie deploy: $BRANCH -> $DEPLOY_HOST:$DEPLOY_PATH ==="

# 1. Refuse an unclean tree — same rule as verify-v3.sh. Deploying uncommitted work means
#    the next person to read prod's git log can't tell what's actually running.
git diff --quiet && git diff --cached --quiet || {
  echo "UNCOMMITTED CHANGES: commit first" >&2
  exit 1
}

# 2. Bundle the branch and ship it. A bundle (not rsync) means prod's git history stays
#    real — `git log`, `git rev-parse HEAD` on the VPS keep meaning what they say, and
#    CUTOVER.md's rollback ("re-apply the previous bundle") has something to re-apply.
echo "📦 Bundling $BRANCH..."
git bundle create "$SCRATCH/deploy.bundle" "$BRANCH"
scp -q "$SCRATCH/deploy.bundle" "$DEPLOY_HOST:/tmp/coachartie-deploy.bundle"

echo "🚀 Deploying on $DEPLOY_HOST..."
ssh "$DEPLOY_HOST" "DEPLOY_PATH='$DEPLOY_PATH' BRANCH='$BRANCH' bash -s" <<'REMOTE'
set -euo pipefail
cd "$DEPLOY_PATH"

echo "--- Pre-deploy: backup + state (for rollback) ---"
mkdir -p "$DEPLOY_PATH/backups"
if [ -f data/coachartie.db ]; then
  cp data/coachartie.db "backups/coachartie-$(date +%Y%m%d-%H%M%S).db"
fi
PREV_HEAD="$(git rev-parse HEAD)"
echo "Previous HEAD: $PREV_HEAD"
pm2 jlist > "/tmp/pm2-jlist-pre-deploy-$(date +%Y%m%d-%H%M%S).json" 2>/dev/null || true

echo "--- Fetching the bundle ---"
git fetch -q /tmp/coachartie-deploy.bundle "$BRANCH"
git checkout -q -f --detach FETCH_HEAD
git clean -qfd -e node_modules -e '**/node_modules' -e data -e logs -e .env -e .env.production

echo "--- Installing (frozen lockfile) ---"
# Fails loudly, on purpose, if the committed lockfile is stale: a deploy must never silently
# regenerate it (see V3-BUILD.md's lockfile rule — that's a verify-time escape hatch, not a
# prod one).
pnpm install --frozen-lockfile

echo "--- Building ---"
pnpm build

echo "--- PM2: restart in place (ecosystem.config.cjs assumed current; see CUTOVER.md for the one-time migration) ---"
pm2 restart coach-artie --update-env
pm2 save

echo "--- Health check ---"
sleep 3
curl -sf http://localhost:47324/health/ready && echo "✅ engine ready" || echo "❌ engine not ready"
curl -sf http://127.0.0.1:47319/health && echo "✅ gateway healthy" || echo "❌ gateway unhealthy"

echo "✅ Deploy complete. Previous HEAD was $PREV_HEAD (for rollback: git reset --hard $PREV_HEAD && pnpm install --frozen-lockfile && pnpm build && pm2 restart coach-artie)."
REMOTE

echo "=== Done ==="
