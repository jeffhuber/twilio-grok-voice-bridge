#!/usr/bin/env node
'use strict';

process.env.BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || 'operator-test-key';
process.env.PUBLIC_HOST = process.env.PUBLIC_HOST || 'bridge.example.com';
delete process.env.XAI_API_KEY;

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const {
  buildConnectTwiml,
  mintMediaAuth,
  authorizeMediaStart,
  applyMediaStart,
  createSession,
  server,
  MEDIA_WS_MAX_PAYLOAD,
  MEDIA_START_TIMEOUT_MS,
  MAX_AWAITING_MEDIA_SOCKETS,
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/media-stream`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitClose(ws, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('close timed out')), ms);
    ws.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitUntil(predicate, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error('condition timed out');
}

function captureConsole() {
  const lines = [];
  const originals = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  for (const level of Object.keys(originals)) {
    console[level] = (...args) => {
      lines.push(args.map((part) => String(part)).join(' '));
      originals[level](...args);
    };
  }
  return {
    lines,
    restore() {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
    },
  };
}

async function main() {
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

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const logs = captureConsole();

  try {
    const marker = 'prestart-marker-not-a-twilio-event';
    const early = await connect(port);
    const earlyClose = waitClose(early, 2000);
    early.send(JSON.stringify({ event: marker, media: { payload: 'aa' } }));
    const earlyCode = await earlyClose;
    if (earlyCode === 1008 && !logs.lines.some((line) => line.includes(marker))) {
      pass('first non-start frame closes 1008 without logging the event name');
    } else {
      fail(`pre-start frame result code=${earlyCode}`);
    }

    const twilioSession = createSession({ callSid: 'call-twilio', goal: 'Say hello' });
    const twilioMint = mintMediaAuth(twilioSession, 'call-twilio');
    const twilioWs = await connect(port);
    twilioWs.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
    await delay(50);
    if (twilioWs.readyState !== WebSocket.OPEN) {
      fail('Twilio connected event closed the socket');
    } else {
      twilioWs.send(JSON.stringify(startMessage('call-twilio', twilioMint.timestamp, twilioMint.signature)));
      await waitUntil(() => twilioSession.streamSid === 'stream-1', 1000);
      if (twilioSession.twilioWs && twilioSession.twilioWs.readyState === WebSocket.OPEN) {
        pass('connected then start binds through the connection handler');
      } else {
        fail('connected then start did not bind');
      }
      twilioWs.close();
      await waitUntil(() => !twilioSession.twilioWs, 1000);
    }

    const replaySession = createSession({ callSid: 'call-replay', goal: 'Say hello' });
    const replayMint = mintMediaAuth(replaySession, 'call-replay');
    const first = await connect(port);
    first.send(JSON.stringify(startMessage('call-replay', replayMint.timestamp, replayMint.signature)));
    await waitUntil(() => replaySession.streamSid === 'stream-1', 1000);
    first.close();
    await waitUntil(() => !replaySession.twilioWs, 1000);
    const second = await connect(port);
    const replayClose = waitClose(second, 2000);
    second.send(JSON.stringify(startMessage('call-replay', replayMint.timestamp, replayMint.signature)));
    const replayCode = await replayClose;
    if (replayCode === 1008 && !replaySession.twilioWs) {
      pass('replay through a second socket is rejected');
    } else {
      fail(`replay socket code=${replayCode} stillBound=${Boolean(replaySession.twilioWs)}`);
    }

    const startMismatch = createSession({ callSid: 'call-start-mismatch', goal: 'Say hello' });
    const startMint = mintMediaAuth(startMismatch, 'call-start-mismatch');
    const startMsg = startMessage('call-start-mismatch', startMint.timestamp, startMint.signature);
    startMsg.start.callSid = 'other-sid';
    const startWs = await connect(port);
    const startClose = waitClose(startWs, 2000);
    startWs.send(JSON.stringify(startMsg));
    const startCode = await startClose;
    if (startCode === 1008 && !startMismatch.twilioWs) {
      pass('start.callSid mismatch closes the socket');
    } else {
      fail(`start.callSid mismatch code=${startCode}`);
    }

    const entryMismatch = createSession({ callSid: 'call-entry-mismatch', goal: 'Say hello' });
    const entryMint = mintMediaAuth(entryMismatch, 'call-entry-mismatch');
    entryMismatch.callSid = 'changed-after-mint';
    const entryWs = await connect(port);
    const entryClose = waitClose(entryWs, 2000);
    entryWs.send(JSON.stringify(startMessage('call-entry-mismatch', entryMint.timestamp, entryMint.signature)));
    const entryCode = await entryClose;
    if (entryCode === 1008 && !entryMismatch.twilioWs) {
      pass('pending session callSid mismatch closes the socket');
    } else {
      fail(`entry callSid mismatch code=${entryCode}`);
    }

    const idle = await connect(port);
    const idleStarted = Date.now();
    const idleCode = await waitClose(idle, MEDIA_START_TIMEOUT_MS + 2000);
    const idleElapsed = Date.now() - idleStarted;
    if (idleCode === 1008 && idleElapsed >= MEDIA_START_TIMEOUT_MS - 250) {
      pass('unbound socket closes after the start timeout');
    } else {
      fail(`timeout close code=${idleCode} elapsed=${idleElapsed}`);
    }

    const huge = await connect(port);
    const hugeClose = waitClose(huge, 2000);
    huge.send(Buffer.alloc(MEDIA_WS_MAX_PAYLOAD + 1024, 0x61));
    const hugeCode = await hugeClose;
    if (hugeCode === 1009) {
      pass('oversized frame is rejected before JSON parse');
    } else {
      fail(`oversized frame close code=${hugeCode}`);
    }

    const openSockets = [];
    for (let i = 0; i < MAX_AWAITING_MEDIA_SOCKETS; i += 1) {
      openSockets.push(await connect(port));
    }
    const overflowCode = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/media-stream`);
      const timer = setTimeout(() => reject(new Error('cap close timed out')), 2000);
      ws.on('error', () => {});
      ws.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    if (overflowCode === 1008 && openSockets.every((sock) => sock.readyState === WebSocket.OPEN)) {
      pass('awaiting-start sockets are capped');
    } else {
      fail(`cap close code=${overflowCode}`);
    }
    for (const sock of openSockets) sock.close();
  } finally {
    logs.restore();
    await new Promise((resolve) => server.close(resolve));
  }

  if (failed > 0) {
    console.error(`\n${failed} media stream URL test(s) failed`);
    process.exit(1);
  }
  console.log('\n✓ All media stream URL tests passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
