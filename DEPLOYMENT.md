# Coach Artie 2 - Deployment Guide

## 🚀 Quick Start

### Local Testing
```bash
# Test locally first
./scripts/deploy.sh local

# Check health
curl http://localhost:18239/health
```

### VPS Deployment
```bash
# 1. Set environment variables
export DEPLOY_HOST="your-vps-ip"
export OPENROUTER_API_KEY="your-key"
# ... other env vars

# 2. Deploy to VPS
./scripts/deploy.sh remote
```

## 📋 Prerequisites

### Local Development
- Docker and Docker Compose
- Node.js 20+ and pnpm
- Environment variables configured

### VPS Requirements
- Debian 11+ or Ubuntu 20.04+ VPS
- 2GB+ RAM (4GB recommended)
- 20GB+ disk space
- Root access for initial setup

## 🔧 VPS Setup

### 1. Initial Server Setup

Run the automated setup script on your VPS:

```bash
# On your VPS as root
curl -fsSL https://raw.githubusercontent.com/your-repo/coachartie2/main/scripts/vps-setup.sh | bash
```

Or manually:

```bash
# Upload and run the setup script
scp scripts/vps-setup.sh root@your-vps:/tmp/
ssh root@your-vps "chmod +x /tmp/vps-setup.sh && /tmp/vps-setup.sh"
```

The setup script will:
- ✅ Install Docker and Docker Compose
- ✅ Create `coachartie` user account
- ✅ Configure firewall (UFW)
- ✅ Set up monitoring tools
- ✅ Configure log rotation
- ✅ Create systemd service
- ✅ Optimize system settings

### 2. Environment Configuration

Create your environment file on the VPS:

```bash
# SSH to your VPS as coachartie user
ssh coachartie@your-vps

# Create environment file
cat > /home/coachartie/coachartie2/.env << EOF
# Production Environment Variables
NODE_ENV=production
LOG_LEVEL=info

# Required API Keys
OPENROUTER_API_KEY=your_openrouter_key_here
DISCORD_TOKEN=your_discord_token_here
DISCORD_CLIENT_ID=your_discord_client_id_here
WOLFRAM_APP_ID=your_wolfram_app_id_here
TWILIO_ACCOUNT_SID=your_twilio_sid_here
TWILIO_AUTH_TOKEN=your_twilio_token_here
TWILIO_PHONE_NUMBER=your_twilio_number_here

# Database
DATABASE_PATH=/app/data/coachartie.db

# Service Configuration
CAPABILITIES_PORT=18239
REDIS_HOST=redis
REDIS_PORT=6379
EOF
```

### 3. Deployment

From your local machine:

```bash
# Set deployment target
export DEPLOY_HOST="your-vps-ip"
export DEPLOY_USER="coachartie"

# Deploy the application
./scripts/deploy.sh remote
```

## 🐳 Docker Configuration

### Production Architecture

```
┌─────────────────┐    ┌──────────────────┐
│   Redis Cache   │    │   Capabilities   │
│   Port: 6379    │◄───┤   Service        │
│   (internal)    │    │   Port: 18239    │
└─────────────────┘    └──────────────────┘
        ▲                        ▲
        │                        │
    ┌─────────────────────────────┘
    │   Persistent Volumes:
    │   • redis_data
    │   • capabilities_data
    │   • mcp_data
    └─
```

### Docker Compose Files

- `docker-compose.yml` - Development environment
- `docker-compose.prod.yml` - Production environment

Key differences:
- Production uses optimized Dockerfile.prod
- Resource limits and reservations
- Persistent volumes for data
- Longer health check timeouts
- No source code mounting

### Resource Requirements

| Service      | Memory Limit | Memory Reserved | CPU |
|--------------|-------------|-----------------|-----|
| Redis        | 256MB       | 128MB          | 0.5 |
| Capabilities | 1GB         | 512MB          | 1.0 |

## 🔍 Monitoring & Health Checks

### Health Endpoints

```bash
# Service health
curl http://your-vps:18239/health

# Expected response
{
  "status": "healthy",
  "service": "capabilities", 
  "timestamp": "2025-07-20T14:00:00.000Z",
  "checks": {
    "redis": "connected"
  }
}
```

### Service Management

```bash
# Using systemd (recommended)
sudo systemctl start coachartie     # Start services
sudo systemctl stop coachartie      # Stop services  
sudo systemctl restart coachartie   # Restart services
sudo systemctl status coachartie    # Check status

# Using Docker Compose directly
docker-compose -f docker-compose.prod.yml up -d     # Start
docker-compose -f docker-compose.prod.yml down      # Stop
docker-compose -f docker-compose.prod.yml logs -f   # View logs
```

### Log Management

```bash
# View service logs
docker-compose -f docker-compose.prod.yml logs -f capabilities

# View specific container logs
docker logs coachartie2-capabilities-1 --tail 100 -f

# Check disk usage
docker system df
```

### Monitoring Commands

```bash
# System resources
htop                    # CPU/Memory usage
iotop                   # Disk I/O
nethogs                 # Network usage  
ncdu /home/coachartie   # Disk usage analysis

# Docker resources
docker stats            # Container resource usage
docker system prune -af # Clean up unused resources
```

## 🔧 Troubleshooting

### Common Issues

#### 1. Service Won't Start
```bash
# Check Docker daemon
sudo systemctl status docker

# Check logs
docker-compose -f docker-compose.prod.yml logs

# Rebuild containers
docker-compose -f docker-compose.prod.yml up --build -d
```

#### 2. Health Check Failures
```bash
# Test connectivity
curl -v http://localhost:18239/health

# Check port binding
netstat -tlnp | grep 18239

# Check container status
docker ps
```

#### 3. Database Issues
```bash
# Check database file permissions
ls -la /home/coachartie/coachartie2/packages/capabilities/data/

# Backup database
tar -czf /home/coachartie/backups/db-backup-$(date +%Y%m%d).tar.gz \
  packages/capabilities/data/coachartie.db
```

#### 4. Memory Issues
```bash
# Check memory usage
free -h
docker stats

# Restart services if needed
sudo systemctl restart coachartie
```

### Log Locations

```bash
# Application logs
docker-compose -f docker-compose.prod.yml logs capabilities

# System logs
journalctl -u coachartie.service -f

# Docker daemon logs
journalctl -u docker.service -f
```

## 🔒 Security

### Firewall Configuration
```bash
# Check firewall status
sudo ufw status

# Allowed ports:
# - 22 (SSH)
# - 80 (HTTP)
# - 443 (HTTPS) 
# - 18239 (Coach Artie)
```

### SSL/TLS Setup (Optional)

To add HTTPS support, you can use nginx as a reverse proxy:

```bash
# Install nginx
sudo apt-get install nginx certbot python3-certbot-nginx

# Configure nginx
sudo nano /etc/nginx/sites-available/coachartie

# Get SSL certificate
sudo certbot --nginx -d your-domain.com
```

Sample nginx config:
```nginx
server {
    listen 80;
    server_name your-domain.com;
    
    location / {
        proxy_pass http://localhost:18239;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 📊 Performance Optimization

### Database Optimization
```bash
# Run VACUUM on SQLite database (monthly)
docker exec coachartie2-capabilities-1 \
  sqlite3 /app/data/coachartie.db "VACUUM;"

# Analyze database size
docker exec coachartie2-capabilities-1 \
  sqlite3 /app/data/coachartie.db ".dbinfo"
```

### Resource Monitoring
```bash
# Set up monitoring alerts (optional)
# Install htop, iotop, and other monitoring tools via setup script

# Docker resource limits are already configured in docker-compose.prod.yml
```

## 🔄 Backup & Recovery

### Automated Backups
```bash
# Database backup script (add to cron)
#!/bin/bash
BACKUP_DIR="/home/coachartie/backups"
DATE=$(date +%Y%m%d-%H%M%S)

# Backup database
docker exec coachartie2-capabilities-1 \
  cp /app/data/coachartie.db /tmp/backup.db
docker cp coachartie2-capabilities-1:/tmp/backup.db \
  $BACKUP_DIR/coachartie-$DATE.db

# Keep only last 7 days
find $BACKUP_DIR -name "coachartie-*.db" -mtime +7 -delete
```

### Recovery
```bash
# Stop services
sudo systemctl stop coachartie

# Restore database
cp /home/coachartie/backups/coachartie-YYYYMMDD.db \
  /home/coachartie/coachartie2/packages/capabilities/data/coachartie.db

# Start services
sudo systemctl start coachartie
```

## 📞 Support

### Integration Testing
```bash
# Test MCP auto-installation
curl -X POST http://your-vps:18239/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"<mcp-auto-install>@shelm/wikipedia-mcp-server</mcp-auto-install>","userId":"test"}'

# Test Wikipedia search
curl -X POST http://your-vps:18239/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"<search-wikipedia>artificial intelligence</search-wikipedia>","userId":"test"}'

# Test calculator
curl -X POST http://your-vps:18239/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"<calculate>42 * 42</calculate>","userId":"test"}'
```

### Getting Help

1. Check the logs first: `docker-compose -f docker-compose.prod.yml logs -f`
2. Verify environment variables are set correctly
3. Test network connectivity: `curl -v http://localhost:18239/health`
4. Check system resources: `htop` and `docker stats`

---

## 🎯 Deployment Checklist

### Pre-deployment
- [ ] VPS provisioned with adequate resources
- [ ] Domain name configured (if using SSL)
- [ ] Environment variables gathered
- [ ] SSH access to VPS confirmed

### Setup
- [ ] Run VPS setup script
- [ ] Configure environment variables
- [ ] Test deployment locally first
- [ ] Deploy to VPS
- [ ] Verify health checks pass

### Post-deployment
- [ ] Set up monitoring alerts
- [ ] Configure automated backups
- [ ] Test all MCP functionality
- [ ] Document any custom configurations
- [ ] Plan update/maintenance schedule

**Status**: ✅ Ready for Production Deployment