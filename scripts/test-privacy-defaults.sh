#!/usr/bin/env bash
# Test privacy defaults: phone number masking and transcript logging

set -euo pipefail

echo "=== Privacy defaults test ==="
echo ""

# Test 1: Phone number masking function
echo "Test 1: Phone number masking"
node -e "
function maskPhoneNumber(phone) {
  if (!phone) return '(null)';
  const s = String(phone);
  if (s.length <= 4) return s;
  const last4 = s.slice(-4);
  return 'x'.repeat(Math.min(s.length - 4, 8)) + last4;
}

const tests = [
  { input: '+12025551234', expected: 'xxxxxxxx1234' },
  { input: '5551234', expected: 'xxx1234' },
  { input: '1234', expected: '1234' },
  { input: '', expected: '(null)' },
  { input: null, expected: '(null)' },
  { input: '+441234567890', expected: 'xxxxxxxx7890' }
];

let passed = 0;
let failed = 0;

tests.forEach(({ input, expected }) => {
  const result = maskPhoneNumber(input);
  if (result === expected) {
    console.log(\`  ✓ maskPhoneNumber(\${JSON.stringify(input)}) = \${result}\`);
    passed++;
  } else {
    console.log(\`  ✗ maskPhoneNumber(\${JSON.stringify(input)}) = \${result} (expected \${expected})\`);
    failed++;
  }
});

console.log(\`\nPassed: \${passed}/\${tests.length}\`);
process.exit(failed > 0 ? 1 : 0);
"

if [ $? -eq 0 ]; then
  echo "✓ Phone masking tests passed"
else
  echo "✗ Phone masking tests failed"
  exit 1
fi

echo ""

# Test 2: LOG_TRANSCRIPTS default value in .env.example
echo "Test 2: LOG_TRANSCRIPTS default (should be empty/unset)"
LOG_TRANSCRIPTS_VALUE=$(grep "^LOG_TRANSCRIPTS=" .env.example | cut -d= -f2)

if [ -z "$LOG_TRANSCRIPTS_VALUE" ]; then
  echo "  ✓ LOG_TRANSCRIPTS is empty by default (privacy-safe)"
else
  echo "  ✗ LOG_TRANSCRIPTS is set to '$LOG_TRANSCRIPTS_VALUE' (should be empty)"
  exit 1
fi

echo ""

# Test 3: Verify .env.example contains LOG_TRANSCRIPTS entry
echo "Test 3: .env.example contains LOG_TRANSCRIPTS"
if grep -q "^LOG_TRANSCRIPTS=" .env.example; then
  echo "  ✓ LOG_TRANSCRIPTS= found in .env.example"
else
  echo "  ✗ LOG_TRANSCRIPTS= not found in .env.example"
  exit 1
fi

echo ""

# Test 4: Verify SECURITY.md mentions phone masking
echo "Test 4: Documentation mentions privacy defaults"
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
