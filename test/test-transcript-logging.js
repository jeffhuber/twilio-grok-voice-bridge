#!/usr/bin/env node
/**
 * Test LOG_TRANSCRIPTS behavior: verify silence when off
 */
'use strict';

const fs = require('fs');
const path = require('path');

console.log('=== Testing LOG_TRANSCRIPTS behavior ===\n');

// Read server.js to extract LOG_TRANSCRIPTS check pattern
const serverPath = path.join(__dirname, '../src/server.js');
const serverCode = fs.readFileSync(serverPath, 'utf8');

// Verify LOG_TRANSCRIPTS constant exists
const logTranscriptsMatch = serverCode.match(/const LOG_TRANSCRIPTS = process\.env\.LOG_TRANSCRIPTS === '1';/);
if (!logTranscriptsMatch) {
  console.error('❌ FAIL: Could not find LOG_TRANSCRIPTS definition in server.js');
  process.exit(1);
}
console.log('  ✓ LOG_TRANSCRIPTS constant found in server.js');

// Verify appendTranscript checks LOG_TRANSCRIPTS before logging
const appendTranscriptMatch = serverCode.match(/function appendTranscript[\s\S]*?\n\}/);
if (!appendTranscriptMatch) {
  console.error('❌ FAIL: Could not find appendTranscript function');
  process.exit(1);
}

const appendTranscriptCode = appendTranscriptMatch[0];

// Check that transcript logging is conditional on LOG_TRANSCRIPTS
const hasConditionalLogging = /if\s*\(\s*LOG_TRANSCRIPTS\s*\)[\s\S]*?console\.log/.test(appendTranscriptCode);
if (!hasConditionalLogging) {
  console.error('❌ FAIL: appendTranscript does not check LOG_TRANSCRIPTS before logging');
  console.error('Expected: if (LOG_TRANSCRIPTS) { console.log(...) }');
  process.exit(1);
}
console.log('  ✓ appendTranscript checks LOG_TRANSCRIPTS before logging');

// Verify no unconditional console.log in appendTranscript
const unconditionalLogPattern = /console\.log\([^)]*\[transcript\][^)]*\)(?!\s*;?\s*\})/;
const lines = appendTranscriptCode.split('\n');
let hasUnconditionalLog = false;
for (const line of lines) {
  // Skip lines that are inside if (LOG_TRANSCRIPTS) blocks
  if (line.includes('console.log') && line.includes('[transcript]')) {
    // Find surrounding context
    const idx = lines.indexOf(line);
    const prevLines = lines.slice(Math.max(0, idx - 5), idx).join('\n');
    if (!prevLines.includes('if (LOG_TRANSCRIPTS)')) {
      hasUnconditionalLog = true;
      console.error(`❌ FAIL: Found unconditional [transcript] log at line: ${line.trim()}`);
    }
  }
}

if (hasUnconditionalLog) {
  console.error('❌ FAIL: appendTranscript contains unconditional transcript logging');
  console.error('All [transcript] logs must be inside if (LOG_TRANSCRIPTS) blocks');
  process.exit(1);
}

console.log('  ✓ No unconditional [transcript] logs found');
console.log('  ✓ Transcript logging is silent when LOG_TRANSCRIPTS is off\n');

console.log('✓ All LOG_TRANSCRIPTS behavior tests passed');
process.exit(0);
