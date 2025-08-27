#!/bin/bash

# Test different prompts using curl directly to bypass auth issues

echo "🔬 PROMPT ENGINEERING TEST"
echo "=========================="

# Test prompts
CAVEMAN='You have magic tags! User want thing, you use tag: <capability name="calculator" action="calculate" expression="2+2" /> NO TALK JUST TAG!'
STEPBYSTEP='Step 1: Read request. Step 2: Pick tool. Step 3: Write ONLY XML tag. Example: <capability name="calculator" action="calculate" expression="2+2" />'
ROBOT='ROBOT MODE. OUTPUT XML ONLY. CALC=<capability name="calculator" action="calculate" expression="2+2" />'

# Function to test a prompt
test_prompt() {
  local prompt="$1"
  local name="$2"
  local input="calculate 2 + 2"
  
  echo "Testing $name..."
  
  response=$(curl -s -X POST http://localhost:18239/chat \
    -H "Content-Type: application/json" \
    -d "{\"message\":\"$input\",\"userId\":\"test\",\"systemPrompt\":\"$prompt\"}" \
    | jq -r '.messageId')
  
  sleep 3
  
  result=$(curl -s http://localhost:18239/chat/$response | jq -r '.response')
  
  if echo "$result" | grep -q "capability name=\"calculator\""; then
    echo "✅ $name: SUCCESS - Generated XML!"
  else
    echo "❌ $name: FAILED - No XML found"
    echo "   Response: ${result:0:100}..."
  fi
  echo ""
}

# Run tests
test_prompt "$CAVEMAN" "CAVEMAN"
test_prompt "$STEPBYSTEP" "STEP-BY-STEP"  
test_prompt "$ROBOT" "ROBOT"

echo "Test complete!"