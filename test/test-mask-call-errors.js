#!/usr/bin/env node
'use strict';

process.env.BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || 'operator-test-key';
delete process.env.XAI_API_KEY;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;

const { maskPhoneNumbersInText, logCallError, logHangupError } = require('../src/server.js');

let failed = 0;

function fail(message) {
  console.error(`  ✗ ${message}`);
  failed += 1;
}

function pass(message) {
  console.log(`  ✓ ${message}`);
}

function capture(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => {
    lines.push(args.map((part) => String(part)).join(' '));
  };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

function main() {
  const raw = 'The number +15555550100 is not a valid phone number';
  const masked = maskPhoneNumbersInText(raw);
  if (!masked.includes('+15555550100') && masked.includes('0100') && masked.includes('The number ')) {
    pass('an E.164 number inside an error is masked');
  } else {
    fail(`masking failed: ${masked}`);
  }

  const plain = 'socket hang up (status 500, code 21211)';
  if (maskPhoneNumbersInText(plain) === plain) {
    pass('an error without a phone number is unchanged');
  } else {
    fail('a phone-free error was modified');
  }

  const both = 'from +15555550100 to +15555550199';
  const bothMasked = maskPhoneNumbersInText(both);
  if (!bothMasked.includes('+15555550100') && !bothMasked.includes('+15555550199') && bothMasked.includes('0100') && bothMasked.includes('0199')) {
    pass('every E.164 number in one message is masked');
  } else {
    fail(`multiple numbers were not masked: ${bothMasked}`);
  }

  const callLines = capture(() => {
    logCallError(new Error('Unable to create record for +15555550100'));
  });
  if (callLines.length === 1 && callLines[0].startsWith('[call] error:') && !callLines[0].includes('+15555550100') && callLines[0].includes('0100')) {
    pass('[call] error: logs the masked message');
  } else {
    fail(`[call] error log was ${JSON.stringify(callLines)}`);
  }

  const hangupLines = capture(() => {
    logHangupError(new Error('The requested resource +15555550100 was not found'));
  });
  if (
    hangupLines.length === 1 &&
    hangupLines[0].startsWith('[hangup] Twilio update failed:') &&
    !hangupLines[0].includes('+15555550100') &&
    hangupLines[0].includes('0100')
  ) {
    pass('[hangup] Twilio update failed: logs the masked message');
  } else {
    fail(`[hangup] error log was ${JSON.stringify(hangupLines)}`);
  }

  const unchanged = capture(() => {
    logCallError(new Error('socket hang up'));
    logHangupError(new Error('socket hang up'));
  });
  if (unchanged[0] === '[call] error: socket hang up' && unchanged[1] === '[hangup] Twilio update failed: socket hang up') {
    pass('phone-free failures are logged unchanged');
  } else {
    fail(`phone-free logs changed: ${JSON.stringify(unchanged)}`);
  }

  if (failed > 0) {
    console.error(`\n${failed} call-error mask test(s) failed`);
    process.exit(1);
  }
  console.log('\n✓ All call-error mask tests passed');
  process.exit(0);
}

main();
