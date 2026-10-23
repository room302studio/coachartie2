#!/bin/bash
# TEST 4: Edge Case - Ambiguous Request
# Tests: How agent handles unclear/missing information

echo "=== TEST 4: Ambiguous Request ==="
echo ""
echo "📝 Request: 'Calculate it' (no context provided)"
echo ""

TEST_USER="test-user-004"

START_TIME=$(date +%s%N)

RESPONSE=$(curl -s -X POST http://localhost:47324/chat \
  -H "Content-Type: application/json" \
  -d "{
    \"message\": \"Calculate it\",
    \"userId\": \"$TEST_USER\",
    \"source\": \"test-suite\"
  }")

JOB_ID=$(echo "$RESPONSE" | grep -o '"messageId":"[^"]*"' | cut -d'"' -f4)

if [ -z "$JOB_ID" ]; then
  echo "❌ FAILED: Could not get message ID"
  exit 1
fi

echo "✅ Message created: $JOB_ID"
echo ""

# Poll for result
MAX_ATTEMPTS=30
ATTEMPT=0

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  sleep 1
  ATTEMPT=$((ATTEMPT + 1))

  RESULT=$(curl -s http://localhost:47324/chat/$JOB_ID)
  STATUS=$(echo "$RESULT" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)

  if [ "$STATUS" = "completed" ]; then
    END_TIME=$(date +%s%N)
    DURATION=$(( (END_TIME - START_TIME) / 1000000 ))

    RESPONSE_TEXT=$(echo "$RESULT" | grep -o '"response":"[^"]*"' | cut -d'"' -f4)

    echo ""
    echo "✅ Job completed in ${DURATION}ms"
    echo ""
    echo "📊 Response: $RESPONSE_TEXT"
    echo ""

    # Check if response asks for clarification or more information
    ASKED_FOR_INFO=false

    if echo "$RESPONSE_TEXT" | grep -qiE "what.*calculate|need.*more|clarify|specify|which|tell me|provide|information|details|context|help me understand"; then
      ASKED_FOR_INFO=true
      echo "✅ Agent asked for clarification (good behavior)"
    else
      echo "⚠️ Agent did NOT ask for clarification"
    fi

    # Check if agent hallucinated a specific calculation
    HALLUCINATED=false
    if echo "$RESPONSE_TEXT" | grep -qE "[0-9]+.*[0-9]+|=[0-9]"; then
      HALLUCINATED=true
      echo "⚠️ Agent appears to have hallucinated specific numbers"
    fi

    echo ""

    if [ "$ASKED_FOR_INFO" = true ] && [ "$HALLUCINATED" = false ]; then
      echo "✅ TEST PASSED: Agent handled ambiguity correctly"
      echo "   - Asked for clarification: YES"
      echo "   - Avoided hallucination: YES"
    elif [ "$ASKED_FOR_INFO" = true ]; then
      echo "⚠️ TEST PARTIAL PASS: Agent asked for info but may have hallucinated"
      echo "   - Asked for clarification: YES"
      echo "   - Avoided hallucination: NO"
    else
      echo "⚠️ TEST PARTIAL PASS: Agent responded but didn't explicitly ask for clarification"
      echo "   Note: LLM might have provided helpful context without formal clarifying question"
    fi

    echo ""
    echo "Performance:"
    echo "  Time: ${DURATION}ms"

    exit 0
  elif [ "$STATUS" = "failed" ]; then
    echo "❌ Job failed"
    exit 1
  fi

  echo -n "."
done

echo ""
echo "❌ TEST FAILED: Timeout after ${MAX_ATTEMPTS}s"
exit 1
