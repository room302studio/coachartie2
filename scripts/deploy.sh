#!/usr/bin/env bash
# Coach Artie deploy (wave 12). WRITTEN, NOT RUN as part of this wave — read it, don't
# execute it, until CUTOVER.md's migration steps have happened on the VPS at least once.
#
# Bundles the committed branch, ships it to prod, installs with a frozen lockfile, builds,
# and restarts the one PM2 app (coach-artie). Modeled on verify-v3.sh's bundle/fetch pattern,
# aimed at prod instead of a scratch clone.
#
# Usage:
#   scripts/deploy.sh [branch]        # default: the branch checked out locally right now.
#                                      # Prod runs `artie-lean` today; after CUTOVER.md's
#                                      # one-time migration it runs `v3` (this repo's branch).
#                                      # There is deliberately no hardcoded default like `main`
#                                      # — `main` has never been what prod deploys from, and a
#                                      # bare invocation should ship whatever you actually have
#                                      # checked out, not a guess.
#
# Env:
#   DEPLOY_HOST   SSH host for the VPS (default: vps, i.e. your ~/.ssh/config alias)
#   DEPLOY_PATH   prod path on the VPS (default: /data2/apps/coachartie2)
#
# Every run does `pm2 delete coach-artie && pm2 start ecosystem.config.cjs --only coach-artie`,
# never `pm2 restart --update-env` — see the comment at that step. `--update-env` only forwards
# the calling shell's env; it never re-reads ecosystem.config.cjs, which is the only thing that
# loads .env.production, so a routine deploy that ships an .env.production change would
# otherwise restart with the stale env and nobody would see an error. This script assumes
# CUTOVER.md's one-time two-old-apps-to-one-new-app migration has already happened on prod.

set -euo pipefail

BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD)}"
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

echo "--- Checking prod's working tree for local state before touching it ---"
# Prod is never actually clean: capabilities/data/mention-proxy-rules.json used to be a
# tracked file the bot writes to at runtime (fixed in wave 12 — it's untracked now, but an
# older prod checkout may still show it modified), plus whatever hand-edits are sitting there
# (docker-compose.yml, etc). `checkout -f` + `clean -fd` would silently discard both. List
# first, stash (never drop), and let a normal `git checkout` fail loudly on a real conflict
# instead of eating anyone's uncommitted work.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Local changes found on prod. Listing (nothing destroyed):"
  git status --short
  STASH_MSG="deploy.sh pre-deploy stash $(date +%Y%m%d-%H%M%S)"
  git stash push -u -m "$STASH_MSG"
  echo "Stashed as: $STASH_MSG"
  echo "Review with 'git stash list' / 'git stash show -p stash@{0}' before ever dropping it."
fi

echo "--- Fetching the bundle ---"
git fetch -q /tmp/coachartie-deploy.bundle "$BRANCH"
# No -f, no git clean: a plain checkout refuses (loudly) rather than silently overwriting any
# tracked file git doesn't expect to change. If this fails, STOP and look at what it's
# protecting before re-running with --force by hand.
git checkout -q --detach FETCH_HEAD

echo "--- Installing (frozen lockfile) ---"
# Fails loudly, on purpose, if the committed lockfile is stale: a deploy must never silently
# regenerate it (see V3-BUILD.md's lockfile rule — that's a verify-time escape hatch, not a
# prod one).
pnpm install --frozen-lockfile

echo "--- Building ---"
pnpm build

echo "--- PM2: delete + start fresh (ecosystem.config.cjs assumed current; see CUTOVER.md for the one-time migration) ---"
# NOT `pm2 restart --update-env`. `--update-env` forwards THIS shell's env into the process;
# it never re-reads ecosystem.config.cjs, which is the only thing that actually loads
# .env.production (it does its own fs.readFileSync at require time, above). A routine deploy
# that ships an .env.production change would restart with the OLD env and nobody would see an
# error — the flag would just silently not apply. Delete+start re-requires the config file,
# which re-reads .env.production, every time.
pm2 delete coach-artie
pm2 start ecosystem.config.cjs --only coach-artie
pm2 save

echo "--- Health check ---"
sleep 3
curl -sf http://localhost:47324/health/ready && echo "✅ engine ready" || echo "❌ engine not ready"
curl -sf http://127.0.0.1:47319/health && echo "✅ gateway healthy" || echo "❌ gateway unhealthy"

echo "✅ Deploy complete. Previous HEAD was $PREV_HEAD (for rollback: git reset --hard $PREV_HEAD && pnpm install --frozen-lockfile && pnpm build && pm2 delete coach-artie && pm2 start ecosystem.config.cjs --only coach-artie)."
REMOTE

echo "=== Done ==="
