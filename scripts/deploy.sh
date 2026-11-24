#!/usr/bin/env bash
# Coach Artie deploy (wave 12), from your machine. The one-time migration it assumes
# (docs/notes/CUTOVER.md) happened on 2026-10-26. On the VPS itself, scripts/pm2-deploy.sh.
#
# Bundles the committed branch, ships it to prod, installs with a frozen lockfile, builds,
# and restarts the one PM2 app (coach-artie). Modeled on verify-v3.sh's bundle/fetch pattern,
# aimed at prod instead of a scratch clone.
#
# Usage:
#   scripts/deploy.sh [branch]        # default: the branch checked out locally right now.
#                                      # Prod runs `v3` (since the 2026-10-26 cutover).
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
# otherwise restart with the stale env and nobody would see an error.

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
#    docs/notes/CUTOVER.md's rollback ("re-apply the previous bundle") has something to re-apply.
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
  # .backup, not cp: in WAL mode the newest writes are still in coachartie.db-wal.
  sqlite3 data/coachartie.db ".timeout 10000" ".backup backups/coachartie-$(date +%Y%m%d-%H%M%S).db"
fi
PREV_HEAD="$(git rev-parse HEAD)"
echo "Previous HEAD: $PREV_HEAD"
pm2 jlist > "/tmp/pm2-jlist-pre-deploy-$(date +%Y%m%d-%H%M%S).json" 2>/dev/null || true

echo "--- Checking prod's working tree for local state before touching it ---"
# REFUSE, don't stash. `capabilities/data/mention-proxy-rules.json` is untracked in v3 (wave 12
# git-rm --cached it), so a clean post-cutover prod won't show it here at all — but a hand edit
# to a TRACKED file (docker-compose.yml's LUKS change is the known example) belongs in the v3
# branch, not in a stash that this script never tells anyone to pop. Stashing it "fixes" this
# run and silently reintroduces the exact same unmerged-edit problem on every future deploy.
#
# Excludes `logs` and `packages/brain` from the check (`--ignore-submodules=all` for the brain
# gitlink, `':!logs'` for the symlink): both can show as "modified" on prod for reasons that
# have nothing to do with a deploy and never should block one — brain is a separate app/PM2
# process/submodule whose checked-out commit on prod legitimately drifts from what v3's gitlink
# records, and `logs` is a machine-local symlink target. Neither is ever actually different
# between any two commits of THIS branch, so the checkout below carries both forward untouched
# either way; they're excluded from the check, not from the checkout.
DIRTY="$(git status --porcelain --untracked-files=no --ignore-submodules=all -- . ':!logs')"
if [ -n "$DIRTY" ]; then
  echo "Local changes found on prod (tracked files only — untracked files are never touched by" >&2
  echo "the plain checkout below, so they're not listed or at risk here):" >&2
  echo "$DIRTY" >&2
  echo "" >&2
  echo "REFUSING to deploy over this. Commit these changes into the v3 branch (or discard them" >&2
  echo "on purpose with 'git checkout -- <path>' after confirming what they are) and re-run." >&2
  exit 1
fi

echo "--- Fetching the bundle ---"
git fetch -q /tmp/coachartie-deploy.bundle "$BRANCH"
# No -f, no git clean, no stash: a plain checkout refuses (loudly) rather than silently
# overwriting any tracked file git doesn't expect to change, and never touches untracked files
# at all. If this fails, STOP and look at what it's protecting before re-running with --force
# by hand.
git checkout -q --detach FETCH_HEAD

echo "--- Installing (frozen lockfile) ---"
# Fails loudly, on purpose, if the committed lockfile is stale: a deploy must never silently
# regenerate it (see V3-BUILD.md's lockfile rule — that's a verify-time escape hatch, not a
# prod one).
pnpm install --frozen-lockfile

echo "--- Building ---"
# Build info first: with it, tsc emits only what it thinks changed, and after a file move that
# left dist/ missing modules and the bot dead for ~4 minutes (2026-11-24).
mv -f packages/artie/tsconfig.tsbuildinfo /tmp/coachartie-tsbuildinfo.prev 2>/dev/null || true
pnpm build

echo "--- PM2: delete + start fresh (ecosystem.config.cjs assumed current; see docs/notes/CUTOVER.md) ---"
# NOT `pm2 restart --update-env`. `--update-env` forwards THIS shell's env into the process;
# it never re-reads ecosystem.config.cjs, which is the only thing that actually loads
# .env.production (it does its own fs.readFileSync at require time, above). A routine deploy
# that ships an .env.production change would restart with the OLD env and nobody would see an
# error — the flag would just silently not apply. Delete+start re-requires the config file,
# which re-reads .env.production, every time.
pm2 delete coach-artie 2>/dev/null || true   # ok if it's not running (e.g. a prior deploy died before this step)
pm2 start ecosystem.config.cjs --only coach-artie
pm2 save

echo "--- Health check ---"
sleep 3
curl -sf http://localhost:47324/health/ready && echo "✅ engine ready" || echo "❌ engine not ready"
curl -sf http://127.0.0.1:47319/health && echo "✅ gateway healthy" || echo "❌ gateway unhealthy"

echo "✅ Deploy complete. Previous HEAD was $PREV_HEAD (for rollback: git reset --hard $PREV_HEAD && pnpm install --frozen-lockfile && pnpm build && pm2 delete coach-artie && pm2 start ecosystem.config.cjs --only coach-artie)."
REMOTE

echo "=== Done ==="
