#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

let failed = 0;

function fail(message) {
  console.error(`  ✗ ${message}`);
  failed += 1;
}

function pass(message) {
  console.log(`  ✓ ${message}`);
}

const serverVars = [
  ...new Set([...code.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((match) => match[1])),
].sort();

for (const name of serverVars) {
  if (!example.includes(name)) fail(`.env.example missing ${name}`);
  if (!readme.includes(name)) fail(`README missing ${name}`);
}
pass(`${serverVars.length} src/server.js env vars are named in .env.example and README`);

const exactOne = [
  'ALLOW_UNAUTHENTICATED_OPERATOR',
  'ENABLE_RECORDING',
  'SKIP_AI_DISCLOSURE',
  'LOG_TRANSCRIPTS',
];
for (const name of exactOne) {
  const re = new RegExp(`process\\.env\\.${name}\\s*===\\s*'1'`);
  if (!re.test(code)) fail(`${name} is not compared to exactly '1' in src/server.js`);
  if (!readme.includes('exactly `1`')) fail('README does not describe the exactly `1` flag rule');
}
pass('flag variables are exactly the string 1');

if (!/if\s*\(\s*!BRIDGE_API_KEY\s*&&\s*!ALLOW_UNAUTHENTICATED_OPERATOR\s*\)[\s\S]{0,400}process\.exit\(1\)/.test(code)) {
  fail('startup exit condition was not found');
} else if (!readme.includes('process.exit(1)') || !readme.includes('ALLOW_UNAUTHENTICATED_OPERATOR')) {
  fail('README does not describe the startup exit');
} else {
  pass('README describes the BRIDGE_API_KEY startup exit');
}

if (!/if\s*\(\s*TWILIO_AUTH_TOKEN\s*\)/.test(code) || !code.includes('https://${PUBLIC_HOST}${req.originalUrl}')) {
  fail('Twilio signature check does not match the documented condition');
} else if (!readme.includes('403') || !readme.includes('TWILIO_AUTH_TOKEN') || !readme.includes('PUBLIC_HOST')) {
  fail('README does not describe signature 403s');
} else {
  pass('README describes token-gated signature checks and PUBLIC_HOST 403s');
}

const opsVars = [
  'BRIDGE_HOME',
  'TWILIO_BRIDGE_RUN_DIR',
  'TWILIO_BRIDGE_LOG_DIR',
  'TWILIO_BRIDGE_LOG_MAX_BYTES',
  'CLOUDFLARED_BIN',
  'CLOUDFLARED_CONFIG',
  'TUNNEL_NAME',
  'NODE_BIN',
  'BRIDGE_ENTRY',
  'SKIP_TUNNEL',
  'BRIDGE_ENV_FILE',
  'PROC_ROOT',
  'XDG_RUNTIME_DIR',
];
for (const name of opsVars) {
  if (!readme.includes(name) || !example.includes(name)) {
    fail(`ops variable ${name} missing from README or .env.example`);
  }
}
if (!readme.includes('ops/README.md')) fail('README does not link ops/README.md');
else pass('ops script variables are listed');

const mediaRows = readme.split('\n').filter((line) => line.includes('MEDIA_STREAM_SECRET') && line.includes('|'));
if (mediaRows.length === 0) {
  fail('README is missing a MEDIA_STREAM_SECRET table row');
} else if (!mediaRows.some((line) => line.includes('non-empty') && line.includes('BRIDGE_API_KEY'))) {
  fail('MEDIA_STREAM_SECRET row must say a non-empty dedicated secret wins, otherwise BRIDGE_API_KEY');
} else {
  pass('MEDIA_STREAM_SECRET row documents the fallback');
}

if (readme.includes('media-stream HMAC uses `BRIDGE_API_KEY`')) {
  fail('README still says media-stream HMAC uses only BRIDGE_API_KEY');
}
if (!example.includes('MEDIA_STREAM_SECRET') || !example.includes('non-empty after trim')) {
  fail('.env.example HMAC comment does not describe MEDIA_STREAM_SECRET');
} else {
  pass('.env.example documents the dedicated media HMAC key');
}

if (!readme.includes('The environment value is a string, so `"0"` is kept')) {
  fail('README does not document that numeric env strings keep 0');
} else {
  pass('README documents Number(process.env.NAME || default) and string 0');
}

if (!code.includes(".config({ override: true })")) {
  fail('src/server.js does not load dotenv with override true');
} else if (!readme.includes('values in `.env` replace existing environment variables')) {
  fail('README does not say .env values replace existing environment variables');
} else {
  pass('dotenv override true is documented as .env replacing existing environment variables');
}

if (example.includes('Drop finished sessions') || readme.includes('Drop finished sessions')) {
  fail('SESSION_MAX_AGE_MS is still described as dropping finished sessions');
} else if (!example.includes('hung up') || !example.includes('socket')) {
  fail('.env.example does not describe live hangup versus closed-socket removal');
} else if (!readme.includes('still has a socket open') || !readme.includes('hung up')) {
  fail('README does not describe live hangup for SESSION_MAX_AGE_MS');
} else {
  pass('SESSION_MAX_AGE_MS describes hangup of a live session and removal of closed ones');
}

if (readme.includes('masked either way') || example.includes('masked either way')) {
  fail('docs still say numbers are masked either way');
} else if (readme.includes('without that mask')) {
  fail('README still says Twilio client errors are logged without a mask');
} else if (!readme.includes('err.message') || !readme.includes('E.164 numbers in that text are masked')) {
  fail('README does not say E.164 numbers inside err.message are masked');
} else {
  pass('placed-call and Twilio error logs mask phone numbers');
}

if (!readme.includes('and BRIDGE_API_KEY is set')) {
  fail('README step 2 does not say BRIDGE_API_KEY is set');
} else if (!readme.includes('wss://HOST/media-stream') || !readme.includes('start.customParameters')) {
  fail('README does not describe the bare Stream URL and start parameters');
} else if (readme.includes('Token leakage') || readme.includes('Signature burn') || readme.includes('restored to pending')) {
  fail('README still describes signature restore');
} else if (!readme.includes('unauthenticated until')) {
  fail('README does not say the media socket is unauthenticated until start');
} else {
  pass('README describes the bare Stream URL, start parameters, and unauthenticated sockets');
}

if (!readme.includes('DISABLE_OPENER_ON_CONNECT') || !example.includes('DISABLE_OPENER_ON_CONNECT')) {
  fail('DISABLE_OPENER_ON_CONNECT is missing from the docs');
} else if (!readme.includes('exactly `1` disables') && !readme.includes('Exactly `1` disables')) {
  fail('README does not say exactly 1 disables the connect greeting');
} else {
  pass('DISABLE_OPENER_ON_CONNECT is documented as exactly 1 disables');
}

if (!readme.includes('NEVER_CONNECTED_TIMEOUT_MS') || !example.includes('NEVER_CONNECTED_TIMEOUT_MS')) {
  fail('NEVER_CONNECTED_TIMEOUT_MS is missing from the docs');
} else if (!readme.includes('never connected')) {
  fail('README does not keep a never-connected session out of the early sweep');
} else {
  pass('never-connected sessions are documented');
}

if (!readme.includes('not minted or verified') || !readme.includes('even if `MEDIA_STREAM_SECRET` is set')) {
  fail('README does not refuse media HMAC when BRIDGE_API_KEY is unset');
} else if (!example.includes('not minted or verified')) {
  fail('.env.example does not refuse media HMAC when BRIDGE_API_KEY is unset');
} else {
  pass('media HMAC is documented as requiring BRIDGE_API_KEY');
}

if (failed > 0) {
  console.error(`\n${failed} env doc check(s) failed`);
  process.exit(1);
}
console.log('\n✓ Env documentation matches src/server.js');
