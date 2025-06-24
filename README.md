# Coach Artie 2 - Monorepo

A unified monorepo for all Coach Artie services using Redis queue-based communication.

## 🏗 Architecture

- **Monorepo**: All services in one repository using pnpm workspaces
- **Queue-based**: Redis (BullMQ) for inter-service communication
- **TypeScript**: Fully typed with shared types package
- **Docker**: Containerized services with Docker Compose

## 📦 Services

- `packages/capabilities` - Core AI capabilities and message processing (Port: 9991)
- `packages/discord` - Discord bot interface 
- `packages/sms` - SMS interface via Twilio (Port: 9993)
- `packages/email` - Email interface (Port: 9994)
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

# Required: OpenAI
OPENAI_API_KEY=sk-your-openai-key

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

# Optional: Custom Ports (if needed)
CAPABILITIES_PORT=9991
SMS_PORT=9993
EMAIL_SERVICE_PORT=9994

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
sudo ufw allow 9993  # SMS webhook
sudo ufw allow 9994  # Email webhook

# Optional: Redis Commander (monitoring)
sudo ufw allow 8081

# Enable firewall
sudo ufw enable
```

### Step 6: Setup Webhooks

#### SMS (Twilio)
In your Twilio console, set webhook URL to:
```
http://your-vps-ip:9993/sms/webhook
```

#### Email 
Configure your email provider's webhook to:
```
http://your-vps-ip:9994/email/webhook
```

### Step 7: Health Checks & Monitoring

```bash
# Check service health
curl http://localhost:9991/health  # Capabilities
curl http://localhost:9993/health  # SMS
curl http://localhost:9994/health  # Email

# Monitor Redis queues (optional)
# Visit http://your-vps-ip:8081 for Redis Commander
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
curl http://localhost:9991/health
curl http://localhost:9993/health
curl http://localhost:9994/health

# Check queue status (Redis Commander)
# Visit http://your-vps-ip:8081
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

- **Capabilities Health**: `http://your-vps-ip:9991/health`
- **SMS Webhook**: `http://your-vps-ip:9993/sms/webhook`
- **Email Webhook**: `http://your-vps-ip:9994/email/webhook`
- **Redis Commander**: `http://your-vps-ip:8081` (monitoring)

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
curl -X POST http://your-vps-ip:9993/sms/webhook \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "From=+1234567890&Body=Hello&MessageSid=test123"

# Test Email (if configured)  
curl -X POST http://your-vps-ip:9994/email/inbound \
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

# 3. Deploy
docker-compose -f docker/docker-compose.yml up -d

# 4. Check status
docker-compose -f docker/docker-compose.yml ps
```

That's it! Your Coach Artie services should now be running and processing messages through Redis queues. 🚀