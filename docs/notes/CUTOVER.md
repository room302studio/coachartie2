# CUTOVER: v3 to prod

**RUN 2026-10-26 14:35 ET (EJ's yes).** Prod is on branch `v3` as the single `coach-artie` PM2 app.
- The step-4 sentinels, `/health/ready`, Discord (5 guilds) and `tests/smoke.sh` (4/4) all passed.
- State and backups are in `/data2/tmp/cutover-20261026-143556`, and the DB backup is in `/srv/artie/backups/coachartie.db.pre-cutover-*`.
- Rollback: `/data2/tmp/cutover-rollback.sh <state dir>`.

What the run changed vs the text below:
- The build was `pnpm --filter @coachartie/artie build`, NOT `pnpm build`. That would also build `packages/brain`, a real Nuxt app on prod.
- Checkout was `git checkout -B v3 FETCH_HEAD`, not detached.
- The DB backup was `sqlite3 .backup`, not `cp`, because it's a live WAL database.
- Step 9's `check-artie.sh` and promtail edits are done; backups of both end in `.bak-precutover-20261026`.
- The LUKS compose edit is now committed (b884cb2), so step 1's patch dance is no longer needed.

The text below is kept as written, for reference and for re-running.

Prod today: two PM2 apps (`coach-artie-capabilities`, `coach-artie-discord`), two processes,
Docker-removed-but-still-mentioned scripts. After this: one PM2 app (`coach-artie`), one
process, two ports. `coach-artie-brain` is untouched throughout.

---

## 0. Pre-flight (read-only, no state change)

Prod's tree is never actually clean — `git status` on it today shows modified
`capabilities/data/mention-proxy-rules.json` (the bot's own live runtime data — wave 12 stopped
tracking this file going forward, but a not-yet-pulled prod checkout still has it tracked and
modified, with +16 live rules prod has written since it was last checked out) and modified
`docker-compose.yml` (the LUKS edit made by hand on the box), plus several untracked
`.env*.bak-*` files.

**Do not `git stash` these.** `capabilities/data/mention-proxy-rules.json` is untracked in v3
(wave 12 `git rm --cached` it, see below) — if you stash the modified copy and then check out
v3, the checkout lands on a tree that simply has no such path tracked, git deletes the working
copy with no conflict and no warning, and the live rules sit orphaned in a stash entry nothing
in this file tells you to pop. Back up the two files you know are modified, by name, instead:

```bash
cd /data2/apps/coachartie2
git status --short                       # RECORD THIS — confirms what's modified right now
git diff docker-compose.yml > /tmp/docker-compose.luks.pre-cutover.patch
ls -la /tmp/docker-compose.luks.pre-cutover.patch
```

(`capabilities/data/mention-proxy-rules.json` is backed up in step 1, immediately before it's
discarded there, not here — the bot is still live and writing to it between this step and that
one, so a backup taken now could already be stale by the time step 1 runs.)

From the dev worktree (NOT on the VPS), bundle the branch this cutover deploys, the same way
`scripts/deploy.sh` does — not `git fetch origin`, since that pulls from GitHub and prod may not
have a configured `origin` remote pointed at the same place this branch lives:

```bash
# From /Users/ejfox/code/coachartie2-v3 (or wherever v3 is merged to its final branch):
git bundle create /tmp/coachartie-cutover.bundle v3   # or the actual merged branch name
scp /tmp/coachartie-cutover.bundle vps:/tmp/coachartie-cutover.bundle
```

On the VPS, in prod (`/data2/apps/coachartie2`):

```bash
cd /data2/apps/coachartie2
git fetch -q /tmp/coachartie-cutover.bundle v3
git log --oneline -1 FETCH_HEAD    # the v3-merged commit you're about to deploy
git rev-parse HEAD                 # RECORD THIS — the rollback target
pm2 jlist > /tmp/pm2-jlist-pre-cutover-$(date +%Y%m%d-%H%M%S).json   # RECORD THIS TOO
cat /tmp/pm2-jlist-pre-cutover-*.json | jq -r '.[].name'   # sanity: the two old app names
```

**Backup the DB** (destructive steps follow; this is the undo):

```bash
cp data/coachartie.db "data/coachartie.db.bak-cutover-$(date +%Y%m%d-%H%M%S)"
ls -lh data/coachartie.db.bak-cutover-*
```

**Check:** the docker-compose patch is non-empty; the DB backup file exists and is non-empty;
`pm2 jlist` shows exactly `coach-artie-capabilities`, `coach-artie-discord`, `coach-artie-brain`
(plus whatever else runs on this box).
**Rollback:** none needed — nothing changed yet.

---

## 1. Fetch the new code

Back up the rules file right now, fresh (the bot is still live and writing to it up to this
exact moment), then discard both known modifications by name (bounded, not a blanket stash),
check out v3, and restore the mention-proxy rules from that backup (v3 doesn't track that path,
so writing it back is a plain untracked file, not a conflict):

```bash
cd /data2/apps/coachartie2
cp capabilities/data/mention-proxy-rules.json /tmp/mention-proxy-rules.pre-cutover.json
git checkout -- capabilities/data/mention-proxy-rules.json docker-compose.yml
git checkout <the-v3-merge-commit>   # the commit from step 0
# v3's tree doesn't have this path tracked at all, so `git checkout` may have rmdir'd its
# now-empty parent directory — recreate it before writing the file back:
mkdir -p capabilities/data
cp /tmp/mention-proxy-rules.pre-cutover.json capabilities/data/mention-proxy-rules.json
diff /tmp/mention-proxy-rules.pre-cutover.json capabilities/data/mention-proxy-rules.json  # expect no output
# The LUKS docker-compose.yml edit: v3's copy has different header comments (see wave 12's
# BUILD-LOG). Re-apply the hand edit on top of the new file instead of assuming it merges clean.
# --3way implies --index, so a clean apply lands the change staged, not as a working-tree diff:
git apply --3way /tmp/docker-compose.luks.pre-cutover.patch || echo "CONFLICT: hand-merge the LUKS edit into docker-compose.yml now, then commit it to v3 as a follow-up so this step stops being manual."
```

**Check:** `git log --oneline -1` shows the expected commit; the `diff` above printed nothing
(rules file restored byte-for-byte); `docker-compose.yml` has the LUKS edit
(`git diff HEAD -- docker-compose.yml` shows exactly that one hand change — not a plain
`git diff`, since a clean `--3way` apply already staged it). Untracked `.env*.bak-*` files are
untouched throughout this step — a non-forced `git checkout` with no `git clean` never touches
untracked files, which is the actual protection here (not a stash).
**Rollback:** `git checkout <previous HEAD from step 0>` will REFUSE here —
`capabilities/data/mention-proxy-rules.json` is untracked on disk (v3 doesn't track it) but
tracked in the previous HEAD, so git sees an untracked file in the way and stops rather than
overwrite it. Move it out of the way first, with `mv` (the live file as it stands right now, not
the step-0 backup — if step 4+ already ran, the bot may have written new rules since):
```bash
mv capabilities/data/mention-proxy-rules.json /tmp/mention-proxy-rules.live.json
git checkout <previous HEAD from step 0>
cp /tmp/mention-proxy-rules.live.json capabilities/data/mention-proxy-rules.json
```
Re-apply `/tmp/docker-compose.luks.pre-cutover.patch` if the hand-merge above changed it. Every
later step's rollback that does `git checkout <previous HEAD>` needs this same three-line dance,
not a bare checkout — referenced from steps 2/3/4 below rather than repeated in full each time.

---

## 2. Lockfile + install

```bash
pnpm install --frozen-lockfile
```

**Check:** exits 0. A frozen-lockfile failure here means the committed `pnpm-lock.yaml` is
stale — **stop, do not pass `--frozen-lockfile=false` on prod.** Go back to the dev worktree,
regenerate the lockfile there (verify-v3.sh's VPS scratch-clone method, never prod), commit it,
and re-fetch.
**Rollback:** the step-1 checkout dance (move `capabilities/data/mention-proxy-rules.json` out
of the way, `git checkout <previous HEAD>`, move it back — see step 1's rollback), then
`pnpm install --frozen-lockfile` again (the old lockfile matches the old code).

---

## 3. Build

```bash
pnpm build
```

**Check:** exits 0; `packages/artie/dist/main.js` exists.
**Rollback:** same as step 2 (the step-1 checkout dance, then rebuild).

---

## 4. PM2: delete the two old apps, start the one new app

**Never `pm2 restart` across this change.** `coach-artie-capabilities`/`coach-artie-discord`
are reading the OLD `ecosystem.config.cjs` entries (different `cwd`, different `script`,
different ports binding under the OLD two-process model); restarting them in place would try
to run the new single-process code under the old process's config, or vice versa, and is a
restart loop either way. Delete, then start fresh:

```bash
# Mark where the winston combined log ends now, so the checks below (and step 10) only count
# lines from THIS boot. Boot sentinels are logger.info, and prod runs CONSOLE_LOG_LEVEL=warn,
# so they never reach `pm2 logs`; they only land in the combined file.
COMBINED=logs/app/coachartie-combined.log
MARK=$(stat -c %s "$COMBINED" 2>/dev/null || echo 0)
pm2 delete coach-artie-capabilities coach-artie-discord
pm2 start ecosystem.config.cjs --only coach-artie
pm2 save
```

**Never touch `coach-artie-brain`** in this step — it's a separate app, separate config block,
untouched by v3.

**Check:**
```bash
pm2 status                              # coach-artie: online, uptime > 0, restarts not climbing
tail -c +$((MARK+1)) "$COMBINED" | grep -c "Coach Artie is up"   # expect 1 (NOT pm2 logs: info is filtered from console)
```
If `coach-artie` is stuck `errored`/restarting: check `pm2 logs coach-artie --err --lines 100`
first — most likely a missing env var (see step 5) or a port already held by a process that
didn't get deleted (re-run `pm2 delete coach-artie` and check `pm2 jlist` is actually empty of
old entries before starting again).

**Rollback:**
```bash
pm2 delete coach-artie
# The step-1 checkout dance, not a bare checkout (capabilities/data/mention-proxy-rules.json
# is untracked now; move the live file out of the way first or this refuses — see step 1):
mv capabilities/data/mention-proxy-rules.json /tmp/mention-proxy-rules.live.json
git checkout <previous HEAD>    # back to the pre-cutover ecosystem.config.cjs + code
cp /tmp/mention-proxy-rules.live.json capabilities/data/mention-proxy-rules.json
pnpm install --frozen-lockfile && pnpm build
pm2 start ecosystem.config.cjs --only coach-artie-capabilities,coach-artie-discord
pm2 save
```

---

## 5. Env

`TOOL_LOOP` unset = native tool calls (the default, and the recommended state at cutover).
Setting `TOOL_LOOP=xml` restores the old `<capability/>` path — only use it if native tool
calls misbehave after this deploy (see the Soak section).

**v3 reads about 230 distinct environment variable names across the codebase** (most are
optional feature flags with safe defaults — a missing one usually degrades a feature, not the
boot). The full current list, by NAME only, is reproducible with:

```bash
rg -oN 'process\.env\.([A-Z_][A-Z0-9_]*)' packages/artie/src -r '$1' | sort -u
```

**Only one name is genuinely new in v3**: `TOOL_LOOP` — optional; unset is the correct default
(native tool calls). Do not set it unless rolling back. (An earlier draft of this file also
listed `AUTONOMOUS_PAUSED` as new — that was wrong. Production `e78d1f8` already reads it
today: `scheduler.ts:314`, `social-media-behavior.ts:1420`. ARCHITECTURE.md says "today prod
runs with it set." So it's an existing flag, not a new one.)

- `AUTONOMOUS_PAUSED` — **confirm it is already set before step 4**. Today it lives only in the
  root `.env` (not `.env.production`); v3 reads both via the same dotenv fallback, so check with
  `grep -c '^AUTONOMOUS_PAUSED=' .env .env.production` (expect a hit in at least one),
  the same as it is today. This cutover doesn't change the flag's meaning or its default, but if
  it is somehow NOT set going into this deploy, the proactive chain (heartbeat, morning
  briefing, proactive DMs, relay, reddit mentions, trend watcher) would run unpaused the moment
  `coach-artie` starts — so check, don't assume. `rg AUTONOMOUS_PAUSED packages/artie/src` shows
  every read site if you need to confirm the behavior before checking prod's env.

**One name is no longer read** by the bot app: `CAPABILITIES_URL` (there's no internal HTTP hop
left to point at). It's dropped from `coach-artie`'s env block in `ecosystem.config.cjs`.
`coach-artie-brain` still reads its own `CAPABILITIES_URL` (unchanged — brain still reaches the
engine over real HTTP, at :47324).

**EJ's step, before step 4:**
```bash
ls -a /data2/apps/coachartie2/.env*
ls -a /data2/apps/coachartie2/packages/capabilities/.env*
ls -a /data2/apps/coachartie2/packages/discord/.env*
```
The one-process loader reads the union of whichever of these three files exist (root `.env`,
`packages/capabilities/.env`, `packages/discord/.env`), first-wins, in that order — PM2's own
`env` block (from `.env.production`, loaded by `ecosystem.config.cjs` itself) always wins over
all three. Confirm nothing you need lives ONLY in a per-package `.env` that this ls doesn't
show, and diff the `rg` output above against your actual `.env.production` names (by name only
— don't paste values anywhere, including here) for anything genuinely new and required.

---

## 6. Logs

- Winston app logs move from `packages/{capabilities,discord}/logs/*-combined.log` to
  `logs/app/*` (same filenames: `coachartie-{combined,error,debug}.log`). The ecosystem sets
  `LOGS_DIR=<repo>/logs/app`; `<repo>/logs` is the symlink onto `/srv/artie/logs`, so these
  logs (which carry message content) are now encrypted at rest. The old
  `packages/{capabilities,discord}/logs` dirs were plain disk (618M on 2026-10-26). After the
  soak, move or delete them, and only with EJ's yes.
- PM2 out/error logs: the new `ecosystem.config.cjs` writes `logs/coach-artie-{out,error}.log`
  (named to match `vitals.ts`'s in-process reader, which looks for a `coach-artie-out` prefix —
  see ARCHITECTURE.md). The two old prefixes (`capabilities-out`, `discord-out`) stay readable
  by the same monitor until you're confident nothing needs them, then can be dropped from
  `LOG_PREFIXES` in a follow-up (not blocking this cutover).

**Human steps, outside this repo:**
- Anyone tailing `packages/capabilities/logs/*` or `packages/discord/logs/*` by hand: switch to
  `logs/app/*`.
- Any Grafana/Alloy/Loki/promtail job scraping `capabilities-out-*.log` / `discord-out-*.log`
  (check `~/observability/promtail/*.yml` on the VPS, read-only) needs a job added for
  `logs/coach-artie-out-*.log` / `logs/coach-artie-error-*.log`. The old jobs can stay pointed
  at the old files until those files stop growing (nothing deletes them), then be removed.

**Check:** `tail -f logs/app/coachartie-combined.log` shows the boot log and then live traffic.
(`logs/coach-artie-out.log` only gets warn and above, because CONSOLE_LOG_LEVEL=warn.)
**Rollback:** n/a — this is config, covered by step 4's rollback.

---

## 7. Redis: stale Moltbook repeatable job (optional)

Moltbook (the social-media poster) was deleted in wave 1 of this rebuild — code only; its
memories in the DB stay. Its scheduled job was a BullMQ repeatable job
(`scheduler.ts`/`'moltbook-social'`) that nothing has explicitly removed from Redis — the
scheduler only de-registers a repeatable job on an explicit call, and this code path never ran
one for Moltbook. It's likely a dead repeatable job still sitting in prod Redis, firing into a
no-op (the handler code is gone, so it would just error and retry forever at whatever
backoff BullMQ gives it) rather than doing anything externally visible — optional to clean up,
not required for the cutover to work.

```bash
# Run from packages/artie, not the repo root: pnpm only resolves `bullmq` inside that
# package's node_modules. Also don't hardcode the Redis port/no-password — reuse the app's own
# connection helper so this one-liner matches whatever REDIS_PORT/REDIS_PASSWORD prod actually
# runs with (createRedisConnection(), shared/queue/redis.ts — NOT a bare {host, port} literal).
# REDIS_HOST=localhost is set on the shell, not left to .env.production/dotenv: dotenv's
# config() never overrides a variable already present in process.env, and
# ecosystem.config.cjs itself overrides REDIS_HOST to 'localhost' for the exact same reason —
# .env.production's own value is a Docker-network hostname that only resolves inside the redis
# container's compose network, not from a plain `node` process on the host.
cd /data2/apps/coachartie2/packages/artie
REDIS_HOST=localhost node -e "
require('dotenv').config({ path: '../../.env.production' });
const { Queue } = require('bullmq');
(async () => {
  // dist/shared/queue/redis.js is ESM ('type': 'module' in this package) — require() can't
  // load it from a CJS -e script, so dynamic import() instead.
  const { createRedisConnection } = await import('./dist/shared/queue/redis.js');
  const connection = createRedisConnection();
  const q = new Queue('coachartie-scheduler', { connection });
  const jobs = await q.getRepeatableJobs();
  const stale = jobs.find(j => j.id === 'moltbook-social' || j.name === 'moltbook-social');
  if (stale) { await q.removeRepeatableByKey(stale.key); console.log('removed', stale.key); }
  else console.log('no moltbook-social repeatable job found');
  await q.close();
  connection.disconnect();
})();
"
```

**Check:** `getRepeatableJobs()` (re-run the first half of the script) no longer lists it.
**Rollback:** n/a (removing a dead job has no downstream effect to undo).

---

## 8. DB: optional reflection/system-prompt row updates (EJ approves separately, no schema change)

Two independent, optional `UPDATE`s this rebuild's waves flagged as candidates. **Neither is
required for v3 to work** — the code already works around both at runtime. Back up first
(step 0 already did); these are also each individually reversible by the paired rollback
`UPDATE`.

**8a. Wave 8 — retire XML-only prompt rows** (only after the `TOOL_LOOP=xml` soak period ends
and that flag is actually being deleted — not now):
```sql
-- Read-only check first: which active rows still teach the XML format?
SELECT name, version, length(content) AS chars FROM prompts
WHERE is_active = 1 AND (content LIKE '%<capability%' OR content LIKE '%wants_loop%');

-- Only once TOOL_LOOP=xml is being removed for good:
UPDATE prompts SET is_active = 0
WHERE is_active = 1 AND name IN ('CAPABILITY_PROMPT_INTRO', 'PROMPT_AUTONOMOUS_MODE');

-- Rollback:
UPDATE prompts SET is_active = 1
WHERE name IN ('CAPABILITY_PROMPT_INTRO', 'PROMPT_AUTONOMOUS_MODE');
```

**8b. Wave 10 — `PROMPT_REFLECTION_GENERAL`/`PROMPT_REFLECTION_CAPABILITY` rows are dead.**
Reflection now runs through a code-owned prompt (`2-turn/reflection-facts.ts`), not these DB
rows. They're not read by anything in `packages/artie/src` any more. Nothing requires
retiring them — they're just inert — but if EJ wants the `prompts` table to reflect that:
```sql
SELECT name, version, is_active FROM prompts
WHERE name IN ('PROMPT_REFLECTION_GENERAL', 'PROMPT_REFLECTION_CAPABILITY');

UPDATE prompts SET is_active = 0
WHERE is_active = 1 AND name IN ('PROMPT_REFLECTION_GENERAL', 'PROMPT_REFLECTION_CAPABILITY');

-- Rollback:
UPDATE prompts SET is_active = 1
WHERE name IN ('PROMPT_REFLECTION_GENERAL', 'PROMPT_REFLECTION_CAPABILITY');
```

**Check:** the `SELECT` before each `UPDATE` shows what will change; re-run it after to confirm.
**Rollback:** the paired `UPDATE` above, immediately — these never change `is_active` on
anything else and never touch schema.

---

## 9. Outside the repo — human/VPS steps this cutover requires

- **`~/scripts/check-artie.sh`** (lines 10-11) hardcodes `coach-artie-capabilities` and
  `coach-artie-discord` (PM2 names). Update it to check `coach-artie` instead. This repo can't
  edit `~/scripts`.
- **`~/observability/promtail/config.yml`** (lines 52, 63) scrapes the old out logs. ADD a
  `coach-artie-out*` job; don't replace the old ones until those files stop growing.
- **Mac memory note** `artie-lean-2026-10.md` names the old PM2 apps and log files; update it
  after the soak.
- **Uptime monitors** (Kuma, UptimeRobot, or anything else) keyed on the old PM2 app names or
  on the old log paths need repointing at `coach-artie` / the new log paths.
- **Grafana/Alloy/Loki/promtail** — see step 6's logs section.
- None of the external HTTP callers (`discord-dm`, `briefs/morning-brief.sh`,
  `briefs/card-fallback.sh`, `scripts/claude/presence-respond.sh`, `scripts/mesh/artie-bridge.ts`,
  `scripts/mesh/artie-response-bridge.ts`) need any change — every route and response shape
  they depend on is unchanged (see ARCHITECTURE.md's "Ports and processes").

---

## 10. Smoke test

Run after step 4, before calling the cutover done:

```bash
curl :47324/health/ready
curl 127.0.0.1:47319/health
tests/smoke.sh calculator dm-contract presence
tail -c +$((MARK+1)) "$COMBINED" | grep -c "Queue consumers started"   # expect 1 (MARK/COMBINED from step 4, same shell)
```

Then, by hand:
- one human `@mention` in a test channel — get a reply.
- one DM to the bot — get a reply.
- trigger one reminder (via the `reminders` tool, something that fires in a minute or two) —
  confirm it actually fires.

**Check:** every curl/smoke-test line above passes; the queue-consumer grep is exactly `1` (not
0 — Redis didn't connect; not 2+ — something double-started); all three manual checks produce
a real reply/fire.
**Rollback:** if any of these fail and the cause isn't obvious from `pm2 logs coach-artie --err`,
roll back via step 4's rollback rather than debugging live in prod.

---

## 11. Soak watch

Watch for at least 24h of real traffic before considering this done:

- **Tool-call rate vs baseline** (`capability-usage.txt`): calculator ~13/day, web ~14/day. A
  drop of more than 50% in either (with no change in message volume) means native tool calling
  is probably mis-firing for some reason that didn't show up in the smoke test — set
  `TOOL_LOOP=xml` in `.env.production`, then
  ```bash
  pm2 delete coach-artie
  pm2 start ecosystem.config.cjs --only coach-artie
  pm2 save
  ```
  to fall back to the old XML path while you investigate. **Not `pm2 restart --update-env`** —
  `ecosystem.config.cjs` does its own `fs.readFileSync` of `.env.production` at require time
  (that's the only thing in this stack that reads that file); `--update-env` only forwards the
  calling shell's env into the process and never re-requires the config file, so the flag would
  silently fail to apply and you'd still be running native tool calls while believing you'd
  rolled back. This is the ONE rollback flag; it exists for exactly this, so it has to actually
  land.
- **Uncaught exceptions**: `grep '💥 Uncaught Exception' logs/coach-artie-out.log` (or the
  winston combined log). The one-process crash policy is log-and-continue — if these trace into
  discord.js internals repeatedly, the log-and-continue policy may need revisiting (originally
  the gateway used to `exit(1)` and get restarted by PM2 on this class of error; the engine
  never did). Not a cutover blocker, a soak-watch item.
- **Morning briefing DM**: once `AUTONOMOUS_PAUSED` is lifted (a separate decision — see
  ARCHITECTURE.md), confirm it actually arrives. Before this rebuild it silently 401'd forever
  (the in-process call has no HTTP auth to fail); that's fixed, so the first real send is worth
  watching.

---

## 12. After the soak — follow-up, not part of this cutover

- **Delete the `XML-LOOP` code and the `TOOL_LOOP` flag** in a follow-up PR, once you're
  confident native tool calls are solid in prod. `rg -n 'XML-LOOP' packages/artie/src` finds
  every marked site.
- **Rotate the n8n webhook basic-auth credential** that used to live in `CLAUDE.md` (removed
  from this repo in wave 1; the credential itself is still live and was exposed in git history
  before that). **Needs EJ's explicit yes before rotating** — confirm nothing else still depends
  on the old value first.
- Once `scripts/deploy.sh` has shipped a real deploy successfully, retire
  `scripts/pm2-deploy.sh`.
- **Commit the LUKS `docker-compose.yml` edit into the v3 branch** (step 1 re-applies it by hand
  every cutover run via a saved patch; it should just be in the branch). This isn't optional
  busywork — until it's committed, `scripts/deploy.sh`'s clean-tree check will REFUSE every
  single routine deploy (by design: it treats any tracked-file diff on prod as something that
  needs a decision, not something to silently carry forward), so this is a near-term blocker on
  routine deploys working at all, not a someday cleanup.
