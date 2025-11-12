#!/bin/bash

# CoachArtie Health Check Script
# Comprehensive verification of all services, ports, and API credentials

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "════════════════════════════════════════════════════════════════════════════"
echo "               COACHARTIE HEALTH CHECK & VERIFICATION                       "
echo "               Server: $(hostname -I | awk '{print $1}')"
echo "               Date: $(date '+%Y-%m-%d %H:%M:%S')"
echo "════════════════════════════════════════════════════════════════════════════"
echo ""

# Load key environment variables (manually to avoid parsing issues)
if [ -f .env.production ]; then
    export OPENROUTER_API_KEY=$(grep '^OPENROUTER_API_KEY=' .env.production | cut -d'=' -f2 | sed 's/#.*//' | tr -d ' ')
    export DISCORD_TOKEN=$(grep '^DISCORD_TOKEN=' .env.production | cut -d'=' -f2 | sed 's/#.*//' | tr -d ' ')
    export GITHUB_TOKEN=$(grep '^GITHUB_TOKEN=' .env.production | cut -d'=' -f2 | sed 's/#.*//' | tr -d ' ')
fi

# Track overall health
HEALTH_STATUS=0

# Helper function for test results
test_result() {
    local name="$1"
    local status="$2"
    local details="$3"

    if [ "$status" = "pass" ]; then
        printf "${GREEN}✓${NC} %-50s ${BLUE}%s${NC}\n" "$name" "$details"
    elif [ "$status" = "warn" ]; then
        printf "${YELLOW}⚠${NC} %-50s ${YELLOW}%s${NC}\n" "$name" "$details"
        HEALTH_STATUS=1
    else
        printf "${RED}✗${NC} %-50s ${RED}%s${NC}\n" "$name" "$details"
        HEALTH_STATUS=2
    fi
}

echo "┌─────────────────────────────────────────────────────────────────────────┐"
echo "│ DOCKER CONTAINERS                                                       │"
echo "└─────────────────────────────────────────────────────────────────────────┘"

# Check each CoachArtie container
for container in redis discord capabilities brain sms sandbox; do
    container_name="coachartie-${container}-prod"

    if docker ps --format '{{.Names}}' | grep -q "^${container_name}$"; then
        status=$(docker inspect --format='{{.State.Health.Status}}' "$container_name" 2>/dev/null || echo "no-healthcheck")

        if [ "$status" = "healthy" ]; then
            test_result "Container: $container" "pass" "healthy"
        elif [ "$status" = "no-healthcheck" ]; then
            test_result "Container: $container" "pass" "running (no healthcheck)"
        else
            test_result "Container: $container" "warn" "$status"
        fi
    else
        test_result "Container: $container" "fail" "not running"
    fi
done

echo ""
echo "┌─────────────────────────────────────────────────────────────────────────┐"
echo "│ SERVICE PORTS & ENDPOINTS                                               │"
echo "└─────────────────────────────────────────────────────────────────────────┘"

# Test Redis
if timeout 2 redis-cli -h localhost -p 47320 ping &>/dev/null; then
    test_result "Redis (47320)" "pass" "PONG"
else
    test_result "Redis (47320)" "fail" "no response"
fi

# Test Discord health endpoint
if curl -sf http://localhost:47319/health &>/dev/null; then
    test_result "Discord Health API (47319)" "pass" "responding"
else
    test_result "Discord Health API (47319)" "fail" "connection refused"
fi

# Test Discord main service
if curl -sf http://localhost:47321/health &>/dev/null; then
    test_result "Discord Service (47321)" "pass" "responding"
else
    # Try to check if container is at least listening
    if netstat -tln 2>/dev/null | grep -q ":47321 "; then
        test_result "Discord Service (47321)" "warn" "port open, no /health endpoint"
    else
        test_result "Discord Service (47321)" "fail" "not listening"
    fi
fi

# Test Capabilities
if curl -sf http://localhost:47324/health &>/dev/null; then
    test_result "Capabilities API (47324)" "pass" "responding"
else
    test_result "Capabilities API (47324)" "fail" "connection refused"
fi

# Test Brain
if curl -sf http://localhost:47325/api/status &>/dev/null; then
    test_result "Brain Dashboard (47325)" "pass" "responding"
else
    test_result "Brain Dashboard (47325)" "fail" "connection refused"
fi

# Test SMS
if curl -sf http://localhost:47326/health &>/dev/null; then
    test_result "SMS Service (47326)" "pass" "responding"
else
    test_result "SMS Service (47326)" "fail" "connection refused"
fi

echo ""
echo "┌─────────────────────────────────────────────────────────────────────────┐"
echo "│ API CREDENTIALS & SERVICES                                              │"
echo "└─────────────────────────────────────────────────────────────────────────┘"

# Check OpenRouter API
if [ -n "$OPENROUTER_API_KEY" ]; then
    response=$(curl -s https://openrouter.ai/api/v1/auth/key \
        -H "Authorization: Bearer $OPENROUTER_API_KEY" 2>/dev/null)

    if echo "$response" | jq -e '.data' &>/dev/null; then
        usage=$(echo "$response" | jq -r '.data.usage')
        is_free=$(echo "$response" | jq -r '.data.is_free_tier')

        if [ "$is_free_tier" = "false" ]; then
            test_result "OpenRouter API" "pass" "credits available (\$$usage spent)"
        else
            test_result "OpenRouter API" "warn" "free tier (usage: \$$usage)"
        fi
    else
        test_result "OpenRouter API" "fail" "invalid response"
    fi
else
    test_result "OpenRouter API Key" "fail" "not configured"
fi

# Check Discord token
if [ -n "$DISCORD_TOKEN" ]; then
    test_result "Discord Bot Token" "pass" "configured"
else
    test_result "Discord Bot Token" "fail" "not configured"
fi

# Check GitHub token
if [ -n "$GITHUB_TOKEN" ]; then
    # Try to verify token
    if curl -sf -H "Authorization: token $GITHUB_TOKEN" https://api.github.com/user &>/dev/null; then
        test_result "GitHub Token" "pass" "valid"
    else
        test_result "GitHub Token" "warn" "configured but may be invalid"
    fi
else
    test_result "GitHub Token" "warn" "not configured"
fi

echo ""
echo "┌─────────────────────────────────────────────────────────────────────────┐"
echo "│ DATABASE & STORAGE                                                      │"
echo "└─────────────────────────────────────────────────────────────────────────┘"

# Check SQLite database
if [ -f "./data/coachartie.db" ]; then
    db_size=$(du -h "./data/coachartie.db" 2>/dev/null | cut -f1)
    test_result "SQLite Database" "pass" "$db_size"

    # Check if database is readable
    if sqlite3 "./data/coachartie.db" "SELECT COUNT(*) FROM sqlite_master;" &>/dev/null; then
        test_result "Database Integrity" "pass" "readable"
    else
        test_result "Database Integrity" "fail" "corrupted"
    fi
else
    test_result "SQLite Database" "warn" "not created yet"
fi

# Check Redis data volume
if docker volume inspect coachartie2_redis-data &>/dev/null; then
    test_result "Redis Data Volume" "pass" "exists"
else
    test_result "Redis Data Volume" "fail" "missing"
fi

echo ""
echo "┌─────────────────────────────────────────────────────────────────────────┐"
echo "│ RESOURCE USAGE                                                          │"
echo "└─────────────────────────────────────────────────────────────────────────┘"

# Docker stats (non-streaming, one-time)
echo ""
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" \
    $(docker ps --filter "name=coachartie" --format "{{.Names}}") 2>/dev/null || \
    echo "Unable to retrieve container stats"

echo ""
echo "════════════════════════════════════════════════════════════════════════════"

if [ $HEALTH_STATUS -eq 0 ]; then
    echo -e "${GREEN}✓ ALL SYSTEMS OPERATIONAL${NC}"
    exit 0
elif [ $HEALTH_STATUS -eq 1 ]; then
    echo -e "${YELLOW}⚠ SOME WARNINGS DETECTED${NC}"
    exit 1
else
    echo -e "${RED}✗ CRITICAL ISSUES DETECTED${NC}"
    exit 2
fi
