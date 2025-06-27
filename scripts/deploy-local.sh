#!/bin/bash

# Deploy script for local development with Docker Compose
# Handles environment variable setup rigorously

set -e  # Exit on any error

echo "🚀 Starting local deployment..."

# Step 1: Verify environment file exists
if [ ! -f ".env.local" ]; then
    echo "❌ .env.local file not found! Please create it with your API keys."
    exit 1
fi

echo "✅ Found .env.local file"

# Step 2: Copy environment variables to docker directory (CRITICAL!)
echo "📋 Copying environment variables to docker directory..."
cp .env.local docker/.env
echo "✅ Copied .env.local to docker/.env"

# Step 3: Add required Docker-specific environment variables
echo "🔧 Adding Docker-specific environment variables..."
cat >> docker/.env << 'EOF'

# Docker-specific settings
NODE_ENV=development
REDIS_HOST=redis
REDIS_PORT=6379

# Service Ports
CAPABILITIES_PORT=47101
SMS_PORT=47102
EMAIL_PORT=47103

# Minimal required values for Docker
DATABASE_URL=postgresql://test:test@localhost:5432/test
SUPABASE_URL=https://test.supabase.co
SUPABASE_SERVICE_ROLE_KEY=test_key
OPENAI_API_KEY=sk-test_key
WOLFRAM_APP_ID=test_wolfram_id

# Optional services (empty for testing)
TWILIO_ACCOUNT_SID=
EMAIL_HOST=

LOG_LEVEL=info
EOF

echo "✅ Added Docker-specific environment variables"

# Step 4: Stop any existing services
echo "🛑 Stopping existing services..."
docker-compose -f docker/docker-compose.yml down

# Step 5: Build and start services
echo "🏗️ Building and starting services..."
docker-compose -f docker/docker-compose.yml up -d --build

# Step 6: Wait for services to start
echo "⏳ Waiting for services to start..."
sleep 10

# Step 7: Check service status
echo "🔍 Checking service status..."
docker-compose -f docker/docker-compose.yml ps

# Step 8: Test health endpoints
echo "🏥 Testing health endpoints..."
echo "Testing capabilities service..."
curl -s http://localhost:47101/health | jq . || echo "❌ Capabilities service not responding"

echo ""
echo "🎉 Deployment complete!"
echo ""
echo "📊 Service URLs:"
echo "- Capabilities: http://localhost:47101/health"
echo "- Redis: localhost:6379" 
echo "- Monitoring: http://localhost:47104 (if enabled)"
echo ""
echo "📝 To view logs:"
echo "  docker-compose -f docker/docker-compose.yml logs -f"
echo ""
echo "🔄 To restart Discord service:"
echo "  docker-compose -f docker/docker-compose.yml restart discord"