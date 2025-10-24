#!/bin/bash

# TEST 9: Reverse Memory Verification (ejfox Personal History)
# Verify that the memory system correctly stores and recalls personal history
# for the actual user (ejfox) and maintains user-scoped isolation

set -e

CAPABILITIES_URL="http://localhost:47324"
EJFOX_USER="ejfox"
OTHER_USER="curious_stranger"

echo "================================"
echo "TEST 9: Reverse Memory Verification"
echo "================================"
echo ""
echo "Testing memory storage and recall for ejfox user"
echo "Expected: Artie remembers Kingston → Beacon → Brooklyn history"
echo ""

# Helper function to send message and poll
send_and_wait() {
  local USER_ID=$1
  local MESSAGE=$2
  local MAX_POLLS=30

  RESPONSE=$(curl -s -X POST "$CAPABILITIES_URL/chat" \
    -H "Content-Type: application/json" \
    -d "{
      \"message\": \"$MESSAGE\",
      \"userId\": \"$USER_ID\",
      \"platform\": \"test\"
    }")

  JOB_ID=$(echo "$RESPONSE" | jq -r '.messageId')

  POLL_COUNT=0
  while [ $POLL_COUNT -lt $MAX_POLLS ]; do
    sleep 2
    POLL_COUNT=$((POLL_COUNT + 1))

    RESULT=$(curl -s "$CAPABILITIES_URL/chat/$JOB_ID")
    STATUS=$(echo "$RESULT" | jq -r '.status')

    if [ "$STATUS" = "completed" ]; then
      echo "$RESULT" | jq -r '.response'
      return 0
    elif [ "$STATUS" = "failed" ]; then
      echo "ERROR: Job failed"
      return 1
    fi
  done

  echo "ERROR: Timeout"
  return 1
}

# Test 1: Store personal history about ejfox
echo "═══════════════════════════════════════════════"
echo "TEST 9.1: Store ejfox Personal History"
echo "═══════════════════════════════════════════════"
echo ""
echo "📝 Storing memories about living in Kingston, Beacon, Brooklyn"
echo ""

send_and_wait "$EJFOX_USER" "Remember: I lived in Kingston, NY for several years. It was a beautiful city on the Hudson River." > /dev/null
sleep 1
send_and_wait "$EJFOX_USER" "Remember: After Kingston, I moved to Beacon, NY. Great art scene there." > /dev/null
sleep 1
send_and_wait "$EJFOX_USER" "Remember: Then I moved to Brooklyn. I lived there before returning upstate." > /dev/null
sleep 1

echo "✅ Stored 3 memories about ejfox's residential history"
echo ""
echo "───────────────────────────────────────────────"
echo ""

# Test 2: Verify recall of Kingston
echo "═══════════════════════════════════════════════"
echo "TEST 9.2: Recall Kingston Memory"
echo "═══════════════════════════════════════════════"
echo ""
echo "📝 Ask about Kingston"
echo "Expected: Agent recalls ejfox lived in Kingston, NY"
echo ""

RESPONSE=$(send_and_wait "$EJFOX_USER" "Where did I use to live? Tell me about Kingston.")
echo "Response: $RESPONSE"
echo ""

if echo "$RESPONSE" | grep -qi "kingston"; then
  echo "✅ PASS: Agent recalled Kingston"
else
  echo "❌ FAIL: Agent didn't recall Kingston"
fi

echo ""
echo "───────────────────────────────────────────────"
echo ""

# Test 3: Verify recall of full history
echo "═══════════════════════════════════════════════"
echo "TEST 9.3: Recall Complete History"
echo "═══════════════════════════════════════════════"
echo ""
echo "📝 Ask about full residential history"
echo "Expected: Agent recalls Kingston → Beacon → Brooklyn progression"
echo ""

RESPONSE=$(send_and_wait "$EJFOX_USER" "Can you tell me the cities I've lived in? List them in order.")
echo "Response: $RESPONSE"
echo ""

KINGSTON_FOUND=false
BEACON_FOUND=false
BROOKLYN_FOUND=false

if echo "$RESPONSE" | grep -qi "kingston"; then
  KINGSTON_FOUND=true
fi

if echo "$RESPONSE" | grep -qi "beacon"; then
  BEACON_FOUND=true
fi

if echo "$RESPONSE" | grep -qi "brooklyn"; then
  BROOKLYN_FOUND=true
fi

if [ "$KINGSTON_FOUND" = true ] && [ "$BEACON_FOUND" = true ] && [ "$BROOKLYN_FOUND" = true ]; then
  echo "✅ PASS: Agent recalled all three cities (Kingston, Beacon, Brooklyn)"
else
  echo "❌ FAIL: Agent missed some cities"
  [ "$KINGSTON_FOUND" = false ] && echo "  - Missing: Kingston"
  [ "$BEACON_FOUND" = false ] && echo "  - Missing: Beacon"
  [ "$BROOKLYN_FOUND" = false ] && echo "  - Missing: Brooklyn"
fi

echo ""
echo "───────────────────────────────────────────────"
echo ""

# Test 4: User isolation - other user can't access ejfox memories
echo "═══════════════════════════════════════════════"
echo "TEST 9.4: User-Scoped Memory Isolation"
echo "═══════════════════════════════════════════════"
echo ""
echo "📝 Different user tries to access ejfox's residential history"
echo "Expected: No cross-user memory leakage"
echo ""

RESPONSE=$(send_and_wait "$OTHER_USER" "Tell me about the cities ejfox lived in. Where did he live?")
echo "Response: $RESPONSE"
echo ""

# Should NOT have specific details about Kingston/Beacon/Brooklyn from ejfox's memories
if echo "$RESPONSE" | grep -qi "kingston.*beacon.*brooklyn\|brooklyn.*beacon.*kingston"; then
  echo "❌ FAIL: Cross-user memory leakage detected"
else
  echo "✅ PASS: User isolation maintained (stranger doesn't have access to ejfox's personal memories)"
fi

echo ""
echo "───────────────────────────────────────────────"
echo ""

# Test 5: Memory attribution - verify memories belong to ejfox
echo "═══════════════════════════════════════════════"
echo "TEST 9.5: Memory Attribution Verification"
echo "═══════════════════════════════════════════════"
echo ""
echo "📝 Verify memories are correctly attributed to ejfox"
echo ""

# Check database directly
MEMORY_COUNT=$(sqlite3 /Users/ejfox/code/coachartie2/packages/capabilities/data/coachartie.db \
  "SELECT COUNT(*) FROM memories WHERE user_id = 'ejfox' AND (content LIKE '%kingston%' OR content LIKE '%beacon%' OR content LIKE '%brooklyn%');")

echo "Database check: Found $MEMORY_COUNT memories for ejfox containing city names"
echo ""

if [ "$MEMORY_COUNT" -ge 3 ]; then
  echo "✅ PASS: Memories correctly attributed to ejfox user"
else
  echo "❌ FAIL: Expected at least 3 memories, found $MEMORY_COUNT"
fi

echo ""
echo "───────────────────────────────────────────────"
echo ""

# Test 6: Context-aware recall
echo "═══════════════════════════════════════════════"
echo "TEST 9.6: Context-Aware Historical Recall"
echo "═══════════════════════════════════════════════"
echo ""
echo "📝 Ask about general living situation (not explicitly mentioning cities)"
echo "Expected: Agent uses memory context to provide relevant info"
echo ""

RESPONSE=$(send_and_wait "$EJFOX_USER" "Have I always lived in the same place?")
echo "Response: $RESPONSE"
echo ""

if echo "$RESPONSE" | grep -qiE "kingston|beacon|brooklyn|moved|different"; then
  echo "✅ PASS: Agent used memory context to answer accurately"
else
  echo "❌ FAIL: Agent didn't reference stored memories"
fi

echo ""
echo "═══════════════════════════════════════════════"
echo "TEST 9 COMPLETE: Reverse Memory Verification"
echo "═══════════════════════════════════════════════"
echo ""
echo "📊 Test Coverage:"
echo "  - Memory storage for real user (ejfox)"
echo "  - Individual city recall (Kingston)"
echo "  - Complete history recall (Kingston → Beacon → Brooklyn)"
echo "  - User-scoped isolation (no cross-user leakage)"
echo "  - Memory attribution verification"
echo "  - Context-aware recall without explicit prompts"
echo ""
echo "🎯 This test verifies the memory system works correctly"
echo "   for the actual user with real residential history."
echo ""
