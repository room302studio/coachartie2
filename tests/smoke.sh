#!/bin/bash
# Coach Artie smoke test: run against a live bot (dev or prod) to confirm the externally
# visible contracts still work after a deploy. Not a substitute for `pnpm test` (vitest) —
# this hits real HTTP ports on a running process.
#
# Usage:
#   tests/smoke.sh <scenario> [<scenario> ...]
#   tests/smoke.sh calculator dm-contract presence
#
# Scenarios:
#   calculator    POST "Calculate 123 * 456" to :47324/chat, poll GET /chat/:id, expect 56088.
#   dm-contract   POST :47321/api/dm with no body. Expects the 401 Bearer-token validation
#                 error — asserts the contract's shape, never sends a real Discord DM.
#   presence      GET :47321/api/presence/inbox. Expects the {success, data} envelope.
#
# Env:
#   ENGINE_HOST   default 127.0.0.1:47324
#   GATEWAY_HOST  default 127.0.0.1:47321
#
# Superseded tests/test-0{1..9}-*.sh (archived under tests/archive/, wave 12): those were a
# broader adversarial/red-team suite against a live bot, run by hand, not by verify-v3.sh.
# This script covers the three contracts CUTOVER.md's smoke step checks after a deploy.

set -uo pipefail

ENGINE_HOST="${ENGINE_HOST:-127.0.0.1:47324}"
GATEWAY_HOST="${GATEWAY_HOST:-127.0.0.1:47321}"

PASS=0
FAIL=0

pass() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }

scenario_calculator() {
  echo "=== calculator: POST /chat, poll /chat/:id, expect 56088 ==="

  RESPONSE=$(curl -s -X POST "http://${ENGINE_HOST}/chat" \
    -H "Content-Type: application/json" \
    -d '{"message":"Calculate 123 * 456","userId":"smoke-test","source":"smoke-test"}')

  JOB_ID=$(echo "$RESPONSE" | grep -o '"messageId":"[^"]*"' | cut -d'"' -f4)
  if [ -z "$JOB_ID" ]; then
    fail "calculator: no messageId in response: $RESPONSE"
    return
  fi
  pass "calculator: message accepted ($JOB_ID)"

  local attempt=0
  local max_attempts=30
  while [ $attempt -lt $max_attempts ]; do
    sleep 1
    attempt=$((attempt + 1))
    RESULT=$(curl -s "http://${ENGINE_HOST}/chat/${JOB_ID}")
    STATUS=$(echo "$RESULT" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)

    if [ "$STATUS" = "completed" ]; then
      RESPONSE_TEXT=$(echo "$RESULT" | grep -o '"response":"[^"]*"' | cut -d'"' -f4)
      if echo "$RESPONSE_TEXT" | grep -q "56088\|56,088"; then
        pass "calculator: correct answer (56088) in ${attempt}s"
      else
        fail "calculator: wrong/missing answer: $RESPONSE_TEXT"
      fi
      return
    elif [ "$STATUS" = "failed" ]; then
      fail "calculator: job failed: $RESULT"
      return
    fi
  done
  fail "calculator: timed out after ${max_attempts}s waiting on ${JOB_ID}"
}

scenario_dm_contract() {
  echo "=== dm-contract: POST /api/dm with no auth, expect the validation-error shape (no real send) ==="

  HTTP_CODE=$(curl -s -o /tmp/smoke-dm-response.json -w "%{http_code}" \
    -X POST "http://${GATEWAY_HOST}/api/dm" \
    -H "Content-Type: application/json" \
    -d '{}')
  BODY=$(cat /tmp/smoke-dm-response.json 2>/dev/null)
  rm -f /tmp/smoke-dm-response.json

  if [ "$HTTP_CODE" = "401" ] && echo "$BODY" | grep -q '"success":false' && echo "$BODY" | grep -qi 'bearer'; then
    pass "dm-contract: 401 + Bearer-token error shape, no DM sent"
  else
    fail "dm-contract: expected 401 Bearer-token error, got HTTP $HTTP_CODE: $BODY"
  fi
}

scenario_presence() {
  echo "=== presence: GET /api/presence/inbox ==="

  HTTP_CODE=$(curl -s -o /tmp/smoke-presence-response.json -w "%{http_code}" \
    "http://${GATEWAY_HOST}/api/presence/inbox")
  BODY=$(cat /tmp/smoke-presence-response.json 2>/dev/null)
  rm -f /tmp/smoke-presence-response.json

  if [ "$HTTP_CODE" = "200" ] && echo "$BODY" | grep -q '"success":true'; then
    pass "presence: 200 + success envelope"
  else
    fail "presence: expected 200 + success envelope, got HTTP $HTTP_CODE: $BODY"
  fi
}

if [ $# -eq 0 ]; then
  echo "Usage: tests/smoke.sh <scenario> [<scenario> ...]" >&2
  echo "Scenarios: calculator, dm-contract, presence" >&2
  exit 1
fi

for scenario in "$@"; do
  case "$scenario" in
    calculator) scenario_calculator ;;
    dm-contract) scenario_dm_contract ;;
    presence) scenario_presence ;;
    *)
      echo "Unknown scenario: $scenario (expected calculator, dm-contract or presence)" >&2
      exit 1
      ;;
  esac
  echo ""
done

echo "=== smoke: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
