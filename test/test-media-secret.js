#!/usr/bin/env node
'use strict';

process.env.BRIDGE_API_KEY = 'operator-test-key';
delete process.env.MEDIA_STREAM_SECRET;

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
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

const CHILD = `
'use strict';
const http = require('http');
const crypto = require('crypto');
const {
  app,
  generateMediaAuthSignature,
  verifyMediaAuthSignature,
  mediaAuthSecret,
} = require('./src/server.js');

const callSid = 'call-1';
const timestamp = process.env.PROBE_TIMESTAMP;
const operator = process.env.BRIDGE_API_KEY || '';
const dedicated = String(process.env.MEDIA_STREAM_SECRET || '').trim();

function mac(secret) {
  return crypto.createHmac('sha256', secret).update(callSid + ':' + timestamp, 'utf8').digest('base64url');
}

let threw = null;
let sig = null;
try {
  sig = generateMediaAuthSignature(callSid, timestamp);
} catch (err) {
  threw = err.message;
}

const missing = verifyMediaAuthSignature(callSid, timestamp, 'nope');

function health() {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      http.get({ hostname: '127.0.0.1', port, path: '/health' }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          server.close(() => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        });
      }).on('error', (err) => {
        server.close(() => reject(err));
      });
    });
  });
}

health().then((body) => {
  const encoded = JSON.stringify(body);
  const operatorCheck = operator
    ? verifyMediaAuthSignature(callSid, timestamp, mac(operator))
    : { valid: false, error: '' };
  const dedicatedCheck = dedicated
    ? verifyMediaAuthSignature(callSid, timestamp, mac(dedicated))
    : { valid: false, error: '' };
  const report = {
    threw,
    secretEmpty: mediaAuthSecret() === '',
    matchesOperator: Boolean(sig && operator && sig === mac(operator)),
    matchesDedicated: Boolean(sig && dedicated && sig === mac(dedicated)),
    verifyOwn: sig ? verifyMediaAuthSignature(callSid, timestamp, sig).valid : false,
    verifyOperator: operatorCheck.valid,
    verifyOperatorError: operatorCheck.error || '',
    verifyDedicated: dedicatedCheck.valid,
    missingValid: missing.valid,
    missingError: missing.error,
    authRequired: body.authRequired,
    hmacAuth: body.hmacAuth,
    mediaAuthDedicated: body.mediaAuthDedicated,
    healthLeaksOperator: Boolean(operator) && encoded.includes(operator),
    healthLeaksDedicated: Boolean(dedicated) && encoded.includes(dedicated),
  };
  process.stdout.write(JSON.stringify(report));
  setTimeout(() => process.exit(0), 30);
}).catch((err) => {
  process.stderr.write(String(err && err.message ? err.message : err));
  process.exit(1);
});
`;

function probe(env, secrets) {
  const result = spawnSync(process.execPath, ['-e', CHILD], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, env, {
      PROBE_TIMESTAMP: String(Date.now()),
    }),
    encoding: 'utf8',
    timeout: 8000,
  });
  const blob = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (secrets.some((secret) => secret && blob.includes(secret))) {
    fail('child output included a configured secret');
    return null;
  }
  if (result.status !== 0) {
    fail(`child exited ${result.status}`);
    return null;
  }
  try {
    return { report: JSON.parse(result.stdout), stderr: result.stderr || '' };
  } catch (err) {
    fail('child did not return JSON');
    return null;
  }
}

function startupText(env) {
  return spawnSync(
    process.execPath,
    ['-e', 'require("./src/server.js"); setTimeout(() => process.exit(0), 30);'],
    {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, env),
      encoding: 'utf8',
      timeout: 5000,
    }
  );
}

async function main() {
  const callSid = 'call-1';
  const timestamp = String(Date.now());
  const operatorKey = 'operator-test-key';
  const longOperator = 'operator-test-key-padding-0123456789';

  const first = generateMediaAuthSignature(callSid, timestamp);
  process.env.MEDIA_STREAM_SECRET = 'z'.repeat(40);
  process.env.BRIDGE_API_KEY = '';
  const second = generateMediaAuthSignature(callSid, timestamp);
  if (first === hmac(operatorKey, callSid, timestamp) && second === first) {
    pass('startup BRIDGE_API_KEY signs, and later env changes do not');
  } else {
    fail('signature changed after startup or did not use the startup operator key');
  }
  if (verifyMediaAuthSignature(callSid, timestamp, first).valid) {
    pass('startup signature verifies');
  } else {
    fail('startup signature did not verify');
  }
  const wrong = verifyMediaAuthSignature(callSid, timestamp, hmac('other-test-key', callSid, timestamp));
  if (!wrong.valid && wrong.error === 'signature mismatch') {
    pass('a different key is rejected');
  } else {
    fail('expected signature mismatch for a different key');
  }
  const expired = verifyMediaAuthSignature(callSid, String(Date.now() - 10 * 60 * 1000), first);
  if (!expired.valid && expired.error === 'timestamp expired') {
    pass('expired timestamp is rejected');
  } else {
    fail('expected timestamp expiry');
  }

  const health = await getHealth();
  const encoded = JSON.stringify(health);
  if (
    health.mediaAuthDedicated === false &&
    health.hmacAuth === true &&
    health.authRequired === true &&
    !encoded.includes(operatorKey)
  ) {
    pass('in-process health uses the startup operator key and does not echo it');
  } else {
    fail('in-process health flags or leak mismatch');
  }

  const dedicatedSecret = 'media-dedicated-secret-padding-0123456789';
  const dedicated = probe(
    {
      BRIDGE_API_KEY: longOperator,
      MEDIA_STREAM_SECRET: dedicatedSecret,
      ALLOW_UNAUTHENTICATED_OPERATOR: '',
    },
    [longOperator, dedicatedSecret]
  );
  if (
    dedicated &&
    dedicated.report.matchesDedicated &&
    !dedicated.report.matchesOperator &&
    dedicated.report.verifyDedicated &&
    !dedicated.report.verifyOperator &&
    dedicated.report.verifyOperatorError === 'signature mismatch' &&
    dedicated.report.hmacAuth === true &&
    dedicated.report.mediaAuthDedicated === true &&
    dedicated.report.authRequired === true &&
    !dedicated.report.secretEmpty &&
    !dedicated.report.healthLeaksDedicated &&
    !dedicated.report.healthLeaksOperator
  ) {
    pass('dedicated secret signs only when BRIDGE_API_KEY is also set');
  } else {
    fail('dedicated-secret probe did not match');
  }

  const blank = probe(
    {
      BRIDGE_API_KEY: longOperator,
      MEDIA_STREAM_SECRET: '   ',
      ALLOW_UNAUTHENTICATED_OPERATOR: '',
    },
    [longOperator]
  );
  if (
    blank &&
    blank.report.matchesOperator &&
    !blank.report.matchesDedicated &&
    blank.report.verifyOwn &&
    blank.report.mediaAuthDedicated === false &&
    blank.report.hmacAuth === true
  ) {
    pass('blank MEDIA_STREAM_SECRET falls back to BRIDGE_API_KEY');
  } else {
    fail('blank dedicated secret did not fall back');
  }

  const openSecret = 'c'.repeat(40);
  const open = probe(
    {
      BRIDGE_API_KEY: '',
      MEDIA_STREAM_SECRET: openSecret,
      ALLOW_UNAUTHENTICATED_OPERATOR: '1',
    },
    [openSecret]
  );
  if (
    open &&
    open.report.threw === 'BRIDGE_API_KEY is required for HMAC media auth' &&
    open.report.secretEmpty &&
    !open.report.matchesDedicated &&
    !open.report.verifyDedicated &&
    !open.report.missingValid &&
    open.report.missingError === 'media auth secret not configured' &&
    open.report.hmacAuth === false &&
    open.report.mediaAuthDedicated === false &&
    open.report.authRequired === false &&
    open.stderr.includes('UNAVAILABLE because BRIDGE_API_KEY is unset') &&
    !open.stderr.includes('using MEDIA_STREAM_SECRET')
  ) {
    pass('open mode refuses mint and verify even with MEDIA_STREAM_SECRET');
  } else {
    fail('open mode still minted or verified media signatures');
  }

  const shortMedia = 'a'.repeat(31);
  const shortMediaRun = startupText({
    BRIDGE_API_KEY: longOperator,
    MEDIA_STREAM_SECRET: shortMedia,
    ALLOW_UNAUTHENTICATED_OPERATOR: '',
  });
  const shortMediaOut = `${shortMediaRun.stdout || ''}\n${shortMediaRun.stderr || ''}`;
  if (
    shortMediaOut.includes('MEDIA_STREAM_SECRET is shorter than 32 bytes') &&
    !shortMediaOut.includes(shortMedia) &&
    !shortMediaOut.includes(longOperator)
  ) {
    pass('short MEDIA_STREAM_SECRET warns and is not printed');
  } else {
    fail('short MEDIA_STREAM_SECRET warning missing, or a secret was printed');
  }

  const shortOperator = 'b'.repeat(31);
  const shortOperatorRun = startupText({
    BRIDGE_API_KEY: shortOperator,
    MEDIA_STREAM_SECRET: '',
    ALLOW_UNAUTHENTICATED_OPERATOR: '',
  });
  const shortOperatorOut = `${shortOperatorRun.stdout || ''}\n${shortOperatorRun.stderr || ''}`;
  if (
    shortOperatorOut.includes('BRIDGE_API_KEY is shorter than 32 bytes') &&
    !shortOperatorOut.includes(shortOperator)
  ) {
    pass('short BRIDGE_API_KEY warns and is not printed');
  } else {
    fail('short BRIDGE_API_KEY warning missing, or the key was printed');
  }

  const longOut = startupText({
    BRIDGE_API_KEY: longOperator,
    MEDIA_STREAM_SECRET: 'd'.repeat(32),
    ALLOW_UNAUTHENTICATED_OPERATOR: '',
  });
  const longText = `${longOut.stdout || ''}\n${longOut.stderr || ''}`;
  if (!longText.includes('shorter than 32 bytes') && !longText.includes('d'.repeat(32)) && !longText.includes(longOperator)) {
    pass('32-byte secrets do not warn and are not printed');
  } else {
    fail('32-byte secrets warned or were printed');
  }

  const blankOut = startupText({
    BRIDGE_API_KEY: longOperator,
    MEDIA_STREAM_SECRET: '   ',
    ALLOW_UNAUTHENTICATED_OPERATOR: '',
  });
  const blankText = `${blankOut.stdout || ''}\n${blankOut.stderr || ''}`;
  if (!blankText.includes('shorter than 32 bytes') && !blankText.includes(longOperator)) {
    pass('blank MEDIA_STREAM_SECRET does not warn as a short key');
  } else {
    fail('blank MEDIA_STREAM_SECRET warned or the operator key was printed');
  }

  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  if (
    readme.includes('`mediaAuthDedicated` stays') &&
    readme.includes('dedicated `MEDIA_STREAM_SECRET`') &&
    readme.includes('only a boolean')
  ) {
    pass('README explains why /health keeps mediaAuthDedicated');
  } else {
    fail('README does not explain why /health keeps mediaAuthDedicated');
  }

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
