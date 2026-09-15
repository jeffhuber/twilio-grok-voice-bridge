#!/usr/bin/env node
/**
 * Test privacy-related functions from src/server.js
 * 
 * This test extracts and exercises maskPhoneNumber() to ensure
 * phone masking behavior does not drift from the implementation.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Read and extract maskPhoneNumber from server.js
const serverPath = path.join(__dirname, '../src/server.js');
const serverCode = fs.readFileSync(serverPath, 'utf8');

// Extract maskPhoneNumber function definition
const maskFnMatch = serverCode.match(/function maskPhoneNumber\([^)]*\)\s*\{[^}]*\}/s);
if (!maskFnMatch) {
  console.error('❌ FAIL: Could not extract maskPhoneNumber from src/server.js');
  process.exit(1);
}

// Evaluate the function in isolated scope
let maskPhoneNumber;
try {
  eval(`maskPhoneNumber = ${maskFnMatch[0]}`);
} catch (err) {
  console.error('❌ FAIL: Could not evaluate maskPhoneNumber:', err.message);
  process.exit(1);
}

// Test cases for phone number masking
const tests = [
  { input: '+12025551234', expected: 'xxxxxxxx1234', desc: 'E.164 US number' },
  { input: '5551234', expected: 'xxx1234', desc: '7-digit local number' },
  { input: '1234', expected: '1234', desc: 'Short number (4 digits)' },
  { input: '123', expected: '123', desc: 'Very short number (3 digits)' },
  { input: '', expected: '(null)', desc: 'Empty string' },
  { input: null, expected: '(null)', desc: 'Null value' },
  { input: undefined, expected: '(null)', desc: 'Undefined value' },
  { input: '+441234567890', expected: 'xxxxxxxx7890', desc: 'International UK number' },
  { input: '+861234567890123', expected: 'xxxxxxxx0123', desc: 'Long international number' }
];

let passed = 0;
let failed = 0;

console.log('=== Testing maskPhoneNumber from src/server.js ===\n');

tests.forEach(({ input, expected, desc }) => {
  const result = maskPhoneNumber(input);
  if (result === expected) {
    console.log(`  ✓ ${desc}: maskPhoneNumber(${JSON.stringify(input)}) = ${result}`);
    passed++;
  } else {
    console.log(`  ✗ ${desc}: maskPhoneNumber(${JSON.stringify(input)}) = ${result} (expected ${expected})`);
    failed++;
  }
});

console.log(`\nPassed: ${passed}/${tests.length}`);

if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) failed`);
  process.exit(1);
}

console.log('\n✓ All maskPhoneNumber tests passed');
process.exit(0);
