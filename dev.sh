#!/bin/bash
# Quick development mode with hot reload
# Usage: ./dev.sh [service]
# Example: ./dev.sh capabilities

set -e
cd "$(dirname "$0")"

SERVICE="${1:-capabilities}"

echo "🔥 Starting $SERVICE in dev mode with hot reload..."
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d "$SERVICE"

echo "📜 Following logs (Ctrl+C to stop watching, container keeps running)..."
docker compose logs -f "$SERVICE"
