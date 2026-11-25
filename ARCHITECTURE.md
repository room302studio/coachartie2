# Architecture

**One package, one process, two HTTP ports, native tool calls.** Everything runs from
`packages/artie/`. This file is the map; `CLAUDE.md` is the short version for an agent.

## Words

- **capability**: something Artie can do (remember, search Discord, open a GitHub issue). One
  file each under `engine/capabilities/<category>/`, registered once, gated by its own
  per-action declaration.
- **tool**: only the wire format. The `tools` schema sent to the model and the `tool_calls` it
  sends back (`5-tool-loop/`), and MCP tools. A capability is offered to the model as a tool.
- **turn**: one message in, one reply out: intake, context, generation, tool calls, reply.
- **job**: the BullMQ job a turn rides on, keyed by message id (`job-tracker.ts`,
  `job-watcher.ts`), or a scheduler job (`engine/jobs/`).

## Repo root

```
packages/artie/        The bot (below).
packages/brain/        Nuxt dashboard: a submodule, its own PM2 app (coach-artie-brain).
packages/discord/      Leftovers: register-commands.ts (slash command registration) and data/
                       (casino ledger, launch state: live, see shared/paths.ts).
docs/                  COST-GUARDRAILS.md (live), notes/ (feature notes, the cutover record),
                       great/, archive/ (superseded; history only).
reference-docs/        Guild knowledge the model reads at runtime (room302studio/,
                       subwaybuilder/, guild-notes/, guild-prompts/, metro-maker/) and
                       migrations/ (historical .sql; drizzle owns the live schema).
prompts/               Proposed prompt versions awaiting EJ's review. Nothing reads this
                       directory at runtime; the DB `prompts` table is the live copy.
scripts/               pm2-deploy.sh (deploy on the VPS), deploy.sh (deploy from a laptop),
                       health-check.sh, issue-clerk-e2e.ts, artie, check-prompt-cache.sh.
tests/                 smoke.sh (external contracts) and archive/ (old hand-run red-team suite).
tools/                 prompt-tui.ts / prompt-cli.ts: edit the DB `prompts` table directly.
capabilities/data/     Live runtime data (mention-proxy rules), gitignored, never deployed over.
logs/                  Symlink to the real log directory off-repo.
ecosystem.config.cjs   PM2 config; the only reader of .env.production.
knip.json              Dead-code check config (entry points: main.ts, metro-saves/child.ts).
```

## packages/artie/src

```
main.ts     Entry point: env, signal handlers, crash policy. Calls boot().
boot.ts     DB, then startEngine(), then startGateway().
engine/     The brain: turns, capabilities, memory, scheduler, the :47324 HTTP API.
gateway/    Discord: the client, gating, replies, slash commands, watchers, the :47321 API.
shared/     DB client and schema, config, logger, paths, queue names, small pure helpers.
            Imported by both sides, imports neither.
```

`tests/` mirrors `src/`: a test lives in the folder of the file it tests
(`tests/engine/capabilities/discord/discord-poll.test.ts` tests
`src/engine/capabilities/discord/poll.ts`). Suites that span several areas sit at
`tests/engine/`, `tests/integration/` (Redis-bound, not in `pnpm test`), and the root
(`architecture.test.ts`, `boot.test.ts`).

### The engine, in turn order

| Stage | Folder | Job |
|---|---|---|
| 1 | `1-intake/` | `turns.ts` (the /chat routes: submit, watch, get a turn), `queue-worker.ts`, `job-tracker.ts`, rate limiting, pending attachments and components. |
| 2 | `2-turn/` | `run-turn.ts` (`TurnRunner`): the spine. Trace, fast paths, which tools to expose, failure policy. |
| 3 | `3-context/` | `assemble.ts` (`ContextAssembler`): system prompt and message chain from `sources/`. `prompt-store.ts` (DB prompts), `prompt-cache.ts`, `xml-teaching.ts` (scrubs old XML tool teaching out of DB prompt rows). |
| 4 | `4-generate/` | `generate-reply.ts` (`ReplyGenerator`), `openrouter.ts`, the model catalog. |
| 5 | `5-tool-loop/` | The model's tool calls and nothing else: `native-loop.ts`, `execute-tool-call.ts` (taint checks, then the registry), `tool-schema.ts` (capabilities as the `tools` schema), `timeouts.ts`. |

Beside the stages:

- `capabilities/`: every capability, by category (`core`, `discord`, `dev`, `media`,
  `money`, `ops`, `people`, `personal`, `planning`, `research`, `skills`, `web`, `agents`).
  Its root holds the machinery every call goes through:
  - `registry.ts` (lookup, aliases, gates, validation, execute)
  - `register-all.ts` (the one place capabilities are registered)
  - `policy.ts` (per-action effect, which derives the owner-only, taint and approval gates)
  - `approval-gate.ts` and `approval-ping.ts`
  - `ledger.ts` (one row per call, outcome only)
  - `run-with-retry.ts` (`CapabilityRunner`)
  - `channel-names.ts` (`#name` to id)
  - `call-errors.ts` and `error-patterns.ts` (what the model is told when a call fails)
  - `invocation-trace.ts`
  - `args.ts` (param parsing helpers)
  - `sandbox-exec.ts`
- `memory/`: `store.ts` (`MemoryStore`), `recall.ts`, `learned-rules.ts` (read-only),
  dream, gardener, summarizer, channel digests.
- `budget/`: `usage-ledger.ts` (`UsageLedger`, cost monitor), daily cap, brownout, balance.
- `health/`: vitals, distress, metrics, error tracker, service discovery.
- `jobs/`: the scheduler and what it runs (reminders, digests, GitHub headlines, scribe,
  `github-push/` for the inbound webhook).
- `proactive/`: heartbeat, morning briefing, proactive DMs, relay, reddit mentions, trend
  watcher. Paused while `AUTONOMOUS_PAUSED=true` (prod sets it).
- `routes/`: HTTP routes outside the turn (observe, reflection, route-repo, logs, memories,
  capability registry, observability).
- `metro-saves/`: Subway Builder save-file analysis, run in a child process (`child.ts`).
- `bounty/`: the bounty scaffold (off).
- `api.ts`: the seam (below).

### The gateway, in message order

`1-receive/` (on-message, reactions, components, link expansion) → `2-gate/` (who gets a
reply: mention-only, DMs, ambient judgment, pacing) → `3-ask-engine/` (`engine-client.ts`
submits the turn, `job-watcher.ts` follows it) → `4-reply/` (streamed replies, chunks,
threads, `send-queued-replies.ts` for engine-initiated messages).

Plus `commands/` (slash commands), `routes/` (`discord-actions.ts`, the HTTP and seam handlers
for everything the engine asks Discord to do; moderation; message search), `watchers/` (GitHub,
channel digests, observation, Steam reviews), `voice/` (scribe), `games/`, `api.ts`.

## Rules the tests enforce

`tests/architecture.test.ts`, by parsing imports (no regex):

1. The gateway and the engine meet in exactly two files: the gateway imports only
   `engine/api.ts` of the engine, the engine only `gateway/api.ts` of the gateway. Each seam
   function calls the same handler its HTTP route calls and round-trips the body through JSON
   (`wire()`), so both paths behave identically. Both seams import lazily.
2. `shared/**` imports neither side.
3. No `index.ts` barrels: an import names the file it means.
4. Every file in a `capabilities/<category>/` folder is registered by `register-all.ts`, or is
   a named helper (`*-client.ts`, `*-format.ts`, the research harness...). A capability nobody
   registers is dead code that looks alive.
5. Capabilities never import the turn spine (`2-turn/`) or the loop (`native-loop.ts`).

Also pinned by tests: the capability roster (`roster.expected.json`), every gate in the policy
matrix (`policy.test.ts` floor: entries can be added, never silently removed), and the only
files allowed to mint trusted ids (`trusted-ids.test.ts`).

## Naming

- Numbered folders are pipeline order. A new stage gets the next number.
- A class or singleton is named for its file: `assemble.ts` → `ContextAssembler`,
  `store.ts` → `MemoryStore`, `usage-ledger.ts` → `UsageLedger`.
- `capabilities/<category>/<name>.ts`: the registered name is the basename unless an alias
  says otherwise. Merged names keep working through `CAPABILITY_ALIASES` in `registry.ts`
  (`goal` → `goals`; `todo`/`quests`/`task-status` → `tasks`; `shell`/`edit`/`git` →
  `sandbox`; `runtime_config`/`model_manager` → `bot-config`). Only canonical names are offered
  to the model.
- A helper used by one caller sits next to it. `shared/` is only for code both sides use.
- Frozen, never renamed for tidiness: capability names, DB tables and columns, env vars, HTTP
  routes, slash commands, ledger outcome strings.

## Ports and processes

One Node process (`packages/artie/dist/main.js`, PM2 app `coach-artie`):

- **:47324** engine: `/chat`, `/health*`, `/github` (webhook), `/api/*` (brain),
  `/capabilities/*`, `/scheduler`, `/logs`, `/metrics`.
- **:47321** gateway: `/api/*` (DMs, channel messages, moderation, polls, reactions, forums,
  presence, mention-proxy rules, kill switch), `/terms`, `/privacy`.
- **127.0.0.1:47319** gateway health.
- Redis on :47320 (BullMQ queues, scheduler), the sandbox container on :47323.

Crash policy: log and keep running (`uncaughtException` is logged, not fatal), since exiting
would kill every in-flight turn. PM2's `max_memory_restart` catches real leaks.

## Environment and data

Env files load via `shared/paths.ts getEnvFiles()`: just the repo `.env`; PM2's env beats
it (dotenv never overrides a set variable).
`.env.production` is read only by `ecosystem.config.cjs`, so an env change needs
`pm2 delete coach-artie && pm2 start ecosystem.config.cjs --only coach-artie`, not a restart.

SQLite at `data/coachartie.db` (`DATABASE_PATH` overrides), WAL mode, schema in
`shared/db/schema.ts` (drizzle). Nothing secret belongs in code, tests or docs.

## Deploying

Prod is `/data2/apps/coachartie2` on branch `v3`. `scripts/pm2-deploy.sh` pulls (fast-forward
only), installs with the frozen lockfile, builds, and restarts. The build moves
`tsconfig.tsbuildinfo` aside first: with it, tsc emits only what it believes changed, and after
a file move that left `dist/` missing modules.
