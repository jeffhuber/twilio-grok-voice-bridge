#!/usr/bin/env node
'use strict';

process.env.BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || 'operator-test-key';
delete process.env.MEDIA_STREAM_SECRET;

const crypto = require('crypto');
const http = require('http');
const {
  app,
  generateMediaAuthSignature,
  verifyMediaAuthSignature,
} = require('../src/server.js');

let failed = 0;

function fail(message) {
  console.error(`  ✗ ${message}`);
  failed += 1;
}

function pass(message) {
  console.log(`  ✓ ${message}`);
}

function hmac(secret, callSid, timestamp) {
  return crypto.createHmac('sha256', secret).update(`${callSid}:${timestamp}`, 'utf8').digest('base64url');
}

function getHealth() {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      http
        .get({ hostname: '127.0.0.1', port, path: '/health' }, (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            server.close(() => {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            });
          });
        })
        .on('error', (err) => {
          server.close(() => reject(err));
        });
    });
  });
}

async function main() {
  const callSid = 'call-1';
  const timestamp = String(Date.now());

  process.env.BRIDGE_API_KEY = 'operator-test-key';
  delete process.env.MEDIA_STREAM_SECRET;
  const fallback = generateMediaAuthSignature(callSid, timestamp);
  if (fallback === hmac('operator-test-key', callSid, timestamp)) {
    pass('unset MEDIA_STREAM_SECRET signs with BRIDGE_API_KEY');
  } else {
    fail('fallback signature did not use the operator key');
  }
  if (verifyMediaAuthSignature(callSid, timestamp, fallback).valid) {
    pass('fallback signature verifies');
  } else {
    fail('fallback signature did not verify');
  }

  process.env.MEDIA_STREAM_SECRET = '   ';
  if (generateMediaAuthSignature(callSid, timestamp) === fallback) {
    pass('blank MEDIA_STREAM_SECRET falls back to BRIDGE_API_KEY');
  } else {
    fail('blank dedicated secret did not fall back');
  }

  process.env.MEDIA_STREAM_SECRET = 'media-test-key';
  const dedicated = generateMediaAuthSignature(callSid, timestamp);
  if (dedicated === hmac('media-test-key', callSid, timestamp) && dedicated !== fallback) {
    pass('MEDIA_STREAM_SECRET overrides the operator key');
  } else {
    fail('dedicated secret was not used for signing');
  }
  if (verifyMediaAuthSignature(callSid, timestamp, dedicated).valid) {
    pass('dedicated signature verifies');
  } else {
    fail('dedicated signature did not verify');
  }
  const wrong = verifyMediaAuthSignature(callSid, timestamp, fallback);
  if (!wrong.valid && wrong.error === 'signature mismatch') {
    pass('operator-key signature is rejected while a dedicated secret is set');
  } else {
    fail(`expected mismatch, got ${JSON.stringify(wrong)}`);
  }

  const expired = verifyMediaAuthSignature(callSid, String(Date.now() - 10 * 60 * 1000), dedicated);
  if (!expired.valid && expired.error === 'timestamp expired') {
    pass('expired timestamp is rejected');
  } else {
    fail(`expected expiry, got ${JSON.stringify(expired)}`);
  }

  const health = await getHealth();
  const encoded = JSON.stringify(health);
  if (health.mediaAuthDedicated === true && health.hmacAuth === true && !encoded.includes('media-test-key') && !encoded.includes('operator-test-key')) {
    pass('health reports a dedicated media secret without echoing it');
  } else {
    fail(`health leak or flag mismatch: ${encoded}`);
  }

  delete process.env.MEDIA_STREAM_SECRET;
  const healthFallback = await getHealth();
  if (healthFallback.mediaAuthDedicated === false && healthFallback.hmacAuth === true) {
    pass('health reports fallback HMAC when MEDIA_STREAM_SECRET is unset');
  } else {
    fail(`fallback health flags ${JSON.stringify(healthFallback)}`);
  }

  process.env.BRIDGE_API_KEY = '';
  process.env.MEDIA_STREAM_SECRET = '';
  let threw = false;
  try {
    generateMediaAuthSignature(callSid, timestamp);
  } catch (err) {
    threw = /MEDIA_STREAM_SECRET or BRIDGE_API_KEY/.test(err.message);
  }
  if (threw) pass('minting fails when both secrets are empty');
  else fail('minting should fail when both secrets are empty');
  const missing = verifyMediaAuthSignature(callSid, timestamp, fallback);
  if (!missing.valid) pass('verify fails when both secrets are empty');
  else fail('verify should fail when both secrets are empty');

  if (failed > 0) {
    console.error(`\n${failed} media secret test(s) failed`);
    process.exit(1);
  }
  console.log('\n✓ All media secret tests passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
