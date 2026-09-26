#!/usr/bin/env node
/**
 * Test delivery tag stripping from src/server.js
 */
'use strict';

process.env.BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || 'ci-test-key';

const { stripDeliveryTags } = require('../src/server.js');

const tests = [
  { input: 'Hi, how can I help you today?', expected: { text: 'Hi, how can I help you today?', count: 0 }, desc: 'Text without tags' },
  { input: 'Hi [pause] how can I help you?', expected: { text: 'Hi how can I help you?', count: 1 }, desc: 'Single [pause] tag' },
  { input: '[breath] Hello there', expected: { text: 'Hello there', count: 1 }, desc: 'Leading [breath] tag' },
  { input: 'Thanks for calling [sigh]', expected: { text: 'Thanks for calling', count: 1 }, desc: 'Trailing [sigh] tag' },
  { input: 'Well [pause] I think [pause] we can do that', expected: { text: 'Well I think we can do that', count: 2 }, desc: 'Multiple [pause] tags' },
  { input: 'Um [um] let me check [breath] okay [pause] yes', expected: { text: 'Um let me check okay yes', count: 3 }, desc: 'Mixed delivery tags' },
  { input: '[PAUSE] This is [BREATH] case insensitive [SIGH]', expected: { text: 'This is case insensitive', count: 3 }, desc: 'Uppercase tags (case insensitive)' },
  { input: '[laugh] That\'s funny [chuckle]', expected: { text: 'That\'s funny', count: 2 }, desc: '[laugh] and [chuckle] tags' },
  { input: '[hmm] [uh] [er] [ah] Thinking...', expected: { text: 'Thinking...', count: 4 }, desc: 'Filler word tags' },
  { input: 'This [bracket text] should stay', expected: { text: 'This [bracket text] should stay', count: 0 }, desc: 'Non-delivery brackets preserved' },
  { input: '', expected: { text: '', count: 0 }, desc: 'Empty string' },
  { input: '[pause][breath][sigh]', expected: { text: '', count: 3 }, desc: 'Only tags, no content' },
  { input: 'Hello  [pause]  there  [breath]  friend', expected: { text: 'Hello there friend', count: 2 }, desc: 'Whitespace collapse' },
  { input: '  [pause]  spaced  [breath]  ', expected: { text: 'spaced', count: 2 }, desc: 'Leading/trailing spaces with tags' }
];

let passed = 0;
let failed = 0;

console.log('=== Testing stripDeliveryTags from src/server.js ===\n');

tests.forEach(({ input, expected, desc }) => {
  const result = stripDeliveryTags(input);
  if (result.text === expected.text && result.count === expected.count) {
    console.log(`  ✓ ${desc}`);
    passed++;
  } else {
    console.log(`  ✗ ${desc}`);
    console.log(`    Input:    ${JSON.stringify(input)}`);
    console.log(`    Expected: ${JSON.stringify(expected)}`);
    console.log(`    Got:      ${JSON.stringify(result)}`);
    failed++;
  }
});

console.log(`\nPassed: ${passed}/${tests.length}`);

if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) failed`);
  process.exit(1);
}

console.log('\n✓ All stripDeliveryTags tests passed');
process.exit(0);
