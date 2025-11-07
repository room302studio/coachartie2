#!/bin/bash
# Curl-based event queries (if HTTP API is available)
# Usage: ./curl-events.sh [endpoint] [params]
#
# Examples:
#   ./curl-events.sh recent
#   ./curl-events.sh types
#   ./curl-events.sh custom "type=click&limit=50"

set -euo pipefail

# Configuration - update with actual API endpoint
API_BASE="${EVENT_API_URL:-http://localhost:3000}"
API_TOKEN="${EVENT_API_TOKEN:-}"

# Add auth header if token is set
AUTH_HEADER=""
if [ -n "$API_TOKEN" ]; then
    AUTH_HEADER="-H \"Authorization: Bearer $API_TOKEN\""
fi

case "${1:-recent}" in
    "recent")
        curl -s $AUTH_HEADER "$API_BASE/events/recent" | jq '.'
        ;;
    "types")
        curl -s $AUTH_HEADER "$API_BASE/events/types" | jq '.'
        ;;
    "summary")
        curl -s $AUTH_HEADER "$API_BASE/events/summary" | jq '.'
        ;;
    "all")
        LIMIT="${2:-100}"
        curl -s $AUTH_HEADER "$API_BASE/events?limit=$LIMIT" | jq '.'
        ;;
    "custom")
        PARAMS="${2:-}"
        curl -s $AUTH_HEADER "$API_BASE/events?$PARAMS" | jq '.'
        ;;
    *)
        echo "❌ Unknown endpoint: $1"
        echo ""
        echo "Available endpoints:"
        echo "  recent  - Events from last hour"
        echo "  types   - Event types summary"
        echo "  summary - Daily event counts"
        echo "  all     - All events (default limit: 100)"
        echo "  custom  - Custom query params"
        exit 1
        ;;
esac
