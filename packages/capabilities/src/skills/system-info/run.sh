#!/bin/bash
# System Info Skill Script
# Params are passed via SKILL_PARAMS env var as JSON

# Parse action from params
ACTION=$(echo "$SKILL_PARAMS" | grep -o '"action":"[^"]*"' | cut -d'"' -f4)
ACTION=${ACTION:-status}

case "$ACTION" in
  uptime)
    uptime -p
    ;;
  memory)
    free -h | head -2
    ;;
  disk)
    df -h / | tail -1 | awk '{print "Used: "$3" / "$2" ("$5")"}'
    ;;
  status|*)
    echo "**System Status**"
    echo ""
    echo "Uptime: $(uptime -p)"
    echo ""
    echo "Memory:"
    free -h | head -2
    echo ""
    echo "Disk (/):"
    df -h / | tail -1 | awk '{print "Used: "$3" / "$2" ("$5")"}'
    ;;
esac
