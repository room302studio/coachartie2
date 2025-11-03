#!/bin/bash

# Coach Artie 2 Deployment Script
# Deploys the application to a Debian VPS

set -e  # Exit on any error

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
DEPLOY_USER=${DEPLOY_USER:-"coachartie"}
DEPLOY_HOST=${DEPLOY_HOST:-""}
DEPLOY_PATH=${DEPLOY_PATH:-"/home/coachartie/coachartie2"}
COMPOSE_FILE=${COMPOSE_FILE:-"docker-compose.prod.yml"}
BACKUP_PATH=${BACKUP_PATH:-"/home/coachartie/backups"}

# Interactive mode if DEPLOY_HOST not set
if [ "$1" = "remote" ] && [ -z "$DEPLOY_HOST" ]; then
    echo ""
    echo "Remote deployment requires VPS connection info:"
    echo ""
    read -p "VPS IP or hostname: " DEPLOY_HOST
    read -p "SSH user [coachartie]: " input
    DEPLOY_USER=${input:-coachartie}
    echo ""

    if [ -z "$DEPLOY_HOST" ]; then
        print_error "VPS hostname is required"
        exit 1
    fi
fi

# Function to print colored output
print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if required environment variables are set
check_environment() {
    print_status "Checking environment variables..."

    # Critical vars (must have)
    critical_vars=(
        "OPENROUTER_API_KEY"
        "DISCORD_TOKEN"
        "DISCORD_CLIENT_ID"
    )

    # Optional vars
    optional_vars=(
        "OPENAI_API_KEY"
        "WOLFRAM_APP_ID"
        "TWILIO_ACCOUNT_SID"
        "TWILIO_AUTH_TOKEN"
        "TWILIO_PHONE_NUMBER"
    )

    # Interactive prompt for missing critical vars
    for var in "${critical_vars[@]}"; do
        if [[ -z "${!var}" ]]; then
            echo ""
            read -p "$var: " value
            if [ -z "$value" ]; then
                print_error "$var is required"
                exit 1
            fi
            export "$var=$value"
            print_status "✓ $var set"
        else
            print_status "✓ $var already configured"
        fi
    done

    # Optional vars - just note if missing
    for var in "${optional_vars[@]}"; do
        if [[ -z "${!var}" ]]; then
            print_warning "Optional: $var not set (skipping)"
        else
            print_status "✓ $var configured"
        fi
    done
}

# Deploy to local environment (for testing production setup)
deploy_local() {
    print_status "Testing PRODUCTION setup locally..."

    # Check Docker is running
    if ! docker ps &>/dev/null; then
        print_error "Docker is not running"
        exit 1
    fi

    # Check for .env file
    if [ ! -f ".env" ]; then
        print_warning "No .env file found, will use environment variables"
    fi

    # Stop existing services
    print_status "Stopping existing services..."
    docker compose -f $COMPOSE_FILE down 2>/dev/null || docker-compose -f $COMPOSE_FILE down 2>/dev/null || true

    # Build and start production services
    print_status "Building and starting PRODUCTION services..."
    if ! docker compose -f $COMPOSE_FILE up --build -d 2>/dev/null; then
        docker-compose -f $COMPOSE_FILE up --build -d || {
            print_error "Failed to start services"
            exit 1
        }
    fi

    # Wait for services to be healthy
    print_status "Waiting for services to start (up to 2 minutes)..."
    COUNTER=0
    MAX_WAIT=120
    while [ $COUNTER -lt $MAX_WAIT ]; do
        if docker ps | grep -q "coachartie-prod.*healthy"; then
            break
        fi
        echo -n "."
        sleep 5
        COUNTER=$((COUNTER + 5))
    done
    echo ""

    if [ $COUNTER -ge $MAX_WAIT ]; then
        print_warning "Services did not become healthy within 2 minutes"
        print_status "Checking logs..."
        docker compose -f $COMPOSE_FILE logs --tail 50
    fi

    # Test the deployment
    print_status "Testing deployment..."
    sleep 5

    if curl -sf http://localhost:47324/health >/dev/null 2>&1; then
        print_status "✅ Health check passed"
    else
        print_error "Health check failed!"
        print_status "Container status:"
        docker ps
        print_status "Recent logs:"
        docker compose -f $COMPOSE_FILE logs --tail 30
        exit 1
    fi

    print_status "✅ Local deployment successful!"
    echo ""
    echo "Services:"
    docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
    echo ""

    # Auto-validate
    validate_deployment
}

# Deploy to remote VPS
deploy_remote() {
    print_status "Deploying to remote VPS: $DEPLOY_USER@$DEPLOY_HOST"

    # Check SSH connectivity
    print_status "Testing SSH connection..."
    if ! ssh -o ConnectTimeout=10 -o BatchMode=yes $DEPLOY_USER@$DEPLOY_HOST echo "SSH OK" &>/dev/null; then
        print_error "Cannot connect to $DEPLOY_USER@$DEPLOY_HOST via SSH"
        print_error "Make sure:"
        print_error "  1. VPS is reachable"
        print_error "  2. SSH keys are set up"
        print_error "  3. User '$DEPLOY_USER' exists"
        exit 1
    fi
    print_status "✓ SSH connection successful"

    # Create .env file for production
    create_env_file

    # Upload files to VPS
    print_status "Uploading files to VPS..."
    rsync -avz --delete \
        --exclude='.git' \
        --exclude='node_modules' \
        --exclude='dist' \
        --exclude='*.log' \
        --exclude='.env' \
        --exclude='.env.production' \
        --exclude='data/' \
        --exclude='logs/' \
        ./ $DEPLOY_USER@$DEPLOY_HOST:$DEPLOY_PATH/ || {
        print_error "Failed to upload files"
        exit 1
    }

    # Upload .env.production file separately
    print_status "Uploading production configuration..."
    scp .env.production $DEPLOY_USER@$DEPLOY_HOST:$DEPLOY_PATH/.env.production || {
        print_error "Failed to upload .env file"
        exit 1
    }

    # Upload and execute deployment script on VPS
    print_status "Executing deployment on VPS..."
    ssh $DEPLOY_USER@$DEPLOY_HOST << 'EOF' || {
        print_error "Deployment failed on VPS"
        exit 1
    }
        set -e
        cd /home/coachartie/coachartie2

        # Create backup
        mkdir -p ~/backups
        if [ -d "data" ] && [ -f "data/coachartie.db" ]; then
            echo "Creating backup..."
            tar -czf ~/backups/data-backup-$(date +%Y%m%d-%H%M%S).tar.gz data/
            echo "✓ Backup created"
        fi

        # Stop existing services
        echo "Stopping services..."
        docker compose -f docker-compose.prod.yml down 2>/dev/null || docker-compose -f docker-compose.prod.yml down 2>/dev/null || true

        # Build and start services
        echo "Building and starting services..."
        docker compose -f docker-compose.prod.yml up --build -d || docker-compose -f docker-compose.prod.yml up --build -d || exit 1

        # Wait for services
        echo "Waiting for services to start..."
        sleep 10

        COUNTER=0
        MAX_WAIT=120
        while [ $COUNTER -lt $MAX_WAIT ]; do
            if docker ps | grep -q "coachartie-prod.*healthy"; then
                echo "✓ Services are healthy"
                break
            fi
            sleep 5
            COUNTER=$((COUNTER + 5))
        done

        # Test deployment
        echo "Testing health endpoint..."
        if curl -sf http://localhost:47319/health >/dev/null 2>&1; then
            echo "✅ Health check passed"
        else
            echo "⚠️  Health check failed, checking logs..."
            docker compose -f docker-compose.prod.yml logs --tail 20
            exit 1
        fi

        echo ""
        echo "✅ Remote deployment successful!"
        echo ""
        echo "Run validation: ./scripts/validate.sh"
EOF

    print_status "✅ Remote deployment completed!"
    echo ""
    echo "Testing deployment..."
    ssh $DEPLOY_USER@$DEPLOY_HOST 'cd /home/coachartie/coachartie2 && bash scripts/deploy.sh validate'
}

# Create production environment file
create_env_file() {
    print_status "Creating production environment file..."
    cat > .env.production << EOF
# Coach Artie 2 Production Configuration
# Generated by deploy.sh on $(date)

# ============================================
# REQUIRED - Production API Keys
# ============================================

OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-""}
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODELS=anthropic/claude-3.5-sonnet
FAST_MODEL=anthropic/claude-3-haiku

DISCORD_TOKEN=${DISCORD_TOKEN:-""}
DISCORD_CLIENT_ID=${DISCORD_CLIENT_ID:-""}

# ============================================
# OPTIONAL - Feature Keys
# ============================================

TWILIO_ACCOUNT_SID=${TWILIO_ACCOUNT_SID:-""}
TWILIO_AUTH_TOKEN=${TWILIO_AUTH_TOKEN:-""}
TWILIO_PHONE_NUMBER=${TWILIO_PHONE_NUMBER:-""}

OPENAI_API_KEY=${OPENAI_API_KEY:-""}
WOLFRAM_APP_ID=${WOLFRAM_APP_ID:-""}

EMAIL_WEBHOOK_URL=${EMAIL_WEBHOOK_URL:-""}
EMAIL_WEBHOOK_AUTH=${EMAIL_WEBHOOK_AUTH:-""}

# ============================================
# PRODUCTION SETTINGS
# ============================================

NODE_ENV=production
LOG_LEVEL=info
CONSOLE_LOG_LEVEL=warn

# Database and storage paths
DATABASE_PATH=/app/data/coachartie.db
LOGS_DIR=/app/logs

# Service ports
REDIS_HOST=redis
REDIS_PORT=47320
CAPABILITIES_PORT=47324
DISCORD_PORT=47321
SMS_PORT=47326
BRAIN_PORT=47325

# Learning & Memory
ENABLE_AUTO_REFLECTION=true
CONTEXT_WINDOW_SIZE=8000
CONTEXT_ALCHEMY_DEBUG=false
EOF
    print_status "✓ Production environment file created (.env.production)"
}

# Validate deployment
validate_deployment() {
    echo ""
    print_status "Validating deployment..."

    PASSED=0
    FAILED=0

    # Health check
    if curl -sf http://localhost:47319/health >/dev/null 2>&1; then
        print_status "✓ Health endpoint"
        ((PASSED++))
    else
        print_error "✗ Health endpoint"
        ((FAILED++))
    fi

    # Containers running
    if docker ps | grep -q "coachartie-prod"; then
        print_status "✓ Containers running"
        ((PASSED++))
    else
        print_error "✗ Containers not running"
        ((FAILED++))
    fi

    # Memory check
    MEM=$(docker stats --no-stream coachartie-prod --format "{{.MemUsage}}" 2>/dev/null | awk '{print $1}' | sed 's/MiB//')
    if [ -n "$MEM" ] && (( $(echo "$MEM < 700" | bc -l 2>/dev/null || echo 1) )); then
        print_status "✓ Memory normal (${MEM}MB)"
        ((PASSED++))
    else
        print_warning "⚠ Memory: ${MEM}MB"
    fi

    echo ""
    if [ $FAILED -eq 0 ]; then
        print_status "✅ All checks passed ($PASSED/3)"
    else
        print_error "❌ Some checks failed ($FAILED failed)"
        exit 1
    fi
}

# Show usage
usage() {
    cat << 'EOF'
Coach Artie Deployment

FIRST TIME SETUP (see README.md):
  cp .env.example .env
  nano .env  # Add OPENROUTER_API_KEY, DISCORD_TOKEN, DISCORD_CLIENT_ID
  npm run dev

DAILY DEV:
  npm run dev              Start development (auto-reload)
  docker-compose up        Dev microservices
  ./scripts/ops.sh health  Check health

DEPLOY TO VPS:
  ./scripts/deploy.sh remote
    → Prompts for VPS IP, API keys (or reads from .env)
    → Uploads code, builds, starts, validates
    → Done.

TEST PRODUCTION LOCALLY:
  ./scripts/deploy.sh local
    → Starts production Docker setup locally
    → Good for testing before VPS deploy

VALIDATE:
  ./scripts/deploy.sh validate
    → Checks health, containers, memory
    → Run on VPS or locally

CONFIG (3 ways to provide):
  1. Create .env file (recommended for dev)
  2. Export env vars (export OPENROUTER_API_KEY=...)
  3. Let script prompt you (it will ask for missing vars)

  Required: OPENROUTER_API_KEY, DISCORD_TOKEN, DISCORD_CLIENT_ID
  Optional: TWILIO_*, OPENAI_API_KEY, WOLFRAM_APP_ID

VPS SETUP (run once on fresh VPS as root):
  curl https://raw.../scripts/vps-setup.sh | bash
  → Installs Docker, creates user, configures firewall
  → Then run './scripts/deploy.sh remote' from local machine

EOF
}

# Main script logic
case "${1:-}" in
    "local")
        check_environment
        deploy_local
        ;;
    "remote")
        if [[ -z "$DEPLOY_HOST" ]]; then
            print_error "DEPLOY_HOST environment variable must be set for remote deployment"
            exit 1
        fi
        check_environment
        deploy_remote
        ;;
    "check")
        check_environment
        ;;
    "validate")
        validate_deployment
        ;;
    *)
        usage
        exit 1
        ;;
esac