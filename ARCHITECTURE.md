# Architecture

This is the v3 rebuild of Coach Artie (see `reorg/BUILD-LOG.md` for the wave-by-wave history,
if you have that scratchpad; otherwise this file is the forward-looking source of truth). The
short version: **one package, one process, two ports, native tool calls.**

## Root tree

```
ecosystem.config.cjs   PM2 config. Reads .env.production itself (fs.readFileSync at require
                        time) — the only place that file is read. See CUTOVER.md.
CUTOVER.md              The v3->prod migration, written, not run.
ARCHITECTURE.md CLAUDE.md README.md   This file, the agent-facing short version, the human one.
docker-compose.yml      Infra only now: redis, sandbox. Apps run via PM2, not Docker.
docker-compose.dev.yml  Pre-v3 multi-service dev compose — stale, logged as an open question
                        for EJ in BUILD-LOG (wave 12), left untouched.
dev.sh reload.sh        Same pre-v3 multi-service assumptions as docker-compose.dev.yml — same
                        open question, same reasoning, left untouched.
package.json            Root workspace scripts. `dev` -> the one-process dev command.
turbo.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json vitest.config.ts eslint.config.mjs
docs/                   Mostly archived. docs/archive/ holds everything superseded by this
                        rebuild (old READMEs, deployment docs, migration plans, test results).
                        docs/COST-GUARDRAILS.md is the one live doc here (its pm2 commands
                        updated to the one app name).
prompts/                Seed prompt content (conscience-system.md); no current runtime read
                        site reads this path directly — the DB `prompts` table is the live copy.
scripts/                deploy.sh (written, not run), pm2-deploy.sh (kept until deploy.sh has
                        shipped once), smart-dev.js, health-check.sh, artie, check-prompt-cache.sh.
tests/                  Root-level manual/smoke scripts: smoke.sh (calculator/dm-contract/
                        presence, see CUTOVER.md step 10) plus tests/archive/ (the old
                        hand-run red-team suite, test-01..09, kept for reference, not run by CI).
reference-docs/         Guild knowledge the LLM reads at runtime (room302studio/,
                        subwaybuilder/, guild-notes/, guild-prompts/) plus migrations/
                        (historical .sql, not loaded by any running code — drizzle owns the
                        live schema).
tools/                  prompt-tui.ts / prompt-cli.ts — operate on the DB's `prompts` table
                        directly.
capabilities/data/      The bot's own live runtime data (mention-proxy-rules.json), written at
                        runtime, gitignored (not tracked — a deploy must never overwrite it).
logs/                   Symlink to the real log directory off-repo (e.g. /data/archive/logs/…).
                        PM2 out/error files + winston app logs both land here; see CUTOVER.md
                        step 6 for the exact filenames.
```

## Packages

```
packages/
  artie/          The bot. Engine + gateway + shared, one package, one Node process.
    src/
      main.ts      Entry point: env load, signal handlers, crash policy. Calls boot().
      boot.ts      boot()/shutdown(): DB -> startEngine() -> startGateway() -> 'ready'.
      engine/      The brain: HTTP API (:47324), queue workers, scheduler, tools.
      gateway/     Discord: the bot client, slash commands, watchers, HTTP API (:47321, health :47319).
      shared/      DB client/schema, logger, paths, queue names — imported by both, imports neither.
    tests/         Mirrors src/ by zone: engine/, gateway/, shared/, integration/ (Redis-bound).
  brain/          Nuxt web dashboard (separate submodule, separate PM2 app, untouched by v3).
  capabilities/   Leftover non-src files only: reference-docs/guild-notes, nothing in src/.
  discord/        Leftover non-src files only: register-commands.ts, .env.example.
tools/            prompt-tui.ts / prompt-cli.ts — operate on the DB's `prompts` table directly.
reference-docs/   Guild knowledge the LLM reads at runtime (room302studio/, subwaybuilder/,
                  guild-notes/, guild-prompts/) plus migrations/ (historical .sql, not loaded
                  by any running code — drizzle owns the live schema).
```

`packages/capabilities/` and `packages/discord/` are **not** stale leftovers to clean up blindly:
they hold the handful of non-`src/` files wave 3 deliberately left in place (an operational
script, a `.env.example` template, runtime reference docs) because moving them bought nothing.
Everything that was `src/` is in `packages/artie/src/` now.

## The engine's pipeline (numbered stage folders)

A message's life inside the engine, in call order:

| Stage | Folder | Job |
|---|---|---|
| 1 | `1-intake/` | Queue consumer, job tracker: a message becomes a tracked job. |
| 2 | `2-turn/` | `run-turn.ts`: the turn spine (trace, fast paths, the `toolLoopMode()` branch, failure policy). |
| 3 | `3-context/` | Assemble the system prompt + message chain from every context source. |
| 4 | `4-generate/` | Call the model (OpenRouter), the model catalog, prompt caching. |
| 5 | `5-tool-loop/` | Run tool calls: the registry, aliases, native loop, (legacy) XML loop. |

Cross-cutting engine folders that aren't a numbered stage: `budget/` (daily cap, brownout,
usage ledger), `health/` (vitals, distress, service discovery), `jobs/` (the scheduler —
reminders, digests, the proactive chain), `memory/` (the hybrid data layer, recall), `metro/`
(subway builder save-file tooling), `routes/` (the HTTP routes that aren't part of the turn
spine — observe, channel-digest, reflection, route-repo, logs), `tools/` (every registered
capability, see below).

The gateway's pipeline mirrors this shape: `1-receive/` (on-message, on-reaction) ->
`2-gate/` (mention-only, ambient judgment, the proxy stripper) -> `3-ask-engine/` (submits the
turn, polls/streams it) -> `4-reply/`. Plus `commands/` (slash commands), `games/`,
`watchers/` (GitHub, channel digests, observation), `routes/` (the HTTP API).

## The seam rule

**The gateway and the engine talk to each other through exactly two files**, enforced by
`tests/architecture.test.ts`:

- `engine/api.ts` — every function the gateway calls on the engine (submit/poll/watch a turn,
  observe, channel-digest, route-repo, reflection threshold, execute-tool, list-capabilities,
  health-snapshot, list-models, trace linking/feedback).
- `gateway/api.ts` — every function the engine calls on the gateway (send a DM, send a channel
  message, moderation actions, polls, nickname, reactions, forums, mention-proxy rules,
  gateway health).

These used to be two HTTP services talking over loopback (:47324 <-> :47321). Wave 9 collapsed
them into one process; `engine/api.ts`/`gateway/api.ts` are what's left of that boundary — each
function calls the same handler body its old HTTP route called and returns that route's
`{status, body}`. The HTTP routes still exist too, for external callers (the mesh bridges,
brain, GitHub webhooks, `~/scripts`) and run the identical code. Bodies go through a JSON
round-trip (`wire()`) on the way across the seam, so a handler sees exactly what the old HTTP
call would have parsed — no accidental object-identity sharing between the two sides.

Both seam files import their own side's route modules **lazily** (`await import(...)`), so
importing `engine/api.ts` never drags the engine's module graph (and its capability registry
bootstrap) into a gateway-only test, and vice versa. `shared/**` imports neither side.

The architecture test (`tests/architecture.test.ts`) checks, via `ts.preProcessFile` (no
regex), that:
1. gateway <-> engine only happens through those two files.
2. `shared/**` imports neither `engine/**` nor `gateway/**`.
3. No `index.ts`/barrel files under `src/`.
4. Every registered tool (`engine/tools/**` exporting `RegisteredCapability`) and every
   proactive module is actually imported by `5-tool-loop/register-tools.ts` (a named exception
   list covers helper files that intentionally export no capability).
5. `tools/**` never imports the turn spine (`2-turn/**`) or the loop internals
   (`5-tool-loop/{loop,native-loop}.ts`) — a tool receives params and returns a string; it
   doesn't reach back into the machinery that's calling it.

## Naming rules

- **One canonical name per concept.** Where the pre-v3 code had two or more tools for the same
  job, v3 merged them into one file with one registered name (see "Tool merges" below) — never
  a second copy under a different name.
- **Numbered folders are pipeline order**, not alphabetical or by size. `1-intake` runs before
  `2-turn`, which runs before `3-context`, and so on. A new stage gets the next number; nothing
  is inserted mid-sequence.
- **`tools/<category>/<name>.ts`** — one file per registered capability, grouped by rough
  domain (`core`, `discord`, `dev`, `people`, `planning`, `ops`, `media`, `money`, `web`,
  `personal`, `agents`, `research`, `skills`). The registered capability name is the file's
  basename unless the merge table below says otherwise.
- **`*-client.ts`** holds an API client with no registered capability of its own
  (`reddit-client.ts`, `wolfram-client.ts`) — used by a sibling tool file, not itself a tool.
- Files that exist to be imported by exactly one caller sit next to that caller, not in a
  shared/generic folder, unless `shared/` is genuinely used by both the engine and the gateway.

## Tool merges and the alias map (F1)

EJ's call: **merge, don't delete.** Four real merges happened (wave 4), each folding
near-duplicate tools into one canonical file with one registered name:

| Canonical | Absorbed | Where |
|---|---|---|
| `goals` | `goal` | `engine/tools/planning/goals.ts` |
| `tasks` | `todo`, `quests`, `task-status` | `engine/tools/planning/tasks.ts` |
| `sandbox` | `shell`, `edit`, `git`, dev `search` | `engine/tools/dev/sandbox.ts` |
| `bot-config` | `runtime_config`, `model_manager` | `engine/tools/ops/bot-config.ts` |

Every old name **still works**: `engine/5-tool-loop/registry.ts`'s `TOOL_ALIASES` map resolves
an old name + action (+ param renames, where the shapes don't line up — e.g.
`goal:set objective="X"` becomes `goals:create title="X"`) to its canonical target before
execution, taint checks, and conscience review. Aliases are never themselves registered, so
the prompt's tool roster lists only canonical names — a model learns the new names from what it's
offered, but an old `<capability name="goal" .../>` tag or a native `goal(...)` call a model
still emits from habit or history keeps working.

Everything else zero-use kept its name and just moved: the casino, email drafting, conscience,
experiments, embedded-mcp, skills, launch-countdown. Nothing was deleted for being unused — only
real duplicates were merged. (Map-2's broader "merge everything vaguely similar" table from the
original plan was explicitly **not** applied — see `BUILD-BRIEF.md`.)

## Native tool calls and the `TOOL_LOOP` flag (F3)

v3 replaced the `<capability name="x" action="y" .../>` XML protocol with native
OpenRouter/OpenAI-style `tools` + `tool_calls`. **Native is the default.**

`engine/5-tool-loop/mode.ts` exports `toolLoopMode()`, the one reader of `process.env.TOOL_LOOP`:

- unset or `TOOL_LOOP=native` (default): `native-loop.ts` runs. The model gets the full tool
  schema (`registryToTools`) every round, tool-capable models only (a model missing `tools`
  from its OpenRouter `supported_parameters`, or `openrouter/auto`, gets pinned to the first
  tool-capable model in `OPENROUTER_MODELS`). No `{{var}}` substitution, no `<wants_loop>`, no
  forced-depth loop — the model decides when it's done the same way Claude Code's tool loop
  does.
- `TOOL_LOOP=xml`: **the one emergency rollback flag.** Restores the old path end to end — the
  XML roster in the system prompt, the `<capability/>` regex parser, `<wants_loop>`, the
  `llm-loop` ReAct loop, `{{var}}` substitution, the `variable` tool. Set it and restart the
  process to roll back; the boot log says which loop is live.

Every line of code that exists only for the XML path is marked `// XML-LOOP: delete after v3
soak (TOOL_LOOP=xml)`. **After the soak period, delete that code and the flag** (a follow-up
PR — not done here, on purpose: the flag is the rollback). `rg -n 'XML-LOOP' packages/artie/src`
finds everything that follow-up PR removes.

## The proactive folder (paused via `AUTONOMOUS_PAUSED`)

`engine/proactive/` holds the unprompted/outbound chain: `heartbeat.ts`, `morning-briefing.ts`,
`proactive-dm.ts`, `relay.ts`, `delivery.ts` (queued-DM retry), `reddit-mentions.ts`,
`trend-watcher.ts`. This is F2's scope: Moltbook (the social-media poster/capability/scheduled
job/startup hook) was deleted entirely in wave 1 — code only, its memories in the DB stay. Every
*other* proactive feature stays and lives in this one folder.

The whole chain has one pause switch: `engine/jobs/scheduler.ts` checks
`process.env.AUTONOMOUS_PAUSED === 'true'` before running any job in `PROACTIVE_JOB_TYPES`
(including `delivery-retries`, so queued DMs don't flush while paused either) and logs
`⏸️ AUTONOMOUS_PAUSED — skipping proactive job "<type>"` instead. Today prod runs with it set,
so the chain is live in code but silent. Lifting it (unsetting the env var + restart) is a
product decision, not a code change — nothing here needs to ship for that to happen.

## Ports and processes

One Node process (`packages/artie/dist/main.js`, PM2 app `coach-artie`) serves two HTTP APIs:

- **:47324** (engine) — `POST /chat`, `GET /chat/:id`, `/chat/:id/stream`, `/health*`,
  `POST /github` (webhook), `/api/*` (brain-facing), `/capabilities/*`, `/scheduler`, `/logs`,
  `/metrics`.
- **:47321** (gateway) — `/api/dm`, `/api/presence/inbox[/:id/ack]`, and the rest of `/api/*`
  (channel messages, moderation, polls, nickname, reactions, forums, mention-proxy rules,
  killswitch), `/api/moderation/*`, `/terms`, `/privacy`.
- **127.0.0.1:47319** (gateway) — health only, bound to loopback.

Response shapes on every route are unchanged from before wave 9 — only the transport inside the
process changed (see "The seam rule" above). External callers (`~/scripts`'
`discord-dm`/`briefs/morning-brief.sh`/`briefs/card-fallback.sh`/`scripts/claude/presence-respond.sh`/
`scripts/mesh/artie-bridge.ts`/`artie-response-bridge.ts`, plus brain) need no changes.

Crash policy for the one process: **log and keep running** (`process.on('uncaughtException', ...)`
logs via `telemetry` and does not exit). This was the engine's old policy; the gateway used to
exit(1) on an uncaught exception, which only restarted the Discord half — doing that in one
process would kill every in-flight turn along with it. PM2's `max_memory_restart` (1536M) still
catches a real leak.

## Environment and secrets

Env files load in order, first-wins, via `shared/paths.ts getEnvFiles()`: repo-root `.env`,
`packages/capabilities/.env`, `packages/discord/.env` (PM2's own env always wins over all
three). Nothing secret belongs in code, tests, or this file — see `CUTOVER.md`'s Env section
for the by-NAME-only list of what v3 reads that prod's `.env.production` may not have yet.

## Database

SQLite at `data/coachartie.db` (path: `shared/paths.ts getDatabasePath()`, override via
`DATABASE_PATH`). Schema in `packages/artie/src/shared/db/schema.ts` (drizzle ORM) — the
`.sql` files under `reference-docs/migrations/` are historical snapshots, not loaded by any
running code. No schema change shipped in v3; no table was dropped.
