# Coach Artie 2 - Monorepo

A unified monorepo for all Coach Artie services using Redis queue-based communication.

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

- **Monorepo**: All services in one repository using pnpm workspaces
- **Queue-based**: Redis (BullMQ) for inter-service communication
- **TypeScript**: Fully typed with shared types package
- **Docker**: Containerized services with Docker Compose

## 📦 Services

- `packages/capabilities` - Core AI capabilities and message processing (Port: 18239)
- `packages/discord` - Discord bot interface 
- `packages/sms` - SMS interface via Twilio (Port: 27461)
- `packages/email` - Email interface (Port: 35892)
- `packages/shared` - Shared types, utilities, and constants

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