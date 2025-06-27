# Coach Artie 2 - Monorepo

A unified monorepo for all Coach Artie services using Redis queue-based communication.

> **📄 License**: Non-commercial use only • [Commercial licenses available](#-license--commercial-use) • Built by Room 302 Studio

## ⚡ TL;DR VPS Setup (Debian/Ubuntu)

```bash
# Install Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && logout

# Clone and setup
git clone https://github.com/room302studio/coachartie2.git && cd coachartie2
cp .env.production .env

# Edit .env with your API keys (OPENAI_API_KEY, OPENROUTER_API_KEY, WOLFRAM_APP_ID required)
nano .env

# CRITICAL: Copy to docker directory
cp .env docker/.env

# Deploy!
docker-compose -f docker/docker-compose.yml up -d

# Test it
curl http://localhost:47101/health
```

**Service URLs**: 47101 (capabilities), 47102 (SMS), 47103 (email), 47104 (monitoring)

## 🎯 Current Status

✅ **Fully Working System** - Complete end-to-end AI capabilities with Discord integration  
✅ **Docker Compose Deployment** - Verified working on local and VPS environments  
✅ **Multi-model AI** - OpenRouter integration with graceful fallback to free models  
✅ **Memory System** - SQLite with FTS5 search, stores and recalls user context  
✅ **Auto-injection** - Smart capability detection for natural language queries  
✅ **Rigorous Deploy Script** - `./scripts/deploy-local.sh` for systematic environment setup  
✅ **Production Ready** - Standardized ports, comprehensive documentation, health checks  

**Last Verified**: 2025-06-27 - Discord bot responding, capabilities processing, memory recall working

---

## 🚀 Quick Development Start

### Prerequisites
- Node.js 18+ and pnpm 8+
- Redis server running locally

### Start Development Environment
```bash
# Install dependencies
pnpm install

# Start all services in development mode
pnpm run dev

# View logs in real-time
tail -f /tmp/turbo.log
```

### Restart Services
```bash
# Kill existing processes and restart
pkill -f "tsx watch" && pnpm run dev

# Or force kill all node processes if needed
pkill -f node && pnpm run dev
```

### Access Logs
```bash
# View live development logs
tail -f /tmp/turbo.log

# View specific service logs
tail -f /tmp/turbo.log | grep "@coachartie/capabilities"
tail -f /tmp/turbo.log | grep "@coachartie/discord"

# Search logs for errors
grep -E "(error|ERROR|failed|FAILED)" /tmp/turbo.log

# View last 50 lines of logs
tail -50 /tmp/turbo.log
```

### Service Endpoints (Development)
- **Capabilities**: http://localhost:47001/health
- **SMS**: http://localhost:47002/health 
- **Email**: http://localhost:47003/health
- **Redis**: localhost:6379

## 🏗 Architecture

### Core Design Principles
- **Monorepo**: All services in one repository using pnpm workspaces
- **Queue-based Communication**: Redis (BullMQ) for reliable inter-service messaging
- **TypeScript First**: Fully typed with shared types package across all services
- **Docker Native**: Containerized services with Docker Compose for consistent deployment
- **Local-first Development**: SQLite + Redis for zero external dependencies during development

### AI & Capabilities System
- **Multi-model Support**: OpenRouter integration with Claude 3.5 Sonnet, GPT, and free models (Mistral, Phi-3, Llama, Gemma)
- **Graceful Degradation**: Automatic fallback to free models when credits exhausted
- **Centralized XML Parser**: `fast-xml-parser` library replaces scattered regex patterns
- **Auto-injection**: Smart capability detection for natural language queries
- **Memory System**: SQLite with FTS5 full-text search for user context and preferences

### Service Communication
- **Redis Queues**: All inter-service communication via BullMQ for reliability
- **Health Checks**: Each service exposes `/health` endpoint for monitoring
- **Standardized Ports**: Development (47001-47003), Production (47101-47103)
- **Environment Management**: Rigorous `.env` handling with deployment scripts

### Data Persistence
- **Local SQLite**: Zero-config database with FTS5 search capabilities
- **Redis Queue Storage**: Message persistence and retry logic
- **Memory Auto-tagging**: Semantic tag generation using free models for better search

## 📦 Services

### Core Services
- **`packages/capabilities`** - Core AI orchestration and capabilities processing
  - Multi-model AI integration (OpenRouter)
  - Memory system with SQLite + FTS5 search
  - XML capability parsing and execution
  - Auto-injection for natural language queries
  - Port: 47001 (dev), 47101 (prod)

- **`packages/discord`** - Discord bot interface
  - Real-time chat processing via Redis queues
  - Direct message and mention handling
  - Capability integration for rich responses

- **`packages/sms`** - SMS interface via Twilio webhooks
  - Port: 47002 (dev), 47102 (prod)

- **`packages/email`** - Email interface with SMTP support  
  - Port: 47003 (dev), 47103 (prod)

### Supporting Infrastructure
- **`packages/shared`** - Shared types, utilities, and constants
  - Database connections and models
  - Redis queue configurations
  - Common types and interfaces

- **`packages/mcp-calculator`** - Local MCP server for math operations
  - Standalone calculator service
  - Model Context Protocol (MCP) integration

### Data & Queue Management
- **Redis** - Message queues and session storage (Port: 6379)
- **SQLite** - Local database with full-text search
- **Redis Commander** - Queue monitoring interface (Port: 47104)

## 🚀 VPS Deployment (Production Ready)

### Prerequisites
- Ubuntu/Debian VPS with sudo access
- Domain name (optional, for SSL)
- 2GB+ RAM recommended

### Step 1: Initial VPS Setup

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y git curl wget unzip

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Log out and back in for docker group changes to take effect
```

### Step 2: Clone and Setup Repository

```bash
# Clone the repository
git clone https://github.com/room302studio/coachartie2.git
cd coachartie2

# Copy environment template
cp .env.production .env

# Edit environment variables (see Environment Configuration below)
nano .env

# CRITICAL: Copy .env to docker directory (required for Docker Compose)
cp .env docker/.env
```

### Step 3: Environment Configuration

Edit your `.env` file with your actual credentials:

```bash
# Required: Basic Configuration
NODE_ENV=production
REDIS_HOST=redis
REDIS_PORT=6379

# Required: Database (Supabase)
DATABASE_URL=postgresql://your-db-url
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Required: AI Services
OPENAI_API_KEY=sk-your-openai-key
OPENROUTER_API_KEY=sk-your-openrouter-key
WOLFRAM_APP_ID=your-wolfram-app-id

# Optional: Discord Bot
DISCORD_TOKEN=your-discord-bot-token
DISCORD_CLIENT_ID=your-discord-app-id

# Optional: SMS (Twilio)
TWILIO_ACCOUNT_SID=your-twilio-sid
TWILIO_AUTH_TOKEN=your-twilio-token
TWILIO_PHONE_NUMBER=+1234567890

# Optional: Email (SMTP)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password
EMAIL_FROM=your-email@gmail.com

# Service Ports (Production)
CAPABILITIES_PORT=47101
SMS_PORT=47102
EMAIL_PORT=47103

# Optional: Logging & Monitoring
LOG_LEVEL=info
SENTRY_DSN=your-sentry-dsn
```

### Step 4: Deploy Services

```bash
# Start all services
docker-compose -f docker/docker-compose.yml up -d

# Check service status
docker-compose -f docker/docker-compose.yml ps

# View logs
docker-compose -f docker/docker-compose.yml logs -f

# View specific service logs
docker-compose -f docker/docker-compose.yml logs -f capabilities
docker-compose -f docker/docker-compose.yml logs -f discord
```

### Step 5: Configure Firewall (if needed)

```bash
# Allow SSH (if not already configured)
sudo ufw allow ssh

# Allow service ports
sudo ufw allow 47102  # SMS webhook
sudo ufw allow 47103  # Email webhook

# Optional: Redis Commander (monitoring)
sudo ufw allow 47104

# Enable firewall
sudo ufw enable
```

### Step 6: Setup Webhooks

#### SMS (Twilio)
In your Twilio console, set webhook URL to:
```
http://your-vps-ip:47102/sms/webhook
```

#### Email 
Configure your email provider's webhook to:
```
http://your-vps-ip:47103/email/webhook
```

### Step 7: Health Checks & Monitoring

```bash
# Check service health
curl http://localhost:47101/health  # Capabilities
curl http://localhost:47102/health  # SMS
curl http://localhost:47103/health  # Email

# Monitor Redis queues (optional)
# Visit http://your-vps-ip:47104 for Redis Commander
```

## 🛠 Managing the Deployment

### Start/Stop Services
```bash
# Stop all services
docker-compose -f docker/docker-compose.yml down

# Start all services
docker-compose -f docker/docker-compose.yml up -d

# Restart specific service
docker-compose -f docker/docker-compose.yml restart capabilities

# Update and redeploy
git pull
docker-compose -f docker/docker-compose.yml down
docker-compose -f docker/docker-compose.yml up -d --build
```

### View Logs
```bash
# All services
docker-compose -f docker/docker-compose.yml logs -f

# Specific service
docker-compose -f docker/docker-compose.yml logs -f discord

# Last 100 lines
docker-compose -f docker/docker-compose.yml logs --tail=100 capabilities
```

### Troubleshooting
```bash
# Check container status
docker ps

# Check Redis connection
docker exec -it coachartie2-redis-1 redis-cli ping

# Check service health endpoints
curl http://localhost:47101/health
curl http://localhost:47102/health
curl http://localhost:47103/health

# Check queue status (Redis Commander)
# Visit http://your-vps-ip:47104
```

## 🔧 Custom Port Configuration

If you need to use different ports, update your `.env` file:

```bash
# Custom ports
CAPABILITIES_PORT=8991
SMS_PORT=8993
EMAIL_SERVICE_PORT=8994
REDIS_PORT=6380
```

Then update your `docker/docker-compose.yml` ports section:

```yaml
sms:
  ports:
    - "${SMS_PORT:-9993}:${SMS_PORT:-9993}"

email:
  ports:
    - "${EMAIL_SERVICE_PORT:-9994}:${EMAIL_SERVICE_PORT:-9994}"
```

## 📊 Service URLs

After deployment, your services will be available at:

- **Capabilities Health**: `http://your-vps-ip:47101/health`
- **SMS Webhook**: `http://your-vps-ip:47102/sms/webhook`
- **Email Webhook**: `http://your-vps-ip:47103/email/webhook`
- **Redis Commander**: `http://your-vps-ip:47104` (monitoring)

## 🚀 Deployment Scripts

### Local Development Script
Use the rigorous deployment script for local development:

```bash
# Run the complete local deployment
./scripts/deploy-local.sh
```

**What it does:**
- ✅ Verifies `.env.local` exists with your API keys
- ✅ Copies environment variables to `docker/.env` (critical step!)  
- ✅ Adds Docker-specific settings automatically
- ✅ Stops existing services cleanly
- ✅ Builds and starts all services with proper environment
- ✅ Tests health endpoints and provides service URLs
- ✅ Shows logs and restart commands

**Environment Files:**
- `.env.local` - Your actual API keys (OpenRouter, Discord, etc.)
- `docker/.env` - Auto-generated Docker environment (don't edit manually)
- `.env.production` - Template for VPS deployment

## 🔄 Updates & Maintenance

```bash
# Update to latest version
cd coachartie2
git pull

# Rebuild and restart
docker-compose -f docker/docker-compose.yml down
docker-compose -f docker/docker-compose.yml up -d --build

# Backup data (Redis)
docker exec coachartie2-redis-1 redis-cli save
docker cp coachartie2-redis-1:/data/dump.rdb ./backup-$(date +%Y%m%d).rdb
```

## 🧪 Testing Your Deployment

```bash
# Test Discord bot (send a DM or mention)
# Bot should respond via Discord

# Test SMS (if configured)
curl -X POST http://your-vps-ip:47102/sms/webhook \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "From=+1234567890&Body=Hello&MessageSid=test123"

# Test Email (if configured)  
curl -X POST http://your-vps-ip:47103/email/inbound \
  -H "Content-Type: application/json" \
  -d '{"from":"test@example.com","subject":"Test","body":"Hello Coach Artie"}'
```

## 🌐 SSL/Domain Setup (Optional)

For production with a domain:

```bash
# Install Nginx
sudo apt install nginx

# Install Certbot
sudo apt install certbot python3-certbot-nginx

# Configure Nginx reverse proxy
sudo nano /etc/nginx/sites-available/coachartie

# Add SSL certificate
sudo certbot --nginx -d your-domain.com
```

## 📝 Environment Variables Reference

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `DATABASE_URL` | Yes | Supabase database URL | `postgresql://...` |
| `OPENAI_API_KEY` | Yes | OpenAI API key | `sk-...` |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key | `sk-or-...` |
| `WOLFRAM_APP_ID` | Yes | Wolfram Alpha App ID | `XXXXXX-XXXXXXXXXX` |
| `DISCORD_TOKEN` | No | Discord bot token | |
| `TWILIO_ACCOUNT_SID` | No | Twilio account SID | |
| `EMAIL_USER` | No | SMTP email username | |
| `REDIS_HOST` | No | Redis host (default: redis) | `redis` |

## 🎯 Quick Start Commands

```bash
# 1. Clone repository
git clone https://github.com/room302studio/coachartie2.git && cd coachartie2

# 2. Configure environment
cp .env.production .env && nano .env

# 3. Copy .env to docker directory (CRITICAL!)
cp .env docker/.env

# 4. Deploy
docker-compose -f docker/docker-compose.yml up -d

# 5. Check status
docker-compose -f docker/docker-compose.yml ps
```

That's it! Your Coach Artie services should now be running and processing messages through Redis queues. 🚀

## 📄 License & Commercial Use

**Non-Commercial License**: This project is licensed under Creative Commons Attribution-NonCommercial 4.0 International License.

### ✅ Permitted (Non-Commercial):
- Personal use and experimentation
- Educational and research purposes  
- Open source contributions and improvements
- Non-profit organization usage

### ❌ Requires Commercial License:
- Business or commercial environments
- Revenue-generating services or products
- Integration into commercial software
- Providing paid services using this platform

### 💼 Commercial Licensing Available

For commercial use, please contact **Room 302 Studio** to obtain a commercial license.

We offer flexible commercial licensing options for:
- **Startups** - Affordable licensing for growing businesses
- **Enterprise** - Full commercial rights with support
- **SaaS Providers** - White-label licensing options
- **Custom Integrations** - Tailored licensing for specific use cases

**Contact for Commercial Licensing:**
- Email: ejfox@room302.studio
- Website: room302.studio

---

**Why This Licensing Model?**

We've made sophisticated AI infrastructure accessible to everyone for learning and personal use, while ensuring sustainable development through commercial licensing. This approach supports open innovation while enabling us to continue improving the platform.