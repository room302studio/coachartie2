#!/bin/bash
# TEST 1: Simple Calculator
# Tests basic capability selection and execution

echo "=== TEST 1: Simple Calculator ==="
echo ""
echo "📝 Sending: 'Calculate 123 * 456'"
echo ""

START_TIME=$(date +%s%N)

# Send message and capture job ID
RESPONSE=$(curl -s -X POST http://localhost:47324/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Calculate 123 * 456",
    "userId": "test-user-001",
    "source": "test-suite"
  }')

JOB_ID=$(echo "$RESPONSE" | grep -o '"messageId":"[^"]*"' | cut -d'"' -f4)

if [ -z "$JOB_ID" ]; then
  echo "❌ FAILED: Could not get message ID"
  echo "Response: $RESPONSE"
  exit 1
fi

echo "✅ Message created: $JOB_ID"
echo ""

# Poll for result (max 30 seconds)
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

    echo "✅ Job completed in ${DURATION}ms"
    echo ""

    # Extract response
    RESPONSE_TEXT=$(echo "$RESULT" | grep -o '"response":"[^"]*"' | cut -d'"' -f4)

    echo "📊 Response: $RESPONSE_TEXT"
    echo ""

    # Check if response contains the answer
    if echo "$RESPONSE_TEXT" | grep -q "56088\|56,088"; then
      echo "✅ TEST PASSED: Correct answer (56088)"
      echo ""
      echo "Performance:"
      echo "  Time: ${DURATION}ms"
      echo "  Target: < 2000ms"
      if [ $DURATION -lt 2000 ]; then
        echo "  Result: ⭐ EXCELLENT"
      elif [ $DURATION -lt 5000 ]; then
        echo "  Result: ✅ GOOD"
      else
        echo "  Result: ⚠️ SLOW"
      fi
      exit 0
    else
      echo "❌ TEST FAILED: Wrong answer or no answer found"
      echo "Expected: 56088"
      echo "Got: $RESPONSE_TEXT"
      exit 1
    fi
  elif [ "$STATUS" = "failed" ]; then
    echo "❌ Job failed"
    echo "$RESULT"
    exit 1
  fi

  echo -n "."
done

echo ""
echo "❌ TEST FAILED: Timeout after ${MAX_ATTEMPTS}s"
exit 1
