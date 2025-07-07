#!/bin/bash

# =============================================================================
# Coach Artie 2 - Networking Doctor
# =============================================================================
# Comprehensive network debugging script for macOS phantom server issues
# Usage: ./scripts/networking_doctor.sh [--port PORT] [--host HOST]
# =============================================================================

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
DEFAULT_PORT=18239
DEFAULT_HOST="127.0.0.1"
TEST_PORT=${1:-$DEFAULT_PORT}
TEST_HOST=${2:-$DEFAULT_HOST}

echo -e "${BLUE}🔍 Coach Artie 2 - Network Diagnostics${NC}"
echo -e "${BLUE}Testing port: $TEST_PORT, host: $TEST_HOST${NC}"
echo "=============================================="

# =============================================================================
# 1. BASIC SYSTEM INFO
# =============================================================================
echo -e "\n${YELLOW}📋 1. BASIC SYSTEM INFO${NC}"
echo "macOS Version: $(sw_vers -productVersion)"
echo "Architecture: $(uname -m)"
echo "Kernel: $(uname -r)"
echo "Node.js: $(node --version 2>/dev/null || echo 'NOT FOUND')"
echo "Python: $(python3 --version 2>/dev/null || echo 'NOT FOUND')"

# =============================================================================
# 2. FIREWALL STATUS
# =============================================================================
echo -e "\n${YELLOW}🔥 2. FIREWALL STATUS${NC}"
if system_profiler SPFirewallDataType 2>/dev/null | grep -q "Mode:"; then
    echo -e "${GREEN}✅ Firewall accessible${NC}"
    system_profiler SPFirewallDataType | grep -A 5 "Mode:" | head -10
else
    echo -e "${RED}❌ Cannot access firewall settings${NC}"
fi

# =============================================================================
# 3. NETWORK SECURITY SOFTWARE
# =============================================================================
echo -e "\n${YELLOW}🛡️ 3. NETWORK SECURITY SOFTWARE${NC}"

# Check for Little Snitch
if ps aux | grep -E "(Little Snitch|lsd)" | grep -v grep >/dev/null; then
    echo -e "${YELLOW}⚠️  Little Snitch or similar network monitoring detected${NC}"
    ps aux | grep -E "(Little Snitch|lsd)" | grep -v grep | head -3
else
    echo -e "${GREEN}✅ No Little Snitch detected${NC}"
fi

# Check for other network security tools
NETWORK_TOOLS=("BlockBlock" "LuLu" "Hands Off" "Radio Silence")
for tool in "${NETWORK_TOOLS[@]}"; do
    if ps aux | grep -i "$tool" | grep -v grep >/dev/null; then
        echo -e "${YELLOW}⚠️  $tool detected${NC}"
    fi
done

# Check for antivirus
AV_TOOLS=("ClamAV" "Avast" "Sophos" "Bitdefender" "Malwarebytes" "ESET")
for av in "${AV_TOOLS[@]}"; do
    if ps aux | grep -i "$av" | grep -v grep >/dev/null; then
        echo -e "${YELLOW}⚠️  Antivirus detected: $av${NC}"
    fi
done

# Check for VPN
if ps aux | grep -i vpn | grep -v grep >/dev/null; then
    echo -e "${YELLOW}⚠️  VPN software detected${NC}"
    ps aux | grep -i vpn | grep -v grep | head -3
else
    echo -e "${GREEN}✅ No VPN software detected${NC}"
fi

# =============================================================================
# 4. SYSTEM SECURITY SETTINGS
# =============================================================================
echo -e "\n${YELLOW}🔒 4. SYSTEM SECURITY SETTINGS${NC}"

# System Integrity Protection
SIP_STATUS=$(csrutil status 2>/dev/null || echo "unknown")
echo "SIP Status: $SIP_STATUS"

# Gatekeeper
GATEKEEPER_STATUS=$(spctl --status 2>/dev/null || echo "unknown")
echo "Gatekeeper: $GATEKEEPER_STATUS"

# Node.js binary attributes
NODE_PATH=$(which node 2>/dev/null || echo "not found")
if [[ "$NODE_PATH" != "not found" ]]; then
    echo "Node.js Path: $NODE_PATH"
    echo "Node.js Attributes:"
    xattr -l "$NODE_PATH" 2>/dev/null || echo "  No extended attributes"
fi

# =============================================================================
# 5. NETWORK INTERFACE CONFIGURATION
# =============================================================================
echo -e "\n${YELLOW}🌐 5. NETWORK INTERFACE CONFIGURATION${NC}"

# Loopback interface
echo "Loopback Interface:"
ifconfig lo0 | head -5

# Network interface status
echo -e "\nNetwork Interface Status:"
scutil --nwi | head -10

# =============================================================================
# 6. LOCALHOST RESOLUTION
# =============================================================================
echo -e "\n${YELLOW}🏠 6. LOCALHOST RESOLUTION${NC}"

# Check /etc/hosts
echo "Hosts File Configuration:"
grep -E "localhost|127.0.0.1|::1" /etc/hosts || echo "No localhost entries found"

# Check DNS resolution
echo -e "\nDNS Resolution for localhost:"
dscacheutil -q host -a name localhost

# =============================================================================
# 7. PORT AVAILABILITY
# =============================================================================
echo -e "\n${YELLOW}🚪 7. PORT AVAILABILITY${NC}"

# Check if port is in use
echo "Checking port $TEST_PORT availability..."
if lsof -Pi :$TEST_PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo -e "${RED}❌ Port $TEST_PORT is already in use:${NC}"
    lsof -Pi :$TEST_PORT -sTCP:LISTEN
else
    echo -e "${GREEN}✅ Port $TEST_PORT is available${NC}"
fi

# Check for TIME_WAIT connections
TIME_WAIT_COUNT=$(netstat -an | grep "$TEST_PORT" | grep TIME_WAIT | wc -l)
if [[ $TIME_WAIT_COUNT -gt 0 ]]; then
    echo -e "${YELLOW}⚠️  $TIME_WAIT_COUNT TIME_WAIT connections on port $TEST_PORT${NC}"
fi

# =============================================================================
# 8. SOCKET BINDING TESTS
# =============================================================================
echo -e "\n${YELLOW}🔌 8. SOCKET BINDING TESTS${NC}"

# Python socket test
echo "Testing Python socket binding..."
python3 -c "
import socket
import sys
try:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(('$TEST_HOST', $TEST_PORT))
    print('✅ Python successfully bound to $TEST_HOST:$TEST_PORT')
    sock.close()
except Exception as e:
    print(f'❌ Python binding failed: {e}')
    sys.exit(1)
"

# Node.js socket test
echo "Testing Node.js socket binding..."
node -e "
const net = require('net');
const server = net.createServer();
server.listen($TEST_PORT, '$TEST_HOST', () => {
  console.log('✅ Node.js server listening on $TEST_HOST:$TEST_PORT');
  server.close();
});
server.on('error', (err) => {
  console.log('❌ Node.js server error:', err.message);
  process.exit(1);
});
"

# =============================================================================
# 9. PROCESS ANALYSIS
# =============================================================================
echo -e "\n${YELLOW}⚙️ 9. PROCESS ANALYSIS${NC}"

# Check for zombie processes
echo "Checking for zombie tsx/node processes..."
ZOMBIE_COUNT=$(ps aux | grep -E "(tsx|node)" | grep -v grep | wc -l)
if [[ $ZOMBIE_COUNT -gt 0 ]]; then
    echo -e "${YELLOW}⚠️  Found $ZOMBIE_COUNT tsx/node processes:${NC}"
    ps aux | grep -E "(tsx|node)" | grep -v grep | head -5
else
    echo -e "${GREEN}✅ No zombie processes detected${NC}"
fi

# =============================================================================
# 10. SYSTEM LOGS
# =============================================================================
echo -e "\n${YELLOW}📋 10. SYSTEM LOGS (Last 5 minutes)${NC}"

# Check for security-related log entries
echo "Checking for security denials..."
LOG_ENTRIES=$(log show --predicate 'process == "node" OR process == "tsx"' --style syslog --last 5m 2>/dev/null | grep -i -E "(deny|block|restrict|firewall|security)" | wc -l)
if [[ $LOG_ENTRIES -gt 0 ]]; then
    echo -e "${RED}❌ Found $LOG_ENTRIES security-related log entries${NC}"
    log show --predicate 'process == "node" OR process == "tsx"' --style syslog --last 5m 2>/dev/null | grep -i -E "(deny|block|restrict|firewall|security)" | head -3
else
    echo -e "${GREEN}✅ No security denials in recent logs${NC}"
fi

# =============================================================================
# 11. RECOMMENDATIONS
# =============================================================================
echo -e "\n${YELLOW}💡 11. RECOMMENDATIONS${NC}"

# IPv6/IPv4 localhost check
if grep -q "::1.*localhost" /etc/hosts; then
    echo -e "${RED}❌ IPv6 localhost entry found in /etc/hosts${NC}"
    echo -e "${YELLOW}   Recommendation: Comment out '::1 localhost' line${NC}"
    echo -e "${YELLOW}   Command: sudo sed -i '' 's/::1.*localhost/# &/' /etc/hosts${NC}"
fi

# Check for common issues
if [[ $TIME_WAIT_COUNT -gt 10 ]]; then
    echo -e "${YELLOW}⚠️  Many TIME_WAIT connections detected${NC}"
    echo -e "${YELLOW}   Recommendation: Wait for connections to clear or restart network${NC}"
fi

if [[ $ZOMBIE_COUNT -gt 3 ]]; then
    echo -e "${YELLOW}⚠️  Many node/tsx processes detected${NC}"
    echo -e "${YELLOW}   Recommendation: Kill zombie processes with 'pnpm run dev:clean'${NC}"
fi

# =============================================================================
# 12. SUMMARY
# =============================================================================
echo -e "\n${BLUE}📊 DIAGNOSTIC SUMMARY${NC}"
echo "=============================================="
echo "Date: $(date)"
echo "Test Port: $TEST_PORT"
echo "Test Host: $TEST_HOST"
echo "Port Available: $(lsof -Pi :$TEST_PORT -sTCP:LISTEN -t >/dev/null 2>&1 && echo 'NO' || echo 'YES')"
echo "Socket Binding: $(python3 -c 'import socket; s=socket.socket(); s.bind(("'$TEST_HOST'", '$TEST_PORT')); print("SUCCESS")' 2>/dev/null || echo 'FAILED')"
echo "System Ready: $(python3 -c 'import socket; s=socket.socket(); s.bind(("'$TEST_HOST'", '$TEST_PORT')); print("YES")' 2>/dev/null || echo 'NO')"

echo -e "\n${GREEN}✅ Diagnostic complete!${NC}"