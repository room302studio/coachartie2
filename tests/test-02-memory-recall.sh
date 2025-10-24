#!/bin/bash
# TEST 2: Memory Storage and Recall
# Tests: remember capability, then recall capability

echo "=== TEST 2: Memory Storage and Recall ==="
echo ""

TEST_USER="test-user-002"
MEMORY_CONTENT="I love pizza and tacos"
UNIQUE_MARKER="test-memory-$(date +%s)"

# STEP 1: Store memory
echo "📝 STEP 1: Storing memory"
echo "   Message: 'Remember that $MEMORY_CONTENT (marker: $UNIQUE_MARKER)'"
echo ""

START_TIME=$(date +%s%N)

RESPONSE=$(curl -s -X POST http://localhost:47324/chat \
  -H "Content-Type: application/json" \
  -d "{
    \"message\": \"Remember that $MEMORY_CONTENT (marker: $UNIQUE_MARKER)\",
    \"userId\": \"$TEST_USER\",
    \"source\": \"test-suite\"
  }")

JOB_ID=$(echo "$RESPONSE" | grep -o '"messageId":"[^"]*"' | cut -d'"' -f4)

if [ -z "$JOB_ID" ]; then
  echo "❌ STEP 1 FAILED: Could not get message ID"
  exit 1
fi

# Poll for completion
MAX_ATTEMPTS=30
ATTEMPT=0

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  sleep 1
  ATTEMPT=$((ATTEMPT + 1))

  RESULT=$(curl -s http://localhost:47324/chat/$JOB_ID)
  STATUS=$(echo "$RESULT" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)

  if [ "$STATUS" = "completed" ]; then
    echo "✅ STEP 1: Memory stored"
    break
  elif [ "$STATUS" = "failed" ]; then
    echo "❌ STEP 1 FAILED: Job failed"
    exit 1
  fi

  echo -n "."
done

if [ $ATTEMPT -ge $MAX_ATTEMPTS ]; then
  echo ""
  echo "❌ STEP 1 FAILED: Timeout"
  exit 1
fi

echo ""
sleep 2

# STEP 2: Recall memory
echo "📝 STEP 2: Recalling memory"
echo "   Message: 'What do I love to eat? (marker: $UNIQUE_MARKER)'"
echo ""

RESPONSE=$(curl -s -X POST http://localhost:47324/chat \
  -H "Content-Type: application/json" \
  -d "{
    \"message\": \"What do I love to eat? (marker: $UNIQUE_MARKER)\",
    \"userId\": \"$TEST_USER\",
    \"source\": \"test-suite\"
  }")

JOB_ID=$(echo "$RESPONSE" | grep -o '"messageId":"[^"]*"' | cut -d'"' -f4)

if [ -z "$JOB_ID" ]; then
  echo "❌ STEP 2 FAILED: Could not get message ID"
  exit 1
fi

# Poll for completion
ATTEMPT=0

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  sleep 1
  ATTEMPT=$((ATTEMPT + 1))

  RESULT=$(curl -s http://localhost:47324/chat/$JOB_ID)
  STATUS=$(echo "$RESULT" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)

  if [ "$STATUS" = "completed" ]; then
    END_TIME=$(date +%s%N)
    TOTAL_DURATION=$(( (END_TIME - START_TIME) / 1000000 ))

    RESPONSE_TEXT=$(echo "$RESULT" | grep -o '"response":"[^"]*"' | cut -d'"' -f4)

    echo ""
    echo "✅ STEP 2: Recall completed"
    echo ""
    echo "📊 Response: $RESPONSE_TEXT"
    echo ""

    # Check if response contains pizza AND tacos
    if echo "$RESPONSE_TEXT" | grep -qi "pizza" && echo "$RESPONSE_TEXT" | grep -qi "taco"; then
      echo "✅ TEST PASSED: Memory recalled correctly (found 'pizza' and 'taco')"
      echo ""
      echo "Performance:"
      echo "  Total time (store + recall): ${TOTAL_DURATION}ms"
      echo "  Target: < 10000ms"
      if [ $TOTAL_DURATION -lt 10000 ]; then
        echo "  Result: ⭐ EXCELLENT"
      elif [ $TOTAL_DURATION -lt 20000 ]; then
        echo "  Result: ✅ GOOD"
      else
        echo "  Result: ⚠️ SLOW"
      fi
      exit 0
    else
      echo "❌ TEST FAILED: Memory not recalled"
      echo "Expected: Both 'pizza' and 'taco'"
      echo "Got: $RESPONSE_TEXT"
      exit 1
    fi
  elif [ "$STATUS" = "failed" ]; then
    echo "❌ STEP 2 FAILED: Job failed"
    exit 1
  fi

  echo -n "."
done

echo ""
echo "❌ STEP 2 FAILED: Timeout"
exit 1
