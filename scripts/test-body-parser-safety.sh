#!/usr/bin/env bash
# Regression test: verify body-parser errors don't leak filesystem paths

set -euo pipefail

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
FAIL=0

echo "=== Body-parser safety smoke test ==="
echo "Server: $SERVER_URL"
echo ""

# Test 1: Malformed JSON without auth key → should return 400 JSON, no paths
echo "Test 1: Malformed JSON POST to /call (no auth)"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "$SERVER_URL/call" \
  -H "Content-Type: application/json" \
  -d '{bad json}' 2>&1 || true)

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

echo "  HTTP status: $HTTP_CODE"
echo "  Response body: $BODY"

# Check HTTP status is 400 or 401 (not 500)
if [[ "$HTTP_CODE" != "400" && "$HTTP_CODE" != "401" ]]; then
  echo "  ❌ FAIL: Expected 400 or 401, got $HTTP_CODE"
  FAIL=1
fi

# Check response is JSON (not HTML)
if ! echo "$BODY" | jq . >/dev/null 2>&1; then
  echo "  ❌ FAIL: Response is not valid JSON"
  FAIL=1
fi

# Check for leaked filesystem paths (common patterns)
if echo "$BODY" | grep -E '(/home/|/Users/|/workspace|/opt/|C:\\|require\.main)' >/dev/null; then
  echo "  ❌ FAIL: Response contains filesystem paths!"
  FAIL=1
else
  echo "  ✓ PASS: No filesystem paths leaked"
fi

# Check response doesn't contain HTML error page
if echo "$BODY" | grep -i '<html' >/dev/null; then
  echo "  ❌ FAIL: Response contains HTML (should be JSON)"
  FAIL=1
else
  echo "  ✓ PASS: Response is not HTML"
fi

echo ""

# Test 2: Oversized body without auth → should return 413 JSON
echo "Test 2: Oversized body POST to /call (no auth)"
# Use 1.2MB payload (exceeds 1MB limit) via temp file to avoid shell arg limits
TEMP_PAYLOAD=$(mktemp)
printf '{"goal": "%s"}' "$(head -c 1200000 /dev/zero | tr '\0' 'x')" > "$TEMP_PAYLOAD"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "$SERVER_URL/call" \
  -H "Content-Type: application/json" \
  --data-binary "@$TEMP_PAYLOAD" 2>&1 || true)
rm -f "$TEMP_PAYLOAD"

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

echo "  HTTP status: $HTTP_CODE"
echo "  Response body: $BODY"

# 413 is expected for oversized body
if [[ "$HTTP_CODE" == "413" ]]; then
  echo "  ✓ PASS: Correct 413 status"
else
  echo "  ❌ FAIL: Expected 413, got $HTTP_CODE (may fail before reaching server)"
  FAIL=1
fi

# Check for leaked paths even on 413
if echo "$BODY" | grep -E '(/home/|/Users/|/workspace|/opt/|C:\\|require\.main)' >/dev/null; then
  echo "  ❌ FAIL: Response contains filesystem paths!"
  FAIL=1
else
  echo "  ✓ PASS: No filesystem paths leaked"
fi

echo ""

# Test 3: Valid JSON but no auth → should return 401 JSON (not path leak)
echo "Test 3: Valid JSON POST to /call (no auth, should be 401)"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "$SERVER_URL/call" \
  -H "Content-Type: application/json" \
  -d '{"to": "+1234567890", "goal": "test"}' 2>&1 || true)

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

echo "  HTTP status: $HTTP_CODE"
echo "  Response body: $BODY"

if [[ "$HTTP_CODE" == "401" ]]; then
  echo "  ✓ PASS: Correct 401 unauthorized"
else
  echo "  ❌ FAIL: Expected 401, got $HTTP_CODE"
  FAIL=1
fi

# Check for leaked paths
if echo "$BODY" | grep -E '(/home/|/Users/|/workspace|/opt/|C:\\|require\.main)' >/dev/null; then
  echo "  ❌ FAIL: Response contains filesystem paths!"
  FAIL=1
else
  echo "  ✓ PASS: No filesystem paths leaked"
fi

echo ""
echo "==================================="

if [[ $FAIL -eq 0 ]]; then
  echo "✓ All tests passed"
  exit 0
else
  echo "❌ Some tests failed"
  exit 1
fi
