# Coach Artie Production Deployment Runbook

## 🚨 Critical Production Settings

### Memory Safety
- ✅ Redis maxmemory: 512MB with LRU eviction
- ✅ Node.js heap: --max-old-space-size=512
- ✅ Log rotation: 10x10MB max (100MB total)
- ✅ Session cleanup: Enabled on 5min intervals
- ✅ Interval cleanup: All setIntervals have proper shutdown handlers

### Logging
- Production logging level: `warn` (not debug!)
- Logs stored in: `/app/logs` with rotation
- Max log file size: 10MB (auto-rotate)
- Keep last 10 files only (100MB max)
- Old logs auto-deleted after 30 days

### Health Checks
- Health endpoint: `http://localhost:47319/health`
- Redis health check: Every 10s
- App health check: Every 30s

## 🚀 Deployment Checklist

### Before Deploying
- [ ] Set `NODE_ENV=production`
- [ ] Set `LOG_LEVEL=warn`
- [ ] Configure Redis memory limits in `.env.production`
- [ ] Configure Discord token/client ID
- [ ] Configure OpenRouter API key
- [ ] Review `.env.production` for all required keys
- [ ] Ensure `/app/data` directory exists and is writable
- [ ] Set `ENABLE_SCHEDULER=true` (safe in prod only)

### Deploy with Docker Compose
```bash
docker compose -f docker-compose.prod.yml up -d
```

### Monitor Memory Usage
```bash
# Check Docker container memory
docker stats coachartie-prod

# Check Redis memory
redis-cli INFO memory

# Check Node.js process memory
docker exec coachartie-prod ps aux | grep node
```

### Check Logs (with rotation in mind)
```bash
docker logs -f coachartie-prod --tail 100
```

## 🛡️ What's Protected

### Memory Leaks Fixed (Jan 2025)

**4 Critical Memory Leaks Eliminated:**

1. **Unbounded jobLogs Map** (logs.ts)
   - ✅ Cleanup runs every 5 minutes
   - ✅ Removes job logs older than 1 hour
   - ✅ Prevents unbounded growth during high concurrency

2. **Missing gracefulShutdown cleanup** (index.ts)
   - ✅ hybridDataLayer.cleanup() now called on shutdown
   - ✅ mcpProcessManager.cleanup() now called on shutdown
   - ✅ All intervals and resources properly released

3. **Event listener leaks on MCP spawning** (mcp-installer.ts)
   - ✅ 3 detached spawn() calls fixed
   - ✅ Listeners removed before unref()
   - ✅ Prevents accumulating listeners on process reuse

4. **TypeScript safety** (discord/github-integration.ts)
   - ✅ Resolved 3 strict type errors
   - ✅ Build now passes all 8 packages

**Verify the fixes:**
```bash
# Run the verification script (tests cleanup mechanisms)
npx tsx tools/verify-memory-fixes.ts

# Expected output:
# ✅ Fresh logs NOT deleted
# ✅ Old logs DELETED
# ✅ Memory bounded (<50MB)
# ✅ Log map pruned
```

### What Would Kill VPS (All Fixed)
- ❌ Unbounded setInterval (FIXED - cleared on shutdown)
- ❌ Unbounded jobLogs Map (FIXED - 5min cleanup, 1hr TTL)
- ❌ Unrotated log files (FIXED - rotation at 10MB)
- ❌ Debug logging spam (FIXED - log level=warn in prod)
- ❌ Unbounded Redis memory (FIXED - maxmemory=512MB + LRU)
- ❌ Unbounded Node heap (FIXED - --max-old-space-size=512)
- ❌ Orphaned event listeners (FIXED - cleanup before detach)

## 📊 Expected Resource Usage

### Normal Operation
- Memory: 250-400MB (Node.js) + 100-200MB (Redis) = 350-600MB total
- CPU: <10% idle, <50% under load
- Disk: Logs rotate every 10MB, max 100MB

### Memory Alerts
- 🟡 Yellow alert: >700MB
- 🔴 Red alert: >900MB (kill and restart)

## 🔄 Graceful Shutdown
- Timeout: 30 seconds for cleanup
- All intervals cleared
- All connections closed
- All pending jobs drained

## Troubleshooting

### Out of Memory
```bash
# Check what's consuming memory
docker stats coachartie-prod

# Restart just the app (keeps Redis data)
docker restart coachartie-prod

# Or full restart
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up -d
```

### Redis Full
```bash
# Clear expired keys
redis-cli FLUSHDB

# Or by type
redis-cli --scan --match "*session*" | xargs redis-cli DEL
```

### High Disk Usage
```bash
# Check log sizes
du -sh /app/logs/*

# Logs auto-rotate (10MB files, keep 10 files)
# Manual cleanup if needed:
rm /app/logs/*.log.*
```

## ✅ Production Sign-Off Checklist

Before going live:
- [ ] Memory limits configured
- [ ] Log rotation working
- [ ] Health checks passing
- [ ] 24-hour stability test completed
- [ ] Monitoring alerts configured
- [ ] Backup strategy in place
- [ ] Graceful shutdown tested
