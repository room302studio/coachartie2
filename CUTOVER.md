# CUTOVER: v3 to prod

**Written, not run.** No step in this file has executed against prod or the VPS. This is the
exact sequence to run once v3 is merged to the branch prod deploys from, with a check and a
rollback for every step. Read it fully before running anything. Back up before any step marked
destructive.

Prod today: two PM2 apps (`coach-artie-capabilities`, `coach-artie-discord`), two processes,
Docker-removed-but-still-mentioned scripts. After this: one PM2 app (`coach-artie`), one
process, two ports. `coach-artie-brain` is untouched throughout.

---

## 0. Pre-flight (read-only, no state change)

Prod's tree is never actually clean — `git status` on it today shows modified
`capabilities/data/mention-proxy-rules.json` (the bot's own live runtime data; wave 12 stopped
tracking this file going forward, but a not-yet-pulled prod checkout still has it tracked and
modified), modified `docker-compose.yml` (the LUKS edit made by hand on the box), modified
`logs` and `packages/brain`, plus several untracked `.env*.bak-*` files. **Do not expect or
require a clean tree** — list what's there and decide what to keep, same as any other step that
touches the working tree.

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
git status --short                 # RECORD THIS — what's about to get stashed in step 1
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

**Check:** the backup file exists and is non-empty; `pm2 jlist` shows exactly
`coach-artie-capabilities`, `coach-artie-discord`, `coach-artie-brain` (plus whatever else runs
on this box).
**Rollback:** none needed — nothing changed yet.

---

## 1. Fetch the new code

```bash
cd /data2/apps/coachartie2
# Preserve whatever step 0's `git status --short` showed — list, then stash (never drop):
git stash push -u -m "pre-cutover stash $(date +%Y%m%d-%H%M%S)"
git fetch -q /tmp/coachartie-cutover.bundle v3
git checkout <the-v3-merge-commit>   # the commit from step 0
```

**Check:** `git log --oneline -1` shows the expected commit. `git status` will still show
untracked `.env*.bak-*` files and anything `git stash -u` didn't catch (it stashes tracked
changes plus untracked files, not ignored ones) — that's expected, not a failure; the bar is "no
tracked-file diff left uncommitted and unstashed," not a literally empty `git status`.
**Rollback:** `git checkout <previous HEAD from step 0>`, then `git stash pop` to restore the
pre-cutover local state.

---

## 2. Lockfile + install

```bash
pnpm install --frozen-lockfile
```

**Check:** exits 0. A frozen-lockfile failure here means the committed `pnpm-lock.yaml` is
stale — **stop, do not pass `--frozen-lockfile=false` on prod.** Go back to the dev worktree,
regenerate the lockfile there (verify-v3.sh's VPS scratch-clone method, never prod), commit it,
and re-fetch.
**Rollback:** `git checkout <previous HEAD>` then `pnpm install --frozen-lockfile` again (the
old lockfile matches the old code).

---

## 3. Build

```bash
pnpm build
```

**Check:** exits 0; `packages/artie/dist/main.js` exists.
**Rollback:** same as step 2 — go back to the previous HEAD and rebuild.

---

## 4. PM2: delete the two old apps, start the one new app

**Never `pm2 restart` across this change.** `coach-artie-capabilities`/`coach-artie-discord`
are reading the OLD `ecosystem.config.cjs` entries (different `cwd`, different `script`,
different ports binding under the OLD two-process model); restarting them in place would try
to run the new single-process code under the old process's config, or vice versa, and is a
restart loop either way. Delete, then start fresh:

```bash
pm2 delete coach-artie-capabilities coach-artie-discord
pm2 start ecosystem.config.cjs --only coach-artie
pm2 save
```

**Never touch `coach-artie-brain`** in this step — it's a separate app, separate config block,
untouched by v3.

**Check:**
```bash
pm2 status                              # coach-artie: online, uptime > 0, restarts not climbing
pm2 logs coach-artie --lines 50 --nostream   # boot log reaches "Coach Artie is up: engine :47324, gateway :47321, health :47319"
```
If `coach-artie` is stuck `errored`/restarting: check `pm2 logs coach-artie --err --lines 100`
first — most likely a missing env var (see step 5) or a port already held by a process that
didn't get deleted (re-run `pm2 delete coach-artie` and check `pm2 jlist` is actually empty of
old entries before starting again).

**Rollback:**
```bash
pm2 delete coach-artie
git checkout <previous HEAD>    # back to the pre-cutover ecosystem.config.cjs + code
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

- `AUTONOMOUS_PAUSED` — **confirm it is already set in prod's `.env.production` before step 4**,
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
  `packages/artie/logs/*` (same filenames: `coachartie-{combined,error,debug}.log` — only the
  directory changes; `LOGS_DIR` env still overrides).
- PM2 out/error logs: the new `ecosystem.config.cjs` writes `logs/coach-artie-{out,error}.log`
  (named to match `vitals.ts`'s in-process reader, which looks for a `coach-artie-out` prefix —
  see ARCHITECTURE.md). The two old prefixes (`capabilities-out`, `discord-out`) stay readable
  by the same monitor until you're confident nothing needs them, then can be dropped from
  `LOG_PREFIXES` in a follow-up (not blocking this cutover).

**Human steps, outside this repo:**
- Anyone tailing `packages/capabilities/logs/*` or `packages/discord/logs/*` by hand: switch to
  `packages/artie/logs/*`.
- Any Grafana/Alloy/Loki/promtail job scraping `capabilities-out-*.log` / `discord-out-*.log`
  (check `~/observability/promtail/*.yml` on the VPS, read-only) needs a job added for
  `logs/coach-artie-out-*.log` / `logs/coach-artie-error-*.log`. The old jobs can stay pointed
  at the old files until those files stop growing (nothing deletes them), then be removed.

**Check:** `tail -f logs/coach-artie-out.log` shows the boot log and then live traffic.
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
cd /data2/apps/coachartie2/packages/artie
node -e "
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

- **`~/scripts/check-artie.sh`** hardcodes `coach-artie-capabilities` and `coach-artie-discord`
  (PM2 names). Update it to check `coach-artie` instead. This repo can't edit `~/scripts`.
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
pm2 logs coach-artie --lines 300 --nostream | grep -c "Queue consumers started"   # expect 1
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
