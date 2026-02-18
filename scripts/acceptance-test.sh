#!/usr/bin/env bash
# Acceptance tests for Agent Firewall v0.1
# Runs against a live server. Requires:
#   AF_BRIDGE_TOKEN  (set in env or .env)
#   AF_TEST_WORKSPACE (a directory under AF_ALLOWED_ROOTS)
#   Server running at http://localhost:8787
#
# Usage:
#   AF_BRIDGE_TOKEN=secret AF_TEST_WORKSPACE=/tmp/test-workspace \
#     bash scripts/acceptance-test.sh

set -euo pipefail

BASE_URL="${AF_BASE_URL:-http://localhost:8787}"
TOKEN="${AF_BRIDGE_TOKEN:-}"
WORKSPACE="${AF_TEST_WORKSPACE:-/tmp}"
PASS=0
FAIL=0

if [[ -z "$TOKEN" ]]; then
  echo "ERROR: AF_BRIDGE_TOKEN is required"
  exit 1
fi

# ── helpers ──────────────────────────────────────────────────────────────────
pass() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }

# Returns body on stdout; HTTP status on stderr via /tmp/http_status
http_post_json() {
  local url="$1" auth="$2" body="$3"
  local tmpfile; tmpfile=$(mktemp)
  local status
  status=$(curl -s -o "$tmpfile" -w "%{http_code}" -X POST "$url" \
    -H "Authorization: Bearer $auth" \
    -H "Content-Type: application/json" \
    -d "$body")
  cat "$tmpfile"
  rm -f "$tmpfile"
  echo "$status" >&2
}

http_status() {
  curl -s -o /dev/null -w "%{http_code}" "$@"
}

http_body() {
  curl -s "$@"
}

# ── Test 1: POST /v1/tasks → 202 + session_id ─────────────────────────────
echo ""
echo "Test 1: POST /v1/tasks returns 202 with session_id"

TASK_BODY="{\"goal\":\"Echo hello\",\"workspace_root\":\"$WORKSPACE\",\"timeout_seconds\":60}"
RESPONSE=$(http_post_json "$BASE_URL/v1/tasks" "$TOKEN" "$TASK_BODY" 2>/tmp/t1_status)
STATUS=$(cat /tmp/t1_status)

SESSION_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null || true)

if [[ "$STATUS" == "202" ]] && [[ -n "$SESSION_ID" ]]; then
  pass "POST /v1/tasks → 202, session_id=$SESSION_ID"
else
  fail "POST /v1/tasks → $STATUS, body=$RESPONSE"
  SESSION_ID=""
fi

# ── Test 2: Poll GET /state until done/failed ─────────────────────────────
if [[ -n "$SESSION_ID" ]]; then
  echo ""
  echo "Test 2: Poll GET /v1/sessions/:id/state until terminal state"

  FINAL_STATUS=""
  for i in $(seq 1 30); do
    sleep 2
    STATE=$(http_body "$BASE_URL/v1/sessions/$SESSION_ID/state" \
      -H "Authorization: Bearer $TOKEN")
    FINAL_STATUS=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || true)

    if [[ "$FINAL_STATUS" == "done" ]] || [[ "$FINAL_STATUS" == "failed" ]] || [[ "$FINAL_STATUS" == "aborted" ]]; then
      break
    fi
  done

  if [[ "$FINAL_STATUS" == "done" ]] || [[ "$FINAL_STATUS" == "failed" ]]; then
    pass "Session reached terminal state: $FINAL_STATUS"

    # Check blockers structure
    BLOCKERS=$(echo "$STATE" | python3 -c "
import sys, json
s = json.load(sys.stdin)
blockers = s.get('blockers', [])
if not blockers:
    print('empty')
elif all('file' in b and 'line_range' in b for b in blockers):
    print('valid')
else:
    print('invalid')
" 2>/dev/null || true)
    if [[ "$BLOCKERS" == "empty" ]] || [[ "$BLOCKERS" == "valid" ]]; then
      pass "Blockers structure OK ($BLOCKERS)"
    else
      fail "Blockers missing required fields (file, line_range)"
    fi
  else
    fail "Session did not reach terminal state (current: $FINAL_STATUS)"
  fi
else
  echo "  ⏭  Skipping Test 2 (no session_id)"
fi

# ── Test 3: GET /artifacts ─────────────────────────────────────────────────
if [[ -n "$SESSION_ID" ]]; then
  echo ""
  echo "Test 3: GET /v1/sessions/:id/artifacts returns index"

  ARTIFACTS=$(http_body "$BASE_URL/v1/sessions/$SESSION_ID/artifacts" \
    -H "Authorization: Bearer $TOKEN")
  ART_STATUS=$(http_status "$BASE_URL/v1/sessions/$SESSION_ID/artifacts" \
    -H "Authorization: Bearer $TOKEN")

  if [[ "$ART_STATUS" == "200" ]]; then
    pass "GET /artifacts → 200"
  else
    fail "GET /artifacts → $ART_STATUS"
  fi
else
  echo "  ⏭  Skipping Test 3 (no session_id)"
fi

# ── Test 4: workspace_root = bad path → 403 ────────────────────────────────
echo ""
echo "Test 4: workspace_root outside allowed roots → 403"

DENY_STATUS=$(http_status -X POST "$BASE_URL/v1/tasks" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"goal":"Evil","workspace_root":"/etc"}')

if [[ "$DENY_STATUS" == "403" ]]; then
  pass "workspace_root=/etc → 403 (denied)"
else
  fail "workspace_root=/etc → $DENY_STATUS (expected 403)"
fi

# ── Test 5: No Authorization header → 401 ─────────────────────────────────
echo ""
echo "Test 5: No Authorization header → 401"

NO_AUTH_STATUS=$(http_status "$BASE_URL/v1/sessions")

if [[ "$NO_AUTH_STATUS" == "401" ]]; then
  pass "No auth → 401"
else
  fail "No auth → $NO_AUTH_STATUS (expected 401)"
fi

# ── Test 6: Health check ───────────────────────────────────────────────────
echo ""
echo "Test 6: GET /v1/health → 200 with status"

HEALTH=$(http_body "$BASE_URL/v1/health" -H "Authorization: Bearer $TOKEN")
HEALTH_STATUS=$(http_status "$BASE_URL/v1/health" -H "Authorization: Bearer $TOKEN")

if [[ "$HEALTH_STATUS" == "200" ]] && echo "$HEALTH" | grep -q '"status"'; then
  pass "GET /v1/health → 200"
else
  fail "GET /v1/health → $HEALTH_STATUS, body=$HEALTH"
fi

# ── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════"
echo "  PASSED: $PASS"
echo "  FAILED: $FAIL"
echo "═══════════════════════════════════"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
