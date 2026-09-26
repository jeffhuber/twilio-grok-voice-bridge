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
  MAX_AWAITING_SIGNED_MEDIA_SOCKETS,
  MAX_AWAITING_SIGNED_MEDIA_SOCKETS_PER_CLIENT,
  MEDIA_PREBIND_TERMINATE_MS,
  mediaClientKey,
  noteUnauthMediaClose,
  maskPhoneNumbersInText,
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
      const names = headers ? Object.keys(headers) : [];
      const hasHost = names.some((name) => name.toLowerCase() === 'host');
      let req = 'GET /media-stream HTTP/1.1\r\n';
      if (!hasHost) req += `Host: 127.0.0.1:${port}\r\n`;
      req += `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`;
      for (const name of names) req += `${name}: ${headers[name]}\r\n`;
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

function waitClose(ws, ms, label) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => {
      fail(`${label || 'socket'}: close timed out`);
      finish(null);
    }, ms);
    ws.once('close', (code) => finish(code));
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
  const v6a = mediaClientKey({
    socket: { remoteAddress: '2001:db8:10:20::1' },
    headers: { 'cf-connecting-ip': '198.51.100.9' },
  });
  const v6b = mediaClientKey({
    socket: { remoteAddress: '2001:DB8:10:20:ffff::abcd' },
    headers: {},
  });
  const v6other = mediaClientKey({
    socket: { remoteAddress: '2001:db8:10:21::1' },
    headers: {},
  });
  const v6tunneled = mediaClientKey({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'cf-connecting-ip': '2001:db8:10:20::99' },
  });
  if (
    v6a === 'ip:2001:0db8:0010:0020' &&
    v6a === v6b &&
    v6a !== v6other &&
    v6tunneled === 'cf:2001:0db8:0010:0020' &&
    v6other === 'ip:2001:0db8:0010:0021'
  ) {
    pass('IPv6 clients share a /64 key');
  } else {
    fail(`ipv6 keys ${v6a} ${v6b} ${v6other} ${v6tunneled}`);
  }
  const maskedLog = maskPhoneNumbersInText(
    'dial 555-0100 from 203.0.113.50 on 2026-09-26 at 1727350123456'
  );
  if (
    !maskedLog.includes('555-0100') &&
    maskedLog.includes('0100') &&
    maskedLog.includes('203.0.113.50') &&
    maskedLog.includes('2026-09-26') &&
    maskedLog.includes('1727350123456')
  ) {
    pass('log masking keeps IPv4 addresses, dates, and millisecond timestamps');
  } else {
    fail(`mask result ${maskedLog}`);
  }
  const plus86 = maskPhoneNumbersInText('failed for +8613800000000 and +86 138 0000 0000 today');
  const plus49 = maskPhoneNumbersInText('failed for +4930123456789 today');
  const outsideEpoch = maskPhoneNumbersInText('id 8613800000000 and 2100000000001');
  const plusEpoch = maskPhoneNumbersInText('stamp +1727350123456');
  const epochCeiling = maskPhoneNumbersInText('edge 2100000000000');
  if (
    !plus86.includes('+8613800000000') &&
    !plus86.includes('+86') &&
    !plus86.includes('138') &&
    plus86.includes('0000') &&
    !plus49.includes('+4930123456789') &&
    plus49.includes('6789') &&
    !outsideEpoch.includes('8613800000000') &&
    !outsideEpoch.includes('2100000000001') &&
    !plusEpoch.includes('+1727350123456') &&
    plusEpoch.includes('3456') &&
    epochCeiling.includes('2100000000000')
  ) {
    pass('a leading plus is masked, including the country code, and only in-range epoch values stay');
  } else {
    fail(`international mask ${plus86} | ${plus49} | ${outsideEpoch} | ${plusEpoch} | ${epochCeiling}`);
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
    const earlyClose = waitClose(early, 2000, 'first non-start frame');
    early.send(JSON.stringify({ event: marker, media: { payload: 'aa' } }));
    const earlyCode = await earlyClose;
    if (earlyCode === 1008 && !logs.lines.some((line) => line.includes(marker))) {
      pass('first non-start frame closes 1008 without logging the event name');
    } else if (earlyCode !== null) {
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
    const replayClose = waitClose(second, 2000, 'replayed start');
    second.send(JSON.stringify(startMessage('call-replay', replayMint.timestamp, replayMint.signature)));
    const replayCode = await replayClose;
    if (replayCode === 1008 && !replaySession.twilioWs) {
      pass('replay through a second socket is rejected');
    } else if (replayCode !== null) {
      fail(`replay socket code=${replayCode} stillBound=${Boolean(replaySession.twilioWs)}`);
    }

    const startMismatch = createSession({ callSid: 'call-start-mismatch', goal: 'Say hello' });
    const startMint = mintMediaAuth(startMismatch, 'call-start-mismatch');
    const startMsg = startMessage('call-start-mismatch', startMint.timestamp, startMint.signature);
    startMsg.start.callSid = 'other-sid';
    const startWs = await connect(port);
    const startClose = waitClose(startWs, 2000, 'start.callSid mismatch');
    startWs.send(JSON.stringify(startMsg));
    const startCode = await startClose;
    if (startCode === 1008 && !startMismatch.twilioWs) {
      pass('start.callSid mismatch closes the socket');
    } else if (startCode !== null) {
      fail(`start.callSid mismatch code=${startCode}`);
    }

    const entryMismatch = createSession({ callSid: 'call-entry-mismatch', goal: 'Say hello' });
    const entryMint = mintMediaAuth(entryMismatch, 'call-entry-mismatch');
    entryMismatch.callSid = 'changed-after-mint';
    const entryWs = await connect(port);
    const entryClose = waitClose(entryWs, 2000, 'pending callSid mismatch');
    entryWs.send(JSON.stringify(startMessage('call-entry-mismatch', entryMint.timestamp, entryMint.signature)));
    const entryCode = await entryClose;
    if (entryCode === 1008 && !entryMismatch.twilioWs) {
      pass('pending session callSid mismatch closes the socket');
    } else if (entryCode !== null) {
      fail(`entry callSid mismatch code=${entryCode}`);
    }

    const idle = await connect(port);
    const idleStarted = Date.now();
    const idleCode = await waitClose(idle, MEDIA_START_TIMEOUT_MS + 2000, 'start timeout');
    const idleElapsed = Date.now() - idleStarted;
    if (idleCode === 1008 && idleElapsed >= MEDIA_START_TIMEOUT_MS - 250) {
      pass('unbound socket closes after the start timeout');
    } else if (idleCode !== null) {
      fail(`timeout close code=${idleCode} elapsed=${idleElapsed}`);
    }

    const huge = await connect(port);
    const hugeClose = waitClose(huge, 2000, 'oversized frame');
    huge.send(Buffer.alloc(MEDIA_WS_MAX_PAYLOAD + 1024, 0x61));
    const hugeCode = await hugeClose;
    if (hugeCode === 1009) {
      pass('oversized frame is rejected before JSON parse');
    } else if (hugeCode !== null) {
      fail(`oversized frame close code=${hugeCode}`);
    }

    const signedUrl = `wss://${process.env.PUBLIC_HOST}/media-stream`;
    const twilioSignature = twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN, signedUrl, {});
    const signedKeep = await connect(port, {
      'CF-Connecting-IP': '203.0.113.250',
      'X-Twilio-Signature': twilioSignature,
    });
    held.push(signedKeep);
    const eviction = [];
    for (let i = 0; i < MAX_AWAITING_MEDIA_SOCKETS; i += 1) {
      const sock = await connect(port, { 'CF-Connecting-IP': `203.0.113.${i + 1}` });
      eviction.push(sock);
      held.push(sock);
    }
    const oldestWait = waitClose(eviction[0], 2000, 'oldest unbound eviction');
    const newest = await connect(port, { 'CF-Connecting-IP': '203.0.113.200' });
    held.push(newest);
    const oldestCode = await oldestWait;
    if (
      oldestCode === 1008 &&
      newest.readyState === WebSocket.OPEN &&
      signedKeep.readyState === WebSocket.OPEN
    ) {
      pass('a full global cap evicts the oldest unbound socket');
    } else if (oldestCode !== null) {
      fail(`eviction code=${oldestCode} newest=${newest.readyState} signed=${signedKeep.readyState}`);
    }
    for (const sock of eviction) {
      try {
        sock.close();
      } catch {
        /* ignore */
      }
    }
    newest.close();
    signedKeep.close();

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

    const signed = await connect(port, {
      'CF-Connecting-IP': clientIp,
      'X-Twilio-Signature': twilioSignature,
    });
    held.push(signed);
    if (signed.readyState === WebSocket.OPEN) {
      pass('a valid X-Twilio-Signature does not count toward the unsigned per-client cap');
    } else {
      fail('signed upgrade was capped by the unsigned pool');
    }
    const bogus = await connectExpectClose(
      port,
      { 'CF-Connecting-IP': clientIp, 'X-Twilio-Signature': 'not-a-signature' },
      2000
    );
    const bogusLog = logs.lines.filter((line) => line.includes('media upgrade signature rejected')).join('\n');
    if (!bogus.timedOut && bogus.code === 1008) {
      pass('an invalid X-Twilio-Signature still counts toward the per-client cap');
    } else {
      fail(`invalid signature cap result ${JSON.stringify(bogus)}`);
    }
    if (bogusLog.includes('media upgrade signature rejected') && !bogusLog.includes('not-a-signature') && !bogusLog.includes(process.env.TWILIO_AUTH_TOKEN)) {
      pass('a failed X-Twilio-Signature is logged without the header or auth token');
    } else {
      fail(`signature reject log was ${JSON.stringify(bogusLog)}`);
    }
    for (const sock of sameClient) sock.close();
    signed.close();

    const v6Client = [];
    for (let i = 1; i <= MAX_AWAITING_MEDIA_SOCKETS_PER_CLIENT; i += 1) {
      const sock = await connect(port, { 'CF-Connecting-IP': `2001:db8:10:30::${i}` });
      v6Client.push(sock);
      held.push(sock);
    }
    const v6Blocked = await connectExpectClose(port, { 'CF-Connecting-IP': '2001:db8:10:30::99' }, 2000);
    const v6Other = await connect(port, { 'CF-Connecting-IP': '2001:db8:10:31::1' });
    held.push(v6Other);
    if (
      !v6Blocked.timedOut &&
      v6Blocked.code === 1008 &&
      v6Client.every((sock) => sock.readyState === WebSocket.OPEN) &&
      v6Other.readyState === WebSocket.OPEN
    ) {
      pass('IPv6 addresses in one /64 share the per-client cap');
    } else {
      fail(`ipv6 cap result ${JSON.stringify(v6Blocked)} other=${v6Other.readyState}`);
    }
    for (const sock of v6Client) sock.close();
    v6Other.close();

    if (
      MAX_AWAITING_SIGNED_MEDIA_SOCKETS_PER_CLIENT === 8 &&
      MAX_AWAITING_SIGNED_MEDIA_SOCKETS === 128
    ) {
      pass('signed pre-bind pool caps are 8 per client and 128 global');
    } else {
      fail(
        `signed caps ${MAX_AWAITING_SIGNED_MEDIA_SOCKETS_PER_CLIENT}/${MAX_AWAITING_SIGNED_MEDIA_SOCKETS}`
      );
    }
    const replayPrefix = '2001:db8:40:50';
    const boundSession = createSession({ callSid: 'call-signed-bound', goal: 'Say hello' });
    const boundMint = mintMediaAuth(boundSession, 'call-signed-bound');
    const boundSock = await connect(port, {
      'CF-Connecting-IP': `${replayPrefix}::1`,
      'X-Twilio-Signature': twilioSignature,
    });
    held.push(boundSock);
    boundSock.send(JSON.stringify(startMessage('call-signed-bound', boundMint.timestamp, boundMint.signature)));
    await waitUntil(() => boundSession.streamSid === 'stream-1' && boundSession.twilioWs, 1000);
    const signedPool = [];
    for (let i = 0; i < MAX_AWAITING_SIGNED_MEDIA_SOCKETS_PER_CLIENT; i += 1) {
      const sock = await connect(port, {
        'CF-Connecting-IP': `${replayPrefix}::${i + 2}`,
        'X-Twilio-Signature': twilioSignature,
      });
      signedPool.push(sock);
      held.push(sock);
    }
    const otherPrefixSock = await connect(port, {
      'CF-Connecting-IP': '2001:db8:40:51::1',
      'X-Twilio-Signature': twilioSignature,
    });
    held.push(otherPrefixSock);
    const oldestSignedWait = waitClose(signedPool[0], 2000, 'signed pool oldest');
    const ninth = await connect(port, {
      'CF-Connecting-IP': `${replayPrefix}::ff`,
      'X-Twilio-Signature': twilioSignature,
    });
    held.push(ninth);
    const oldestSignedCode = await oldestSignedWait;
    const signedStillOpen = signedPool.slice(1).every((sock) => sock.readyState === WebSocket.OPEN);
    if (
      oldestSignedCode === 1008 &&
      ninth.readyState === WebSocket.OPEN &&
      signedStillOpen &&
      boundSock.readyState === WebSocket.OPEN &&
      boundSession.twilioWs &&
      boundSession.twilioWs.readyState === WebSocket.OPEN &&
      otherPrefixSock.readyState === WebSocket.OPEN
    ) {
      pass('a replayed Twilio signature evicts the oldest unbound socket in that signed pool');
    } else if (oldestSignedCode !== null) {
      fail(
        `signed pool code=${oldestSignedCode} ninth=${ninth.readyState} rest=${signedStillOpen} bound=${boundSock.readyState} other=${otherPrefixSock.readyState}`
      );
    }
    boundSock.close();
    for (const sock of signedPool) sock.close();
    otherPrefixSock.close();
    ninth.close();
    await delay(150);

    const victim = await connect(port, {
      'CF-Connecting-IP': '2001:db8:81:1::1',
      'X-Twilio-Signature': twilioSignature,
    });
    held.push(victim);
    const signedSameClient = [];
    for (let i = 1; i <= MAX_AWAITING_SIGNED_MEDIA_SOCKETS_PER_CLIENT; i += 1) {
      const sock = await connect(port, {
        'CF-Connecting-IP': `2001:db8:81:2::${i}`,
        'X-Twilio-Signature': twilioSignature,
      });
      signedSameClient.push(sock);
      held.push(sock);
    }
    const sameOldestWait = waitClose(signedSameClient[0], 2000, 'same-client signed eviction');
    const sameNinth = await connect(port, {
      'CF-Connecting-IP': '2001:db8:81:2::ff',
      'X-Twilio-Signature': twilioSignature,
    });
    held.push(sameNinth);
    const sameOldestCode = await sameOldestWait;
    if (
      sameOldestCode === 1008 &&
      victim.readyState === WebSocket.OPEN &&
      sameNinth.readyState === WebSocket.OPEN &&
      signedSameClient.slice(1).every((sock) => sock.readyState === WebSocket.OPEN)
    ) {
      pass('a full signed per-client cap evicts only that client oldest unbound socket');
    } else if (sameOldestCode !== null) {
      fail(
        `same-client eviction code=${sameOldestCode} victim=${victim.readyState} ninth=${sameNinth.readyState}`
      );
    }
    victim.close();
    for (const sock of signedSameClient) sock.close();
    sameNinth.close();
    await delay(150);

    const signedGlobalCap = 128;
    const signedGlobal = [];
    for (let start = 0; start < signedGlobalCap; start += 32) {
      const group = [];
      for (let i = start; i < start + 32; i += 1) {
        group.push(
          connect(port, {
            'CF-Connecting-IP': `2001:db8:90:${i + 1}::1`,
            'X-Twilio-Signature': twilioSignature,
          })
        );
      }
      const opened = await Promise.all(group);
      for (const sock of opened) {
        signedGlobal.push(sock);
        held.push(sock);
      }
    }
    const oldestGlobalWait = waitClose(signedGlobal[0], 2000, 'signed global oldest');
    const overflow = await connect(port, {
      'CF-Connecting-IP': '2001:db8:91:1::1',
      'X-Twilio-Signature': twilioSignature,
    });
    held.push(overflow);
    const oldestGlobalCode = await oldestGlobalWait;
    const globalRestOpen = signedGlobal.slice(1).every((sock) => sock.readyState === WebSocket.OPEN);
    if (oldestGlobalCode === 1008 && overflow.readyState === WebSocket.OPEN && globalRestOpen) {
      pass('129 signed sockets across distinct clients evict the oldest unbound signed socket');
    } else if (oldestGlobalCode !== null) {
      fail(`signed global code=${oldestGlobalCode} overflow=${overflow.readyState} rest=${globalRestOpen}`);
    }
    for (const sock of signedGlobal) {
      try {
        sock.close();
      } catch {
        /* ignore */
      }
    }
    overflow.close();
    await delay(150);

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

    await delay(1100);
    const sigLines = () => logs.lines.filter((line) => line.includes('media upgrade signature rejected'));
    const sigBefore = sigLines().length;
    const phoneHost = '5550100199.example.com';
    const replayHeader = 'static-replay-signature';
    for (let i = 0; i < 2; i += 1) {
      const raw = await rawUpgrade(port, {
        Host: phoneHost,
        'X-Twilio-Signature': replayHeader,
        'CF-Connecting-IP': `198.51.100.${60 + i}`,
      });
      held.push(raw);
      raw.destroy();
    }
    await delay(50);
    const addedSig = sigLines().slice(sigBefore);
    if (
      addedSig.length === 1 &&
      !addedSig[0].includes(phoneHost) &&
      !addedSig[0].includes('5550100199') &&
      addedSig[0].includes('0199') &&
      !addedSig[0].includes(replayHeader) &&
      !addedSig[0].includes(process.env.TWILIO_AUTH_TOKEN)
    ) {
      pass('a failed upgrade signature is logged once per second with the host masked');
    } else {
      fail(`upgrade signature logs ${JSON.stringify(addedSig)}`);
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
