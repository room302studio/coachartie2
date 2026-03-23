# Coach Artie

Discord/SMS bot for Room 302 Studio and Subway Builder communities.
Monorepo at `/data2/apps/coachartie2/` with turborepo build.

## Packages
- `packages/discord/` — Discord bot (PM2: coach-artie-discord)
- `packages/capabilities/` — HTTP API + webhook handlers (PM2: coach-artie-capabilities, port 47324)
- `packages/shared/` — DB schema, queues, logger (drizzle ORM + SQLite)
- `packages/brain/` — LLM integration (PM2: coach-artie-brain)
- `packages/sms/` — Twilio SMS (PM2: coach-artie-sms)
- `packages/irc/`, `packages/slack/` — other integrations

## Build & Deploy
```bash
cd /data2/apps/coachartie2 && npm run build   # turborepo builds all packages
pm2 restart coach-artie-discord coach-artie-capabilities  # restart relevant services
```

## Database
SQLite at `packages/discord/data/coachartie.db` (also symlinked in other packages).
Schema in `packages/shared/src/db/schema.ts` (drizzle ORM).
Column names use snake_case in DB (e.g., `channel_id`) but camelCase in TypeScript (e.g., `channelId`).

## GitHub → Discord Pipeline
Two paths, both active:

**Poller** (discord package, every 3 min):
- `services/github-poller.ts` — polls PRs, reviews, comments, CI, issues
- `services/github-event-processor.ts` — batches, dedupes (30-min window), filters bots/drafts
- `services/github-discord-poster.ts` — formats embeds, resolves @mentions
- Watch config in `github_repo_watches` table. Currently: `Subway-Builder/metro-maker4` → channel `1480600810743267420`

**Webhook** (capabilities package):
- `handlers/github-webhook.ts` — handles push, release, pull_request, issues, issue_comment
- Posts to channel `1480600810743267420` (sb robot) for issues
- Rate limited: 5 posts/min, 30-min dedup window
- Bot-authored events filtered

## Guild Configuration
- `config/guild-whitelist.ts` — per-guild settings (channels, personas, moderation)
- Room 302 Studio: `932719842522443928`
- Subway Builder: `1420846272545296470`
- Judge Artie persona in `#litigation` channel

## Communication
- DM API: `POST http://127.0.0.1:47321/api/dm` (direct to Artie)
- All text DMs route through anomalywatch for scoring/dedup
- Email: `artie@coachartiebot.com` via MailerSend (send) + docker-mailserver (receive)
- `~/scripts/send-email`, `~/scripts/check-artie-mail`

## Morning Briefing
- `~/scripts/claude/morning-briefing.ts` — ESM project (import, not require)
- Gathers OSINT data, sends via anomalywatch with alert_type='morning_briefing'

## Key Environment
- `.env` at project root — DISCORD_TOKEN, GITHUB_TOKEN, etc.
- n8n webhook auth: `claude:its-ya-boi-claude-676767`

## Docker
- `coachartie-sandbox` + `coachartie2-redis-1` run via docker-compose
- Main services run via PM2 (not docker)
