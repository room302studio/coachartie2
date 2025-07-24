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
DEPLOY_HOST=${DEPLOY_HOST:-"your-vps-ip"}
DEPLOY_PATH=${DEPLOY_PATH:-"/home/coachartie/coachartie2"}
COMPOSE_FILE=${COMPOSE_FILE:-"docker-compose.prod.yml"}
BACKUP_PATH=${BACKUP_PATH:-"/home/coachartie/backups"}

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
    
    required_vars=(
        "OPENROUTER_API_KEY"
        "DISCORD_TOKEN" 
        "DISCORD_CLIENT_ID"
        "WOLFRAM_APP_ID"
        "TWILIO_ACCOUNT_SID"
        "TWILIO_AUTH_TOKEN"
        "TWILIO_PHONE_NUMBER"
    )
    
    for var in "${required_vars[@]}"; do
        if [[ -z "${!var}" ]]; then
            print_warning "Environment variable $var is not set"
        else
            print_status "✓ $var is configured"
        fi
    done
}

# Deploy to local environment
deploy_local() {
    print_status "Deploying to local environment..."
    
    # Stop existing services
    print_status "Stopping existing services..."
    docker-compose -f $COMPOSE_FILE down || true
    
    # Build and start services
    print_status "Building and starting services..."
    docker-compose -f $COMPOSE_FILE up --build -d
    
    # Wait for services to be healthy
    print_status "Waiting for services to be healthy..."
    timeout 120 bash -c 'until docker-compose -f docker-compose.prod.yml ps | grep -q "healthy"; do sleep 5; done'
    
    # Test the deployment
    print_status "Testing deployment..."
    curl -f http://localhost:18239/health || {
        print_error "Health check failed!"
        docker-compose -f $COMPOSE_FILE logs
        exit 1
    }
    
    print_status "✅ Local deployment successful!"
}

# Deploy to remote VPS
deploy_remote() {
    print_status "Deploying to remote VPS: $DEPLOY_USER@$DEPLOY_HOST"
    
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
        ./ $DEPLOY_USER@$DEPLOY_HOST:$DEPLOY_PATH/
    
    # Upload .env file separately
    scp .env.prod $DEPLOY_USER@$DEPLOY_HOST:$DEPLOY_PATH/.env
    
    # Execute deployment on VPS
    ssh $DEPLOY_USER@$DEPLOY_HOST << EOF
        cd $DEPLOY_PATH
        
        # Create backup
        mkdir -p $BACKUP_PATH
        if [ -d "packages/capabilities/data" ]; then
            tar -czf $BACKUP_PATH/data-backup-\$(date +%Y%m%d-%H%M%S).tar.gz packages/capabilities/data/
        fi
        
        # Stop existing services
        docker-compose -f $COMPOSE_FILE down || true
        
        # Build and start services
        docker-compose -f $COMPOSE_FILE up --build -d
        
        # Wait for services
        timeout 120 bash -c 'until docker-compose -f $COMPOSE_FILE ps | grep -q "healthy"; do sleep 5; done'
        
        # Test deployment
        curl -f http://localhost:18239/health || exit 1
        
        echo "✅ Remote deployment successful!"
EOF
    
    print_status "✅ Remote deployment completed!"
}

# Create production environment file
create_env_file() {
    print_status "Creating production environment file..."
    cat > .env.prod << EOF
# Production Environment Variables for Coach Artie 2
NODE_ENV=production
LOG_LEVEL=info

# API Keys (set these before deployment)
OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-""}
DISCORD_TOKEN=${DISCORD_TOKEN:-""}
DISCORD_CLIENT_ID=${DISCORD_CLIENT_ID:-""}
WOLFRAM_APP_ID=${WOLFRAM_APP_ID:-""}
TWILIO_ACCOUNT_SID=${TWILIO_ACCOUNT_SID:-""}
TWILIO_AUTH_TOKEN=${TWILIO_AUTH_TOKEN:-""}
TWILIO_PHONE_NUMBER=${TWILIO_PHONE_NUMBER:-""}

# Database
DATABASE_PATH=/app/data/coachartie.db

# Service Configuration
CAPABILITIES_PORT=18239
REDIS_HOST=redis
REDIS_PORT=6379
EOF
    print_status "✓ Production environment file created"
}

# Show usage
usage() {
    echo "Usage: $0 [local|remote|check]"
    echo ""
    echo "Commands:"
    echo "  local   - Deploy to local Docker environment"
    echo "  remote  - Deploy to remote VPS"
    echo "  check   - Check environment variables"
    echo ""
    echo "Environment Variables:"
    echo "  DEPLOY_USER     - SSH user for VPS deployment (default: coachartie)"
    echo "  DEPLOY_HOST     - VPS hostname or IP"
    echo "  DEPLOY_PATH     - Deployment path on VPS (default: /home/coachartie/coachartie2)"
    echo ""
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
    *)
        usage
        exit 1
        ;;
esac