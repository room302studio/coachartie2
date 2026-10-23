# Coach Artie

A Discord bot (Room 302 Studio, Subway Builder) with an agentic core: native LLM tool calls,
persistent memory, and a scheduler for proactive stuff (reminders, digests, morning briefings).
TypeScript, one package, one process.

## The mental model

Everything lives in `packages/artie/`:

- **the gateway** is Discord — receiving messages, gating who gets a reply (mention-only by
  default, DMs always), posting the answer.
- **the engine** is the brain — turn assembly, the LLM call, tool execution, memory, the
  scheduler.
- **shared** is what both sides need and neither owns: the DB client, the logger, path
  resolution, queue names.

The gateway and engine run in one Node process (one PM2 app, `coach-artie`) and talk to each
other through exactly two files (`engine/api.ts`, `gateway/api.ts`) — no HTTP hop between them.
They still each serve an HTTP API on their own port, for callers outside the process (the
`~/scripts` helpers, the brain dashboard, GitHub webhooks, mesh bridges). See
**[ARCHITECTURE.md](./ARCHITECTURE.md)** for the full tree, the pipeline stages, the seam rule,
and the native-tool-calls flag.

Tools (capabilities) are the thing the LLM can call — calculator, memory, scheduler, GitHub,
sandbox shell, and about 60 more — each one file under `packages/artie/src/engine/tools/`,
registered once, discoverable by the model through its OpenRouter `tools` schema.

## Local dev

Requirements: Node 20+, pnpm 8+, an [OpenRouter](https://openrouter.ai) API key, a Discord bot
token.

```bash
pnpm install
cp .env.example .env
```

Fill in `.env`: `OPENROUTER_API_KEY`, `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`. To make a Discord
bot: [discord.com/developers/applications](https://discord.com/developers/applications) ->
New Application -> Bot tab -> Reset Token -> enable "Message Content Intent" -> OAuth2 URL
Generator (scope `bot`, permissions Send Messages + Read Messages) -> invite it to a server.

```bash
pnpm dev     # tsx watch, one process, both ports
```

Say `@YourBot hello` in Discord. If it's quiet: check `DISCORD_TOKEN` is set, "Message Content
Intent" is enabled, and the bot has permission to see the channel.

```bash
pnpm build          # tsc, all packages
pnpm test            # vitest, excludes the Redis-bound integration suite
pnpm test:integration  # the Redis-bound suite (needs a live Redis)
pnpm typecheck       # tsc --noEmit, all packages
```

## Deploy

`scripts/deploy.sh [branch]` bundles the committed branch, ships it to the VPS, installs with
a frozen lockfile, builds, and restarts the one PM2 app. It assumes `ecosystem.config.cjs` is
already current on prod — the one-time migration from the old two-app PM2 setup
(`coach-artie-capabilities` + `coach-artie-discord`) to the new one-app setup (`coach-artie`)
is written, step by step with rollbacks, in **[CUTOVER.md](./CUTOVER.md)**. That migration has
not run yet; read it before running anything against prod.

`scripts/pm2-deploy.sh` is the old (pre-v3) deploy script, kept until `deploy.sh` has shipped
once.

Health checks on a running deploy: `curl :47324/health/ready` (engine), `curl 127.0.0.1:47319/health`
(gateway), `tests/smoke.sh calculator dm-contract presence` (the three externally-visible
contracts).

## Database

SQLite at `data/coachartie.db`. Schema: `packages/artie/src/shared/db/schema.ts` (drizzle ORM).
`DATABASE_PATH` overrides the path. No destructive migration ever runs against it without a
backup and an explicit yes — see `CUTOVER.md`'s DB section for the only two optional, EJ-approved
`UPDATE`s this rebuild produced.

## More

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — the tree, the pipeline, naming rules, the tool
  alias map, the `TOOL_LOOP` emergency flag, the proactive folder.
- **[CUTOVER.md](./CUTOVER.md)** — the prod migration, written and not yet run.
- **[CLAUDE.md](./CLAUDE.md)** — the short version, for an agent working in this repo.
- **[docs/COST-GUARDRAILS.md](./docs/COST-GUARDRAILS.md)** — budget caps, brownout, prompt
  caching, the speak gate.
- **[docs/archive/](./docs/archive/)** — superseded design docs, kept for history.
