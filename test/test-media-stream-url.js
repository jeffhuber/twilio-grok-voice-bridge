#!/usr/bin/env node
'use strict';

process.env.BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || 'operator-test-key';
process.env.PUBLIC_HOST = process.env.PUBLIC_HOST || 'bridge.example.com';

const fs = require('fs');
const path = require('path');
const {
  buildConnectTwiml,
  mintMediaAuth,
  authorizeMediaStart,
  applyMediaStart,
  createSession,
} = require('../src/server.js');

let failed = 0;

function fail(message) {
  console.error(`  ✗ ${message}`);
  failed += 1;
}

function pass(message) {
  console.log(`  ✓ ${message}`);
}

function startMessage(callSid, timestamp, signature, extra) {
  const custom = {
    callSid,
    timestamp: String(timestamp),
    signature,
  };
  return {
    event: 'start',
    streamSid: 'stream-1',
    start: {
      callSid,
      streamSid: 'stream-1',
      customParameters: extra === 'omit' ? {} : { ...custom, ...(extra || {}) },
    },
    query: 'callSid=from-query&signature=from-query',
  };
}

function main() {
  const source = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  const upgradeStart = source.indexOf("server.on('upgrade'");
  const connectionStart = source.indexOf("wss.on('connection'");
  const upgrade = source.slice(upgradeStart, connectionStart);
  if (!upgrade.includes('searchParams') && upgrade.includes("/media-stream")) {
    pass('upgrade handler does not read query params');
  } else {
    fail('upgrade handler still depends on query params');
  }
  const connection = source.slice(connectionStart, source.indexOf('server.listen'));
  if (!connection.includes('searchParams')) {
    pass('media-stream connection handler does not read query params');
  } else {
    fail('connection handler still reads query params');
  }

  const xml = buildConnectTwiml({
    goal: 'Confirm a reservation',
    context: '',
    voice: 'ara',
    style: 'support',
    softContinue: false,
    callSid: 'call-1',
    timestamp: 1700000000000,
    signature: 'sig-test',
  });
  const urlMatch = xml.match(/<Stream[^>]*\surl="([^"]*)"/);
  if (!urlMatch) {
    fail(`stream url attribute missing in ${xml}`);
  } else if (urlMatch[1].includes('?') || urlMatch[1].includes('&')) {
    fail(`stream url contains a query string: ${urlMatch[1]}`);
  } else if (urlMatch[1] !== 'wss://bridge.example.com/media-stream') {
    fail(`unexpected stream url: ${urlMatch[1]}`);
  } else {
    pass('generated TwiML stream url has no query string');
  }
  if (xml.includes('name="callSid"') && xml.includes('name="timestamp"') && xml.includes('name="signature"')) {
    pass('auth values are Parameter elements');
  } else {
    fail('auth Parameter elements missing');
  }

  const session = createSession({ callSid: 'call-1', goal: 'Say hello' });
  const minted = mintMediaAuth(session, 'call-1');
  let opened = 0;
  const ws = { readyState: 1 };
  const bound = applyMediaStart(ws, startMessage('call-1', minted.timestamp, minted.signature), {
    openGrokSession() {
      opened += 1;
    },
  });
  if (bound.ok && bound.session === session && session.twilioWs === ws && session.streamSid === 'stream-1' && opened === 1) {
    pass('valid start customParameters bind the socket');
  } else {
    fail(`valid start did not bind: ${JSON.stringify({ ok: bound.ok, error: bound.error, opened, streamSid: session.streamSid })}`);
  }

  const replay = authorizeMediaStart(startMessage('call-1', minted.timestamp, minted.signature));
  if (!replay.ok && replay.error === 'signature replayed') {
    pass('replayed signature is rejected');
  } else {
    fail(`replay result: ${JSON.stringify(replay)}`);
  }

  const missingSession = createSession({ callSid: 'call-2', goal: 'Say hello' });
  mintMediaAuth(missingSession, 'call-2');
  const missing = authorizeMediaStart({
    event: 'start',
    start: { callSid: 'call-2', customParameters: {} },
    query: 'signature=should-not-count',
  });
  if (!missing.ok && missing.error === 'missing auth params') {
    pass('missing customParameters are rejected');
  } else {
    fail(`missing result: ${JSON.stringify(missing)}`);
  }

  const invalidSession = createSession({ callSid: 'call-3', goal: 'Say hello' });
  const invalidMint = mintMediaAuth(invalidSession, 'call-3');
  const badSig = invalidMint.signature.slice(0, -1) + (invalidMint.signature.endsWith('a') ? 'b' : 'a');
  const invalid = authorizeMediaStart(startMessage('call-3', invalidMint.timestamp, badSig));
  if (!invalid.ok && invalid.error === 'signature mismatch') {
    pass('invalid signature is rejected');
  } else {
    fail(`invalid result: ${JSON.stringify(invalid)}`);
  }

  const expiredSession = createSession({ callSid: 'call-4', goal: 'Say hello' });
  const expiredMint = mintMediaAuth(expiredSession, 'call-4', Date.now() - 130000);
  const expired = authorizeMediaStart(startMessage('call-4', expiredMint.timestamp, expiredMint.signature));
  if (!expired.ok && expired.error === 'timestamp expired') {
    pass('expired timestamp is rejected');
  } else {
    fail(`expired result: ${JSON.stringify(expired)}`);
  }

  if (failed > 0) {
    console.error(`\n${failed} media stream URL test(s) failed`);
    process.exit(1);
  }
  console.log('\n✓ All media stream URL tests passed');
  process.exit(0);
}

main();
