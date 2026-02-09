# Coach Artie Deployment Guide

Production deployment on EJ's VPS using pm2 for native Node.js services.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        NATIVE (pm2)                              │
├─────────────────────────────────────────────────────────────────┤
│  coach-artie-capabilities  │  Core AI, memory, LLM orchestration │
│  Port: 47324               │  ~200MB RAM                         │
├────────────────────────────┼────────────────────────────────────┤
│  coach-artie-discord       │  Discord bot + REST API             │
│  Port: 47321               │  ~140MB RAM                         │
├────────────────────────────┼────────────────────────────────────┤
│  coach-artie-brain         │  Nuxt web dashboard                 │
│  Port: 47325               │  ~60MB RAM                          │
├────────────────────────────┼────────────────────────────────────┤
│  coach-artie-sms           │  Twilio SMS interface               │
│  Port: 47326               │  ~80MB RAM                          │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        DOCKER                                    │
├─────────────────────────────────────────────────────────────────┤
│  coachartie-sandbox        │  Isolated code execution (Deno)     │
│  Port: 47323               │  Required for safe user code        │
├────────────────────────────┼────────────────────────────────────┤
│  coachartie2-redis-1       │  Job queues, response routing       │
│  Port: 47320               │  Required for async processing      │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Reference

```bash
# View status
pm2 status

# View logs (live)
pm2 logs

# View specific service logs
pm2 logs coach-artie-capabilities
pm2 logs coach-artie-discord

# Restart all services
pm2 restart all

# Restart specific service
pm2 restart coach-artie-discord

# Full redeploy
cd /data2/coachartie2
pnpm run build
pm2 restart all
```

## Directory Structure

```
/data2/coachartie2/
├── packages/
│   ├── capabilities/     # Core AI service
│   ├── discord/          # Discord bot
│   ├── brain/            # Web dashboard (Nuxt)
│   ├── sms/              # SMS service
│   └── shared/           # Shared utilities, DB client
├── data/
│   └── coachartie.db     # SQLite database (all services use this)
├── logs/                 # pm2 log files
├── ecosystem.config.cjs  # pm2 configuration
├── .env.production       # Production environment variables
└── docker-compose.yml    # Docker config (sandbox + redis only)
```

## Configuration Files

### ecosystem.config.cjs

pm2 process configuration. Key settings:

```javascript
{
  name: 'coach-artie-capabilities',
  cwd: 'packages/capabilities',
  script: 'dist/index.js',
  env: {
    DATABASE_PATH: '/data2/coachartie2/data/coachartie.db',
    REDIS_HOST: 'localhost',
    // ... loaded from .env.production
  }
}
```

### .env.production

All environment variables. Critical ones:

```bash
# API Keys
OPENROUTER_API_KEY=...
DISCORD_BOT_TOKEN=...
MOLTBOOK_API_KEY=...

# Service URLs (for native deployment)
REDIS_HOST=localhost
CAPABILITIES_URL=http://localhost:47324

# Database
DATABASE_PATH=/data2/coachartie2/data/coachartie.db
```

## Deployment Procedures

### Standard Redeploy (code changes)

```bash
cd /data2/coachartie2
git pull                    # Get latest code
pnpm install               # Install deps if package.json changed
pnpm run build             # Compile TypeScript
pm2 restart all            # Restart services
pm2 logs --lines 50        # Verify startup
```

### Single Service Redeploy

```bash
cd /data2/coachartie2
pnpm run build --filter=@coachartie/discord
pm2 restart coach-artie-discord
pm2 logs coach-artie-discord --lines 30
```

### Full Reset (nuclear option)

```bash
cd /data2/coachartie2
pm2 delete all
pnpm run build
pm2 start ecosystem.config.cjs
pm2 save
```

## Monitoring

### pm2 Dashboard

```bash
pm2 monit                  # Interactive dashboard
```

### Log Files

All logs are in `/data2/coachartie2/logs/`:

```
capabilities-out-0.log     # Capabilities stdout
capabilities-error-0.log   # Capabilities stderr
discord-out-1.log          # Discord stdout
discord-error-1.log        # Discord stderr
brain-out-2.log            # Brain stdout
sms-out-3.log              # SMS stdout
```

### Health Checks

```bash
# Capabilities health
curl http://localhost:47324/health

# Brain dashboard
curl http://localhost:47325

# Check all ports are listening
ss -tlnp | grep -E "4732[0-6]"
```

### Memory Usage

```bash
pm2 status                 # Shows mem per process
pm2 monit                  # Real-time monitoring
```

## Docker Services

Only sandbox and redis run in Docker:

```bash
# Check status
cd /data2/coachartie2
docker compose ps

# Restart if needed
docker compose restart sandbox redis

# View sandbox logs
docker compose logs sandbox -f
```

### Why Docker for these?

- **Sandbox**: Executes untrusted user code. Must be isolated with Deno permissions.
- **Redis**: Stateful service, easier to manage persistence with Docker volumes.

## Troubleshooting

### Service won't start

```bash
# Check error logs
pm2 logs coach-artie-capabilities --err --lines 100

# Check if port is in use
lsof -i :47324

# Kill orphan process
kill <pid>
```

### Database errors

```bash
# Check database exists and is readable
ls -la /data2/coachartie2/data/coachartie.db

# Check database integrity
sqlite3 /data2/coachartie2/data/coachartie.db "PRAGMA integrity_check;"

# Backup before any fixes
cp /data2/coachartie2/data/coachartie.db /data2/coachartie2/data/coachartie.db.backup
```

### Redis connection issues

```bash
# Check Redis is running
docker compose ps redis

# Test Redis connection
redis-cli -p 47320 ping

# Restart Redis
docker compose restart redis
```

### Discord bot offline

```bash
# Check Discord logs for auth errors
pm2 logs coach-artie-discord --lines 100 | grep -i "error\|token\|auth"

# Verify token in env
grep DISCORD_BOT_TOKEN .env.production | head -c 50
```

### High memory usage

pm2 auto-restarts at memory limits (configured in ecosystem.config.cjs):

- Capabilities: 1GB limit
- Discord: 512MB limit
- Brain: 512MB limit
- SMS: 256MB limit

Manual restart if needed:
```bash
pm2 restart coach-artie-capabilities
```

## Backup Procedures

### Database Backup

```bash
# Manual backup
cp /data2/coachartie2/data/coachartie.db /data2/backups/coachartie-$(date +%Y%m%d).db

# Or with sqlite3 for consistency
sqlite3 /data2/coachartie2/data/coachartie.db ".backup /data2/backups/coachartie-$(date +%Y%m%d).db"
```

### Configuration Backup

```bash
# Backup all config
tar -czf /data2/backups/coachartie-config-$(date +%Y%m%d).tar.gz \
  /data2/coachartie2/.env.production \
  /data2/coachartie2/ecosystem.config.cjs \
  /data2/coachartie2/docker-compose.yml
```

## Service-Specific Notes

### Capabilities Service

The brain of Artie. Handles:
- LLM orchestration (OpenRouter)
- Memory storage and recall (SQLite + BM25 search)
- Capability detection and execution
- Social media behavior (Moltbook)

Key behaviors:
- **Social Media**: Checks Moltbook every 3-6 hours, uses LLM for genuine posts/comments
- **Memory**: Stores observations, conversations, uses TF-IDF for semantic search
- **Model Rotation**: Cycles through Claude, Gemini, Mistral for variety

### Discord Service

Handles all Discord interactions:
- Message handling and routing
- Slash commands
- Reaction handling
- Forum traversal
- GitHub sync (watches repos, posts updates)
- Observational learning (reads channels, creates memories)

REST API endpoints:
- `POST /api/dm` - Send DM to user
- `POST /api/channels/:id/messages` - Send channel message
- `GET /api/guilds/:id/forums` - List forums
- `POST /api/presence/send` - Presence check-ins

### Brain Service

Nuxt.js web dashboard at port 47325:
- Memory browser
- Queue status
- Analytics
- Configuration editor

### SMS Service

Twilio webhook handler:
- Receives incoming SMS
- Routes to capabilities for processing
- Sends responses back

## Port Reference

| Port  | Service              | Protocol |
|-------|---------------------|----------|
| 47320 | Redis               | TCP      |
| 47321 | Discord API         | HTTP     |
| 47323 | Sandbox (Deno)      | HTTP     |
| 47324 | Capabilities API    | HTTP     |
| 47325 | Brain Dashboard     | HTTP     |
| 47326 | SMS Webhook         | HTTP     |

## Startup Order

Services should start in this order (pm2 handles this):

1. **Redis** (Docker) - Must be running first
2. **Sandbox** (Docker) - Independent
3. **Capabilities** - Needs Redis
4. **Discord** - Needs Redis + Capabilities
5. **Brain** - Needs Capabilities
6. **SMS** - Needs Capabilities

## Auto-Start on Reboot

pm2 is configured for auto-start:

```bash
# Already configured, but to verify:
pm2 startup
pm2 save
```

Docker services auto-start via `restart: unless-stopped` in docker-compose.yml.

## Updating Dependencies

```bash
cd /data2/coachartie2
pnpm update              # Update all packages
pnpm run build           # Rebuild
pm2 restart all          # Restart
```

For major updates, test locally first or backup the database.

---

*Last updated: 2026-02-01*
*De-dockerized from full Docker deployment for faster restarts and easier debugging.*
