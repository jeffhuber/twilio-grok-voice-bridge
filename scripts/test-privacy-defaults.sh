#!/usr/bin/env bash
# Test privacy defaults: phone number masking and transcript logging

set -euo pipefail

echo "=== Privacy defaults test ==="
echo ""

# Test 1: Phone number masking function (from actual server.js)
echo "Test 1: Phone number masking (src/server.js)"
node test/test-privacy-functions.js
if [ $? -ne 0 ]; then
  exit 1
fi

echo ""

# Test 2: Verify LOG_TRANSCRIPTS behavior (silence when off)
echo "Test 2: LOG_TRANSCRIPTS behavior (must be silent when off)"
node test/test-transcript-logging.js
if [ $? -ne 0 ]; then
  exit 1
fi

echo ""

# Test 3: LOG_TRANSCRIPTS default value in .env.example
echo "Test 3: LOG_TRANSCRIPTS default in .env.example (should be empty/unset)"
LOG_TRANSCRIPTS_VALUE=$(grep "^LOG_TRANSCRIPTS=" .env.example | cut -d= -f2)

if [ -z "$LOG_TRANSCRIPTS_VALUE" ]; then
  echo "  ✓ LOG_TRANSCRIPTS is empty by default (privacy-safe)"
else
  echo "  ✗ LOG_TRANSCRIPTS is set to '$LOG_TRANSCRIPTS_VALUE' (should be empty)"
  exit 1
fi

echo ""

# Test 4: Verify .env.example contains LOG_TRANSCRIPTS entry
echo "Test 4: .env.example contains LOG_TRANSCRIPTS"
if grep -q "^LOG_TRANSCRIPTS=" .env.example; then
  echo "  ✓ LOG_TRANSCRIPTS= found in .env.example"
else
  echo "  ✗ LOG_TRANSCRIPTS= not found in .env.example"
  exit 1
fi

echo ""

# Test 5: Verify SECURITY.md mentions phone masking
echo "Test 5: Documentation mentions privacy defaults"
if grep -q "masked by default" SECURITY.md; then
  echo "  ✓ SECURITY.md mentions phone masking"
else
  echo "  ✗ SECURITY.md does not mention phone masking"
  exit 1
fi

if grep -q "LOG_TRANSCRIPTS" SECURITY.md; then
  echo "  ✓ SECURITY.md mentions LOG_TRANSCRIPTS"
else
  echo "  ✗ SECURITY.md does not mention LOG_TRANSCRIPTS"
  exit 1
fi

if grep -q "LOG_TRANSCRIPTS" README.md; then
  echo "  ✓ README.md mentions LOG_TRANSCRIPTS"
else
  echo "  ✗ README.md does not mention LOG_TRANSCRIPTS"
  exit 1
fi

echo ""
echo "==================================="
echo "✓ All privacy defaults tests passed"
exit 0
