#!/usr/bin/env node
'use strict';

process.env.BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || 'operator-test-key';
process.env.PUBLIC_HOST = process.env.PUBLIC_HOST || 'bridge.example.com';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'twilio-test-token';
delete process.env.XAI_API_KEY;

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const twilio = require('twilio');
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
  MAX_AWAITING_MEDIA_SOCKETS_PER_CLIENT,
  MEDIA_PREBIND_TERMINATE_MS,
  mediaClientKey,
  noteUnauthMediaClose,
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

function connect(port, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/media-stream`, headers ? { headers } : undefined);
    let opened = false;
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      reject(new Error('open timed out'));
    }, 2000);
    ws.on('open', () => {
      opened = true;
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (err) => {
      if (opened) return;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function connectExpectClose(port, headers, ms) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/media-stream`, headers ? { headers } : undefined);
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      resolve({ code: null, timedOut: true });
    }, ms);
    ws.on('error', () => {});
    ws.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut: false });
    });
  });
}

function wsTextFrame(text) {
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
}

function rawUpgrade(port, headers) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(port, '127.0.0.1');
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('raw upgrade timed out'));
    }, 2000);
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('connect', () => {
      let req = `GET /media-stream HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`;
      if (headers) {
        for (const name of Object.keys(headers)) req += `${name}: ${headers[name]}\r\n`;
      }
      req += '\r\n';
      socket.write(req);
    });
    let buf = Buffer.alloc(0);
    let handshake = false;
    socket.on('data', (chunk) => {
      if (handshake) return;
      buf = Buffer.concat([buf, chunk]);
      if (!buf.includes('\r\n\r\n')) return;
      handshake = true;
      clearTimeout(timer);
      resolve(socket);
    });
  });
}

function waitSocketDead(socket, ms) {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve({ dead: true, timedOut: false });
      return;
    }
    const timer = setTimeout(() => resolve({ dead: false, timedOut: true }), ms);
    const done = () => {
      clearTimeout(timer);
      resolve({ dead: true, timedOut: false });
    };
    socket.once('close', done);
    socket.once('error', done);
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

  const spoofed = mediaClientKey({
    socket: { remoteAddress: '203.0.113.8' },
    headers: { 'cf-connecting-ip': '198.51.100.9' },
  });
  if (spoofed === 'ip:203.0.113.8') {
    pass('CF-Connecting-IP is ignored unless the peer is loopback');
  } else {
    fail(`untrusted client key was ${spoofed}`);
  }
  const tunneled = mediaClientKey({
    socket: { remoteAddress: '::ffff:127.0.0.1' },
    headers: { 'cf-connecting-ip': '198.51.100.9' },
  });
  if (tunneled === 'cf:198.51.100.9') {
    pass('a loopback peer uses CF-Connecting-IP');
  } else {
    fail(`tunnel client key was ${tunneled}`);
  }
  const plainLoop = mediaClientKey({ socket: { remoteAddress: '127.0.0.1' }, headers: {} });
  if (plainLoop === 'ip:127.0.0.1') {
    pass('loopback without CF-Connecting-IP uses the remote address');
  } else {
    fail(`plain loopback key was ${plainLoop}`);
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
  const held = [];

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

    const eviction = [];
    for (let i = 0; i < MAX_AWAITING_MEDIA_SOCKETS; i += 1) {
      const sock = await connect(port, { 'CF-Connecting-IP': `203.0.113.${i + 1}` });
      eviction.push(sock);
      held.push(sock);
    }
    let oldestCode = null;
    let oldestTimedOut = false;
    const oldestWait = waitClose(eviction[0], 2000).then(
      (code) => {
        oldestCode = code;
      },
      () => {
        oldestTimedOut = true;
      }
    );
    const newest = await connect(port, { 'CF-Connecting-IP': '203.0.113.200' });
    held.push(newest);
    await oldestWait;
    if (!oldestTimedOut && oldestCode === 1008 && newest.readyState === WebSocket.OPEN) {
      pass('a full global cap evicts the oldest unbound socket');
    } else {
      fail(`eviction code=${oldestCode} timedOut=${oldestTimedOut} newest=${newest.readyState}`);
    }
    for (const sock of eviction) {
      try {
        sock.close();
      } catch {
        /* ignore */
      }
    }
    newest.close();

    const clientIp = '198.51.100.10';
    const sameClient = [];
    for (let i = 0; i < MAX_AWAITING_MEDIA_SOCKETS_PER_CLIENT; i += 1) {
      const sock = await connect(port, { 'CF-Connecting-IP': clientIp });
      sameClient.push(sock);
      held.push(sock);
    }
    const blocked = await connectExpectClose(port, { 'CF-Connecting-IP': clientIp }, 2000);
    if (!blocked.timedOut && blocked.code === 1008 && sameClient.every((sock) => sock.readyState === WebSocket.OPEN)) {
      pass('one client cannot hold more than the per-client unbound cap');
    } else {
      fail(`per-client cap result ${JSON.stringify(blocked)}`);
    }

    const signedUrl = `wss://${process.env.PUBLIC_HOST}/media-stream`;
    const twilioSignature = twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN, signedUrl, {});
    const signed = await connect(port, {
      'CF-Connecting-IP': clientIp,
      'X-Twilio-Signature': twilioSignature,
    });
    held.push(signed);
    if (signed.readyState === WebSocket.OPEN) {
      pass('a valid X-Twilio-Signature does not count toward the per-client cap');
    } else {
      fail('signed upgrade was capped');
    }
    const bogus = await connectExpectClose(
      port,
      { 'CF-Connecting-IP': clientIp, 'X-Twilio-Signature': 'not-a-signature' },
      2000
    );
    if (!bogus.timedOut && bogus.code === 1008) {
      pass('an invalid X-Twilio-Signature still counts toward the per-client cap');
    } else {
      fail(`invalid signature cap result ${JSON.stringify(bogus)}`);
    }
    for (const sock of sameClient) sock.close();
    signed.close();

    const rawIp = '198.51.100.40';
    const rawStarted = Date.now();
    const raws = [];
    for (let i = 0; i < MAX_AWAITING_MEDIA_SOCKETS_PER_CLIENT; i += 1) {
      const raw = await rawUpgrade(port, { 'CF-Connecting-IP': rawIp });
      raws.push(raw);
      held.push(raw);
      raw.write(wsTextFrame(JSON.stringify({ event: 'not-a-start' })));
    }
    const deaths = await Promise.all(
      raws.map((raw) => waitSocketDead(raw, MEDIA_PREBIND_TERMINATE_MS + 1500))
    );
    const rawElapsed = Date.now() - rawStarted;
    if (deaths.every((item) => item.dead && !item.timedOut) && rawElapsed < 4000) {
      pass('a client that ignores the close handshake is terminated');
    } else {
      fail(`silent close handshake held the socket elapsed=${rawElapsed}`);
    }
    let resumed = null;
    try {
      resumed = await connect(port, { 'CF-Connecting-IP': rawIp });
      held.push(resumed);
      await delay(300);
    } catch (err) {
      fail(`slot still held after a silent close: ${err.message}`);
    }
    if (resumed && resumed.readyState === WebSocket.OPEN) {
      pass('the same client can connect again once terminate frees the cap');
    } else if (resumed) {
      fail('the follow-up socket was closed; the per-client slot was still held');
    }
    if (resumed) resumed.close();

    await delay(1100);
    const countLines = (needle) => logs.lines.filter((line) => line.includes(needle)).length;
    const warnsBeforeDirect = countLines('closed media socket before a bound start');
    noteUnauthMediaClose();
    noteUnauthMediaClose();
    noteUnauthMediaClose();
    const directWarns = countLines('closed media socket before a bound start') - warnsBeforeDirect;
    if (directWarns === 1) {
      pass('noteUnauthMediaClose emits one warning per second');
    } else {
      fail(`noteUnauthMediaClose emitted ${directWarns} warnings`);
    }

    await delay(1100);
    const warnsAtBurst = countLines('closed media socket before a bound start');
    const rejectsAtBurst = countLines('[twilio] media start rejected:');
    const wsErrAtBurst = countLines('[twilio] ws error:');
    const burst = [];
    for (let i = 0; i < 5; i += 1) {
      const sock = await connect(port, { 'CF-Connecting-IP': `198.51.100.${50 + i}` });
      burst.push(sock);
      held.push(sock);
    }
    for (const sock of burst) {
      sock.send(JSON.stringify({ event: 'prestart-marker-not-a-twilio-event' }));
    }

    const rejectSession = createSession({ callSid: 'call-log-limit', goal: 'Say hello' });
    const rejectMint = mintMediaAuth(rejectSession, 'call-log-limit');
    const badSig = rejectMint.signature.slice(0, -1) + (rejectMint.signature.endsWith('a') ? 'b' : 'a');
    for (let i = 0; i < 2; i += 1) {
      const sock = await connect(port, { 'CF-Connecting-IP': `198.51.100.${80 + i}` });
      held.push(sock);
      sock.send(JSON.stringify(startMessage('call-log-limit', rejectMint.timestamp, badSig)));
    }
    for (let i = 0; i < 3; i += 1) {
      const sock = await connect(port, { 'CF-Connecting-IP': `198.51.100.${90 + i}` });
      held.push(sock);
      sock.send(Buffer.alloc(MEDIA_WS_MAX_PAYLOAD + 64, 0x61));
    }
    await delay(300);
    const newWarns = countLines('closed media socket before a bound start') - warnsAtBurst;
    const newRejects = countLines('[twilio] media start rejected:') - rejectsAtBurst;
    const newWsErr = countLines('[twilio] ws error:') - wsErrAtBurst;
    const burstLines = logs.lines.slice(logs.lines.length - 30);
    if (newWarns === 1 && !burstLines.some((line) => line.includes('prestart-marker-not-a-twilio-event'))) {
      pass('handler pre-bind closes go through noteUnauthMediaClose once per second');
    } else {
      fail(`pre-bind warning count ${newWarns}`);
    }
    if (newRejects === 1) {
      pass('media start rejected is logged at most once per second');
    } else {
      fail(`media start rejected count ${newRejects}`);
    }
    if (newWsErr === 1) {
      pass('ws error is logged at most once per second');
    } else {
      fail(`ws error count ${newWsErr}`);
    }
  } finally {
    for (const sock of held) {
      try {
        if (typeof sock.terminate === 'function') sock.terminate();
        else sock.destroy();
      } catch {
        /* ignore */
      }
    }
    logs.restore();
    await Promise.race([
      new Promise((resolve) => server.close(resolve)),
      delay(1000),
    ]);
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
