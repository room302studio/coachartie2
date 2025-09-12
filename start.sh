#!/bin/bash

# Coach Artie - Development Environment Startup Script
# This script starts all Coach Artie services using Docker Compose

set -e  # Exit on any error

echo "🚀 Starting Coach Artie Development Environment..."

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo "⚠️  Warning: .env file not found"
    echo "📝 Please create a .env file with required environment variables:"
    echo "   - DISCORD_TOKEN"
    echo "   - DISCORD_CLIENT_ID" 
    echo "   - OPENROUTER_API_KEY"
    echo "   - WOLFRAM_APP_ID"
    echo "   - TWILIO_ACCOUNT_SID"
    echo "   - TWILIO_AUTH_TOKEN"
    echo "   - TWILIO_PHONE_NUMBER"
    echo ""
    read -p "Continue anyway? (y/N): " -r
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Start services
echo "🐳 Starting Docker services..."
docker-compose up --build -d

echo "📊 Service Status:"
docker-compose ps

echo ""
echo "✅ Coach Artie services started successfully!"
echo ""
echo "🌐 Available endpoints:"
echo "   • Brain UI: http://localhost:24680"
echo "   • Capabilities API: http://localhost:18239"
echo "   • SMS Service: http://localhost:27461"
echo "   • Redis: localhost:6380"
echo ""
echo "📋 Useful commands:"
echo "   • View logs: docker-compose logs -f"
echo "   • Stop services: docker-compose down"
echo "   • Restart service: docker-compose restart <service>"
echo ""
echo "🔍 To monitor logs: docker-compose logs -f"