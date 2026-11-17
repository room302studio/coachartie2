# Coach Artie

Discord bot for Room 302 Studio and Subway Builder. One package (`packages/artie/`), one Node
process, one PM2 app (`coach-artie`). See `README.md` for dev/deploy and `ARCHITECTURE.md` for
the full tree — this file is the short version for an agent working in this repo.

## Packages

- `packages/artie/src/engine/` — the brain: HTTP API (:47324), queue workers, scheduler, tools.
- `packages/artie/src/gateway/` — Discord: client, slash commands, watchers, HTTP API
  (:47321, health 127.0.0.1:47319).
- `packages/artie/src/shared/` — DB client/schema, logger, paths, queue names. Imported by
  both sides; imports neither.
- `packages/artie/tests/` — mirrors `src/` by zone (`engine/`, `gateway/`, `shared/`,
  `integration/` for the Redis-bound suite).
- `packages/brain/` — separate Nuxt dashboard, separate PM2 app (`coach-artie-brain`), a git
  submodule, untouched by this rebuild.
- `packages/capabilities/`, `packages/discord/` — **leftovers only**, no `src/`: reference docs
  and one operational script (`register-commands.ts`) that were never worth moving.

The gateway and engine talk to each other through exactly two files, `engine/api.ts` and
`gateway/api.ts` — no other file on either side imports across that line
(`tests/architecture.test.ts` enforces it). Everything that used to be an HTTP hop between two
processes is now a direct function call through one of those two files.

## Build & test

```bash
pnpm build       # tsc, all packages
pnpm test        # vitest, excludes packages/artie/tests/integration/**
pnpm typecheck   # tsc --noEmit
pnpm dev         # tsx watch src/main.ts, one process, both ports
```

## Database

SQLite at `data/coachartie.db` (`DATABASE_PATH` env overrides). Schema in
`packages/artie/src/shared/db/schema.ts` (drizzle ORM). Column names are snake_case in SQLite
(`channel_id`) but camelCase in TypeScript (`channelId`). The `.sql` files under
`reference-docs/migrations/` are historical snapshots — nothing running loads them by path.

## Tool calls

Native OpenRouter/OpenAI `tools` + `tool_calls` is the default (`engine/5-tool-loop/`).
`TOOL_LOOP=xml` is the one emergency rollback to the old `<capability/>` XML protocol; every
line that exists only for that path is marked `// XML-LOOP: delete after v3 soak`. Don't delete
XML-LOOP-marked code without checking the flag is actually gone first.

Tools merged in v3 keep their old names working through an alias map
(`engine/5-tool-loop/registry.ts TOOL_ALIASES`): `goal`->`goals`, `todo`/`quests`/`task-status`->
`tasks`, `shell`/`edit`/`git`/dev-`search`->`sandbox`, `runtime_config`/`model_manager`->
`bot-config`. A model (or a human) can still call the old name; the prompt's tool roster only
lists canonical names.

## GitHub -> Discord

- `gateway/watchers/github/org-watcher.ts` polls PRs/reviews/comments/CI/issues across the
  watched repos (`github_repo_watches` table), batches and dedupes (30-min window), and posts
  to the `#🤖robot` channel in Room 302 (`GITHUB_FEED_CHANNEL_ID`). @mentions
  (`github_identity_mappings`) only fire on review-requested / ready-for-review / approved /
  changes-requested / CI-failure / issue-assigned — a new PR pings nobody, by design.
- The pipeline: `poller.ts` (fetch) → `event-batcher.ts` (dedupe, batch, mentions) →
  `poster.ts` (I/O: headline, send, fall back to the feed on no-access) → `cards.ts` (pure:
  what a card says). Cards follow one shape (EJ 2026-11-17, "like tufte, any text shown should
  contain data, no duplication"): title `#N <headline or title>`, ONE ` · ` facts line, repo
  footer, state as color, no emoji. Tunables (lines per batch, title lengths, when a headline
  is worth asking for, PR size thresholds) are constants at the top of `cards.ts`; every event
  type has a fixture in `tests/gateway/github-cards.test.ts`.
- Headlines (not GitHub Gists; renamed 2026-11-17 to avoid that confusion):
  `engine/jobs/github-headline.ts`, a ≤110-char model-written line distilled from a PR/issue
  body or long comment that replaces the title. Model `HEADLINE_MODEL` (else `DIGEST_MODEL`,
  else DeepSeek Flash) with
  reasoning OFF (Flash otherwise spends the whole budget thinking and returns nothing).
  Cached by content hash; muted, out of credits, or >8s → the plain title. Never blocks a post.
- The 09:21 standup digest is `studio-digest.ts` (counts in the title, capped sections with
  `[+N more]` links).
- `engine/jobs/github-push/handle-push.ts` handles the inbound webhook (push, release,
  pull_request, issues, issue_comment) and posts to the same channel, rate-limited and
  bot-filtered.

## Guild configuration

`shared/config/guilds.ts` holds per-guild settings: channels, personas, moderation,
`ambientMode` (`'gated'` default or `'never'`). Judge Artie persona in `#litigation`. Room 302
Studio and Subway Builder are the two whitelisted guilds.

## Proactive (paused)

`engine/proactive/` — heartbeat, morning briefing, proactive DMs, relay, reddit mentions,
trend watcher. All gated by one switch: `AUTONOMOUS_PAUSED=true` in the environment skips every
job in that chain (including queued-DM retries) and logs it instead of running. Lifting the
pause is a product decision, not a code change.

## Secrets

Nothing secret in this file, in code, or in tests. `.env` files are gitignored; `.env.example`
and `.env.production.example` are templates only. Never read or print a real `.env*` file's
contents into a commit, a log, or a transcript.

## Before touching prod

Read `CUTOVER.md` first. It is written and has not been run — PM2 app names, log file names,
and the env union all change at that migration, and it has exact commands + rollbacks for each
step.
