#!/bin/bash
# Artie Health Check Script
# Quick way to verify all services are running properly

echo "🤖 === ARTIE HEALTH CHECK ==="
echo

# Check if services are listening on expected ports
echo "📊 Service Ports:"
services_up=0
for port in 47319 47320 47321 47324 47325 47326; do
  if lsof -i :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
    service_name=$(lsof -i :$port -sTCP:LISTEN | tail -1 | awk '{print $1}')
    echo "  ✅ Port $port: $service_name"
    ((services_up++))
  else
    echo "  ❌ Port $port: NOT LISTENING"
  fi
done
echo "  Total: $services_up/6 services up"
echo

# Check Discord Health
echo "🎮 Discord Service:"
discord_health=$(curl -s http://localhost:47319/health 2>/dev/null)
if [ $? -eq 0 ]; then
  echo "$discord_health" | jq -r '"  Status: \(.status)\n  Connected: \(.discord.connected)\n  Guilds: \(.discord.guilds)\n  Uptime: \(.uptime | floor)s"'
else
  echo "  ❌ Discord health endpoint not responding"
fi
echo

# Check Capabilities Health
echo "🧠 Capabilities Service:"
cap_health=$(curl -s http://localhost:47324/health 2>/dev/null)
if [ $? -eq 0 ]; then
  echo "$cap_health" | jq -r '"  Status: \(.status)"'
else
  echo "  ❌ Capabilities health endpoint not responding"
fi
echo

# Check Redis
echo "🔴 Redis:"
if redis-cli -p 47320 ping >/dev/null 2>&1; then
  connections=$(redis-cli -p 47320 info stats 2>/dev/null | grep total_connections_received | cut -d: -f2 | tr -d '\r')
  echo "  ✅ Redis responding"
  echo "  Connections: $connections"
else
  echo "  ❌ Redis not responding on port 47320"
fi
echo

# Check for recent errors (excluding known noise)
echo "🚨 Recent Errors:"
if [ -f packages/discord/logs/coachartie-error.log ]; then
  error_count=$(tail -50 packages/discord/logs/coachartie-error.log 2>/dev/null | grep -v "ECONNREFUSED" | wc -l | xargs)
  if [ "$error_count" -eq "0" ]; then
    echo "  ✅ No recent errors"
  else
    echo "  ⚠️  $error_count errors in last 50 log lines"
    echo "  Run: tail packages/discord/logs/coachartie-error.log"
  fi
else
  echo "  ℹ️  No error log found"
fi
echo

# Live functionality test
echo "🧪 Live Test (optional):"
echo "  Run this to test message processing:"
echo "  curl -X POST http://localhost:47324/chat -H 'Content-Type: application/json' -d '{\"message\":\"ping\",\"userId\":\"test\",\"username\":\"HealthCheck\",\"source\":\"api\"}'"
echo

# Summary
if [ $services_up -eq 6 ]; then
  echo "✅ All services operational!"
  exit 0
else
  echo "⚠️  Some services down - run 'npm run dev' to start"
  exit 1
fi
