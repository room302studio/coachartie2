# COACH ARTIE 2

Multi-interface AI assistant. Discord, SMS, web. TypeScript monorepo.

## ARCHITECTURE

```
Discord/SMS → Capabilities (47324) → Redis → LLM → Response
                     ↓
                 SQLite (state, memory, config)
```

Packages: `capabilities` (orchestrator), `discord`, `sms`, `brain` (web UI), `shared`

Ports: 47319 (health), 47320 (redis dev), 47324 (API), 47325 (UI), 47326 (SMS)

Stack: Node.js 20, TypeScript, Turborepo, pnpm, Redis, SQLite, Discord.js, Express

## REQUIREMENTS

- Node.js 20+
- pnpm 8+
- OpenRouter API key (https://openrouter.ai) - $5 free credit, ~$0.01/msg
- Discord bot token (https://discord.com/developers/applications)
- Optional: OpenAI (embeddings), Twilio (SMS), Wolfram (math)

## SETUP

```bash
git clone <repo>
cd coachartie2
pnpm install
cp .env.example .env
```

Edit `.env`:

```bash
OPENROUTER_API_KEY=sk-or-v1-xxx
DISCORD_TOKEN=xxx
DISCORD_CLIENT_ID=xxx
```

Discord bot setup:

1. https://discord.com/developers/applications → New Application
2. Bot tab → Reset Token → copy token
3. General Information → copy Application ID
4. Bot tab → Enable "Message Content Intent"
5. OAuth2 → URL Generator → bot + Send Messages + Read Messages → invite

Start:

```bash
npm run dev
```

Test: `@YourBot hello` in Discord

## DEVELOPMENT

```bash
npm run dev              # All services, auto-reload
docker-compose up        # Microservices mode
npm run build            # Build all
npm test                 # Tests
pnpm --filter @coachartie/capabilities run dev    # Single package
```

## CONFIGURATION

`.env` file:

Required:

- `OPENROUTER_API_KEY` - LLM access
- `DISCORD_TOKEN` - Bot auth
- `DISCORD_CLIENT_ID` - Bot ID

Optional:

- `OPENAI_API_KEY` - Embeddings
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` - SMS
- `WOLFRAM_APP_ID` - Calculations
- `EMAIL_WEBHOOK_URL`, `EMAIL_WEBHOOK_AUTH` - Email

System:

- `NODE_ENV` - development|production
- `LOG_LEVEL` - debug|info|warn|error
- `DATABASE_PATH` - SQLite location
- `REDIS_HOST`, `REDIS_PORT` - Redis connection

See `.env.example` for all options.

## DEPLOYMENT

### VPS Setup

On VPS as root:

```bash
curl -fsSL https://raw.../scripts/vps-setup.sh | bash
```

Installs Docker, creates `coachartie` user, configures firewall.

### Deploy

From local machine:

```bash
export DEPLOY_HOST="vps.ip.address"
./scripts/deploy.sh remote
```

Or interactive (prompts for VPS IP and keys):

```bash
./scripts/deploy.sh remote
```

Script uploads code, builds containers, starts services, validates.

### Operations

On VPS:

```bash
./scripts/ops.sh health          # Status
./scripts/ops.sh logs            # Logs
./scripts/ops.sh backup          # Backup DB
./scripts/ops.sh restore <file>  # Restore DB
./scripts/ops.sh restart         # Restart
./scripts/ops.sh stats           # Resources
./scripts/ops.sh clean           # Cleanup
```

### Production Files

- `docker-compose.prod.yml` - Production stack (2 containers: app + redis)
- `.env.production` - Production config template
- Memory limit: 1GB container (512MB Node.js heap, 512MB Redis)
- Logs: 10MB files, 10 files max, auto-rotate
- Health check: `curl http://localhost:47319/health`

### Systemd Service

Created by `vps-setup.sh`:

```bash
systemctl start coachartie
systemctl stop coachartie
systemctl restart coachartie
systemctl status coachartie
```

Service file: `/etc/systemd/system/coachartie.service`

### Backup/Restore

Backup:

```bash
./scripts/ops.sh backup
# Creates ~/backups/backup-YYYYMMDD-HHMMSS.db.gz
# Auto-deletes >7 days old
```

Restore:

```bash
./scripts/ops.sh restore ~/backups/backup-20250131-120000.db.gz
# Stops services, restores DB, starts services
```

Manual backup:

```bash
docker exec coachartie-prod cp /app/data/coachartie.db /tmp/backup.db
docker cp coachartie-prod:/tmp/backup.db ~/backup.db
```

### Monitoring

Health: `http://vps:47319/health` (returns JSON)
Memory: `docker stats coachartie-prod` (normal: 350-600MB, alert: >700MB)
Logs: `docker compose -f docker-compose.prod.yml logs -f`

## TROUBLESHOOTING

Bot offline:

```bash
ps aux | grep "npm run dev"
cat .env | grep DISCORD_TOKEN
docker-compose logs discord
```

Bot no response: Mention bot `@Bot msg`, check "Message Content Intent" enabled, check permissions

Module errors: `rm -rf node_modules && pnpm install`

Redis errors: `docker-compose restart redis`

Port in use: `lsof -ti:47324 | xargs kill -9`

Database locked: `docker-compose down && npm run dev`

Memory issues: `docker stats`, `docker system prune -af`

## STRUCTURE

```
packages/
  capabilities/   Main orchestrator, API, capabilities
    src/
      routes/     API endpoints
      services/   Core logic
      capabilities/  Feature modules
      queues/     Message processing
      handlers/   Webhooks
    data/         SQLite database
  discord/        Discord bot
  sms/            SMS service
  brain/          Web UI (Nuxt)
  shared/         Common utilities
scripts/
  deploy.sh       Deployment
  ops.sh          Operations
  vps-setup.sh    VPS initial setup
  health-check.sh Health check
```

## SCRIPTS

```bash
./scripts/deploy.sh              # Help
./scripts/deploy.sh local        # Test production locally
./scripts/deploy.sh remote       # Deploy to VPS
./scripts/deploy.sh validate     # Validate deployment

./scripts/ops.sh                 # Help
./scripts/ops.sh health          # Health check
./scripts/ops.sh logs            # Logs
./scripts/ops.sh backup          # Backup
./scripts/ops.sh restore <file>  # Restore
./scripts/ops.sh restart         # Restart
./scripts/ops.sh stats           # Resources
./scripts/ops.sh clean           # Cleanup

./scripts/vps-setup.sh           # VPS setup (run as root)
./scripts/health-check.sh        # Quick check
```

Run any script without args for detailed help.

## CAPABILITIES

Modular capability system in `packages/capabilities/src/capabilities/`:

- Chat - Natural conversation
- Memory - Semantic memory with embeddings
- Calculator - Math via Wolfram Alpha
- Email - SMTP/webhook
- Meeting Scheduler - Schedule meetings, notify participants
- Web Search - Search
- GitHub - Repository webhooks

Add new capabilities by creating files in capabilities directory.

## CONTRIBUTING

```bash
git checkout -b feature/name
# Make changes
npm run dev  # Test
git commit -m "feat: description"
git push origin feature/name
```

Commit types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

Version bumps:

```bash
npm run changelog        # Generate changelog
npm run version:patch    # 1.1.0 → 1.1.1
npm run version:minor    # 1.1.0 → 1.2.0
npm run version:major    # 1.0.0 → 2.0.0
```

## LICENSE

CC-BY-NC-4.0

## DOCUMENTATION

This file. Scripts have help: run without args.
