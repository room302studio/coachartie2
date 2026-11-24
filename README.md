# Coach Artie

A Discord bot (Room 302 Studio, Subway Builder) with an agentic core: native LLM tool calls,
persistent memory, and a scheduler for proactive work (reminders, digests, briefings).
TypeScript, one package, one process.

## The mental model

Everything lives in `packages/artie/`:

- **the gateway** is Discord: receiving messages, deciding who gets a reply (mentions and DMs
  by default), posting the answer.
- **the engine** is the brain: assembling context, calling the model, running capabilities,
  memory, the scheduler.
- **shared** is what both need and neither owns: the DB, config, logger, paths, queue names.

Both run in one Node process (PM2 app `coach-artie`) and meet in exactly two files,
`engine/api.ts` and `gateway/api.ts`. Each still serves an HTTP API for callers outside the
process (scripts, the brain dashboard, GitHub webhooks, mesh bridges).

**Capabilities** are what Artie can do: remember, search Discord, run polls, open GitHub
issues, use a sandbox shell, and about 60 more. Each is one file under
`packages/artie/src/engine/capabilities/`, registered once and offered to the model as a tool.

**[ARCHITECTURE.md](./ARCHITECTURE.md)** has the full map.

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
pnpm dev                # tsx watch, one process, both ports
```

Say `@YourBot hello` in Discord. If it's quiet: check `DISCORD_TOKEN`, "Message Content
Intent", and that the bot can see the channel.

```bash
pnpm build              # tsc
pnpm test               # vitest, without the Redis-bound integration suite
pnpm test:integration   # the Redis-bound suite (needs a live Redis)
pnpm lint               # eslint
```

## Deploy

Prod runs branch `v3` at `/data2/apps/coachartie2`. On the VPS, `scripts/pm2-deploy.sh` pulls
(fast-forward only), installs with the frozen lockfile, builds clean, and restarts the one PM2
app. `scripts/deploy.sh [branch]` does the same from a laptop by shipping a git bundle.

Health: `curl 127.0.0.1:47324/health/ready` (engine), `curl 127.0.0.1:47319/health` (gateway),
`tests/smoke.sh calculator dm-contract presence` (the external contracts).

## Database

SQLite at `data/coachartie.db` (`DATABASE_PATH` overrides). Schema:
`packages/artie/src/shared/db/schema.ts` (drizzle). No destructive migration runs without a
backup and an explicit yes.

## More

- **[ARCHITECTURE.md](./ARCHITECTURE.md)**: the map, the pipeline, the rules the tests
  enforce, naming, ports.
- **[CLAUDE.md](./CLAUDE.md)**: the short version, for an agent working in this repo.
- **[docs/COST-GUARDRAILS.md](./docs/COST-GUARDRAILS.md)**: budget caps, brownout, prompt
  caching, the speak gate.
- **[docs/notes/](./docs/notes/)**: feature notes (memory recall, the tip jar, voice,
  multiplayer, security, capabilities) and the 2026-10-26 cutover record.
- **[docs/archive/](./docs/archive/)**: superseded design docs, kept for history.
