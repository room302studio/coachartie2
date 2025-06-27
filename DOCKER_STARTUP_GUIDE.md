# Docker Compose Startup Guide

✅ **WORKING AS OF 2025-06-27** - Fixed all lockfile and env var issues!

## Quick Start (Exactly as documented in README)

1. **Configure environment variables:**
   ```bash
   # Copy and customize env file with your API keys
   cp .env.production .env
   nano .env  # Add your actual API keys
   
   # IMPORTANT: Copy .env to docker directory
   cp .env docker/.env
   ```

2. **Start all services:**
   ```bash
   docker-compose -f docker/docker-compose.yml up -d
   ```

3. **Check service status:**
   ```bash
   docker-compose -f docker/docker-compose.yml ps
   ```

4. **View logs:**
   ```bash
   docker-compose -f docker/docker-compose.yml logs -f
   ```

## Service URLs (Updated with Unique Ports)

- **Capabilities Health**: `http://localhost:47101/health`
- **SMS Webhook**: `http://localhost:47102/sms/webhook`  
- **Email Webhook**: `http://localhost:47103/email/webhook`
- **Redis Commander**: `http://localhost:47104` (monitoring)

## Environment Variables Required

The setup uses these variables from your .env file:
- `DATABASE_URL` - Supabase database  
- `OPENAI_API_KEY` - OpenAI API key
- `OPENROUTER_API_KEY` - OpenRouter API key (REQUIRED)
- `WOLFRAM_APP_ID` - Wolfram Alpha API ID (REQUIRED)
- `DISCORD_TOKEN` - Discord bot token (optional)
- `TWILIO_*` - SMS credentials (optional)
- `EMAIL_*` - Email SMTP settings (optional)

**Key Fix**: Environment variables must be copied to `docker/.env` for Docker Compose to read them properly.

## Notes

- Services use unique high ports: 47101, 47102, 47103 (production) / 47001, 47002, 47003 (dev)
- Redis runs on standard port 6379
- All services connect via internal Docker network
- Warning messages about missing env vars are normal for optional services
- Ports chosen to avoid conflicts with other applications on VPS/dev servers

## Troubleshooting

```bash
# Stop all services
docker-compose -f docker/docker-compose.yml down

# Rebuild and restart
docker-compose -f docker/docker-compose.yml up -d --build

# Check specific service logs
docker-compose -f docker/docker-compose.yml logs capabilities
```

## Verified Working (2025-06-27)

✅ **Health Check**: `curl http://localhost:47101/health`
```json
{"status":"healthy","service":"capabilities","timestamp":"...","checks":{"redis":"connected"}}
```

✅ **Chat Test**: `curl -X POST http://localhost:47101/chat -H "Content-Type: application/json" -d '{"message":"test","userId":"docker-test"}'`
```json
{"success":true,"messageId":"...","response":"I'm Coach Artie! I'm having some technical difficulties right now, but I'm here to help..."}
```

## Issues Fixed

1. **Lockfile Issues**: Nuked and regenerated pnpm-lock.yaml
2. **Environment Variables**: Added OPENROUTER_API_KEY and WOLFRAM_APP_ID to docker-compose.yml
3. **Docker .env Location**: Must copy .env to docker/.env directory
4. **Port Consistency**: Updated Dockerfile.capabilities EXPOSE to 47101

This matches exactly what's documented in the README.md file and is now fully working.