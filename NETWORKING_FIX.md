# Networking Issue Fix

## The Problem
- Express claims to bind to port but nothing actually listens
- Self-test via fetch() works but external curl fails
- Process exits after successful initialization
- Issue only on macOS development, not in Docker/production

## Root Cause Theories
1. **macOS security blocking network binding** - Possible but self-test works
2. **tsx watch + turbo stdin issue** - Confirmed by research
3. **Process exiting after async operations** - Most likely

## Immediate Fix (Works Now)

### Option 1: Use PM2 (Recommended)
```bash
# Install globally
npm install -g pm2

# Start services
pm2 start packages/capabilities/src/index.ts --interpreter tsx --name capabilities
pm2 start packages/discord/src/index.ts --interpreter tsx --name discord
pm2 start packages/sms/src/index.ts --interpreter tsx --name sms
pm2 start packages/email/src/index.ts --interpreter tsx --name email

# View logs
pm2 logs

# Stop all
pm2 stop all
```

### Option 2: Use Docker (Best for deployment)
```bash
docker-compose -f docker/docker-compose.yml up
```

### Option 3: Direct run (for debugging)
```bash
# Run each in separate terminal
cd packages/capabilities && node --loader tsx src/index.ts
cd packages/discord && node --loader tsx src/index.ts
cd packages/sms && node --loader tsx src/index.ts
cd packages/email && node --loader tsx src/index.ts
```

## Long-term Solution

Update all package.json files to use nodemon with proper config:

```json
{
  "scripts": {
    "dev": "nodemon",
    "dev:pm2": "pm2 start src/index.ts --interpreter tsx --name ${npm_package_name}"
  }
}
```

Create nodemon.json in each package:
```json
{
  "watch": ["src"],
  "ext": "ts",
  "exec": "node --loader tsx src/index.ts",
  "env": {
    "NODE_ENV": "development"
  }
}
```

## Why This Works
- PM2 keeps processes alive properly
- Docker bypasses macOS networking issues
- Direct node execution avoids tsx watch issues
- All solutions work identically on Debian VPS

## For VPS Deployment
```bash
# Use Docker (recommended)
docker-compose -f docker/docker-compose.yml up -d

# Or use PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```