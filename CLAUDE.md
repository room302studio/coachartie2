# Coach Artie

Discord bot for Room 302 Studio and Subway Builder. One package (`packages/artie/`), one Node
process, one PM2 app (`coach-artie`), prod on branch `v3`. `ARCHITECTURE.md` is the full map;
this is the short version for an agent working here.

## Where things are

- `src/engine/`: turns in pipeline order (`1-intake` → `2-turn` → `3-context` →
  `4-generate` → `5-tool-loop`), plus `capabilities/` (everything Artie can do, one file each,
  and the registry machinery at its root), `memory/`, `budget/`, `jobs/`, `proactive/`,
  `routes/`.
- `src/gateway/`: Discord in message order (`1-receive` → `2-gate` → `3-ask-engine` →
  `4-reply`), plus `commands/`, `routes/`, `watchers/`, `voice/`.
- `src/shared/`: DB, config, logger, paths, queue, small helpers. Imports neither side.
- `tests/` mirrors `src/`. Put a test next to the path of the file it tests.

Words: a **capability** is something Artie can do; a **tool** is only the wire format (the
`tools` schema and `tool_calls`) and MCP tools.

## Rules that bite

- Engine and gateway meet only in `engine/api.ts` and `gateway/api.ts`
  (`tests/architecture.test.ts` fails otherwise). No `index.ts` barrels.
- A new capability: a file in `engine/capabilities/<category>/`, registered in
  `capabilities/register-all.ts`, with an `actions` declaration (each action's `effect` derives
  its owner-only, taint and approval gates; see `capabilities/policy.ts`). Then update
  `tests/engine/capabilities/roster.expected.json`.
- Old capability names keep working through `CAPABILITY_ALIASES` in `capabilities/registry.ts`.
- Never rename for tidiness: capability names, DB tables/columns, env vars, HTTP routes, slash
  commands, ledger outcomes.
- Gated actions (money, anything leaving Discord) queue for EJ's approval; owner-only actions
  refuse everyone else. Don't route around either.

## Build, test, deploy

```bash
pnpm build       # tsc
pnpm test        # vitest, without tests/integration (Redis-bound)
pnpm lint        # eslint, zero warnings
pnpm dev         # tsx watch src/main.ts, one process, both ports
```

On the VPS, `scripts/pm2-deploy.sh` deploys `v3`. A build after files moved needs
`packages/artie/tsconfig.tsbuildinfo` out of the way (the script does it), or `dist/` misses
modules. Health: `curl 127.0.0.1:47324/health/ready` and `curl 127.0.0.1:47319/health`.

## Database

SQLite at `data/coachartie.db` (`DATABASE_PATH` overrides), schema in
`src/shared/db/schema.ts` (drizzle). Columns are snake_case in SQLite, camelCase in TypeScript.
No destructive change without a backup and EJ's explicit yes.

## Guilds and GitHub

- `shared/config/guilds.ts`: per-guild channels, personas, moderation, `ambientMode`. Room 302
  Studio, Subway Builder, and the Subway Builder 2 alpha.
- GitHub to Discord: `gateway/watchers/github/` polls (`poller.ts` → `event-batcher.ts` →
  `poster.ts` → `cards.ts`, one card shape, no emoji); `engine/jobs/github-headline.ts` writes
  the one-line headlines; `engine/jobs/github-push/github-webhook.ts` takes the inbound webhook.

## Proactive

`engine/proactive/` (heartbeat, briefings, proactive DMs...) is paused while
`AUTONOMOUS_PAUSED=true`, which prod sets. Lifting it is EJ's product call, not a code change.

## Secrets

Nothing secret in code, tests, docs or logs. `.env*` files are gitignored; the `.example`
files are templates. Never print a real `.env` value.
