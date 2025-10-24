#!/bin/bash
# TEST 3: Multi-Capability Chain
# Tests: Multiple capabilities in single request (calculate + remember)

echo "=== TEST 3: Multi-Capability Chain ==="
echo ""
echo "📝 Request: 'Calculate 15% of $100 and remember the result as my tip budget'"
echo ""

TEST_USER="test-user-003"

START_TIME=$(date +%s%N)

RESPONSE=$(curl -s -X POST http://localhost:47324/chat \
  -H "Content-Type: application/json" \
  -d "{
    \"message\": \"Calculate 15% of \$100 and remember the result as my tip budget\",
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
MAX_ATTEMPTS=40
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

    # Check if response mentions both calculation (15 or $15) and memory
    FOUND_CALC=false
    FOUND_MEMORY=false

    if echo "$RESPONSE_TEXT" | grep -qiE "15|\\\$15|fifteen"; then
      FOUND_CALC=true
      echo "✅ Calculation found: 15% of \$100 = \$15"
    fi

    if echo "$RESPONSE_TEXT" | grep -qiE "remember|stored|saved|tip budget"; then
      FOUND_MEMORY=true
      echo "✅ Memory indication found"
    fi

    echo ""

    if [ "$FOUND_CALC" = true ] && [ "$FOUND_MEMORY" = true ]; then
      echo "✅ TEST PASSED: Multi-capability chain successful"
      echo ""
      echo "Performance:"
      echo "  Time: ${DURATION}ms"
      echo "  Target: < 15000ms"
      if [ $DURATION -lt 15000 ]; then
        echo "  Result: ⭐ EXCELLENT"
      elif [ $DURATION -lt 25000 ]; then
        echo "  Result: ✅ GOOD"
      else
        echo "  Result: ⚠️ SLOW"
      fi

      # Bonus: Verify memory was actually stored
      sleep 2
      echo ""
      echo "🔍 BONUS: Verifying memory persistence..."

      VERIFY_RESPONSE=$(curl -s -X POST http://localhost:47324/chat \
        -H "Content-Type: application/json" \
        -d "{
          \"message\": \"What is my tip budget?\",
          \"userId\": \"$TEST_USER\",
          \"source\": \"test-suite\"
        }")

      VERIFY_JOB=$(echo "$VERIFY_RESPONSE" | grep -o '"messageId":"[^"]*"' | cut -d'"' -f4)

      # Poll verification
      VERIFY_ATTEMPT=0
      while [ $VERIFY_ATTEMPT -lt 30 ]; do
        sleep 1
        VERIFY_ATTEMPT=$((VERIFY_ATTEMPT + 1))

        VERIFY_RESULT=$(curl -s http://localhost:47324/chat/$VERIFY_JOB)
        VERIFY_STATUS=$(echo "$VERIFY_RESULT" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)

        if [ "$VERIFY_STATUS" = "completed" ]; then
          VERIFY_TEXT=$(echo "$VERIFY_RESULT" | grep -o '"response":"[^"]*"' | cut -d'"' -f4)

          if echo "$VERIFY_TEXT" | grep -qiE "15|\\\$15|fifteen"; then
            echo "✅ BONUS PASS: Memory verified - tip budget recalled"
            echo "   Response: $VERIFY_TEXT"
          else
            echo "⚠️ BONUS WARNING: Memory not recalled"
            echo "   Response: $VERIFY_TEXT"
          fi
          break
        fi
        echo -n "."
      done

      exit 0
    else
      echo "❌ TEST FAILED:"
      if [ "$FOUND_CALC" = false ]; then
        echo "   Missing calculation result (expected \$15)"
      fi
      if [ "$FOUND_MEMORY" = false ]; then
        echo "   Missing memory indication"
      fi
      exit 1
    fi
  elif [ "$STATUS" = "failed" ]; then
    echo "❌ Job failed"
    exit 1
  fi

  echo -n "."
done

echo ""
echo "❌ TEST FAILED: Timeout after ${MAX_ATTEMPTS}s"
exit 1
