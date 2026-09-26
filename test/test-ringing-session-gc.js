#!/usr/bin/env node
'use strict';

process.env.BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || 'operator-test-key';
process.env.PUBLIC_HOST = process.env.PUBLIC_HOST || 'bridge.example.com';
delete process.env.XAI_API_KEY;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;

const WebSocket = require('ws');

let failed = 0;

function fail(message) {
  console.error(`  ✗ ${message}`);
  failed += 1;
}

function pass(message) {
  console.log(`  ✓ ${message}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadModule(raw) {
  if (raw === undefined) delete process.env.NEVER_CONNECTED_TIMEOUT_MS;
  else process.env.NEVER_CONNECTED_TIMEOUT_MS = raw;
  const resolved = require.resolve('../src/server.js');
  delete require.cache[resolved];
  const warns = [];
  const original = console.warn;
  console.warn = (...args) => {
    warns.push(args.map((part) => String(part)).join(' '));
  };
  try {
    return { mod: require(resolved), warns };
  } finally {
    console.warn = original;
  }
}

function timeoutWarns(warns) {
  return warns.filter((line) => line.includes('NEVER_CONNECTED_TIMEOUT_MS') && line.includes('at least 1000'));
}

function startMessage(callSid, timestamp, signature) {
  return {
    event: 'start',
    streamSid: 'stream-1',
    start: {
      callSid,
      streamSid: 'stream-1',
      customParameters: { callSid, timestamp: String(timestamp), signature },
    },
  };
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/media-stream`);
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      reject(new Error('open timed out'));
    }, 2000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function waitUntil(predicate, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (predicate()) return true;
    await delay(20);
  }
  return false;
}

async function main() {
  for (const raw of ['NaN', '-5', '0', '999', 'Infinity']) {
    const loaded = loadModule(raw);
    const warned = timeoutWarns(loaded.warns);
    if (loaded.mod.NEVER_CONNECTED_TIMEOUT_MS === 600000 && warned.length === 1) {
      pass(`NEVER_CONNECTED_TIMEOUT_MS=${raw} uses the default and warns once`);
    } else {
      fail(
        `NEVER_CONNECTED_TIMEOUT_MS=${raw} -> ${loaded.mod.NEVER_CONNECTED_TIMEOUT_MS} warns=${warned.length}`
      );
    }
  }

  const kept = loadModule('15000');
  if (kept.mod.NEVER_CONNECTED_TIMEOUT_MS === 15000 && timeoutWarns(kept.warns).length === 0) {
    pass('a positive integer timeout is kept');
  } else {
    fail(`positive integer timeout became ${kept.mod.NEVER_CONNECTED_TIMEOUT_MS}`);
  }

  const floor = loadModule('1000');
  if (floor.mod.NEVER_CONNECTED_TIMEOUT_MS === 1000 && timeoutWarns(floor.warns).length === 0) {
    pass('a 1000ms timeout is kept');
  } else {
    fail(`1000ms timeout became ${floor.mod.NEVER_CONNECTED_TIMEOUT_MS}`);
  }

  const { mod } = loadModule(undefined);
  if (mod.NEVER_CONNECTED_TIMEOUT_MS === 600000) {
    pass('an unset timeout uses 10 minutes');
  } else {
    fail(`unset timeout became ${mod.NEVER_CONNECTED_TIMEOUT_MS}`);
  }

  const early = mod.createSession({ callSid: 'CA-early', goal: 'Say hello' });
  early.everConnected = false;
  mod.openGrokSession(early);
  if (early.everConnected === true) {
    pass('openGrokSession marks the session connected before the missing-key return');
  } else {
    fail('openGrokSession returned before marking the session connected');
  }

  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve));
  const { port } = mod.server.address();
  let liveSocket = null;
  try {
    const bound = mod.createSession({ callSid: 'CA-bound', goal: 'Say hello' });
    mod.pendingByCallSid.set(bound.callSid, bound);
    const minted = mod.mintMediaAuth(bound, bound.callSid);
    liveSocket = await connect(port);
    liveSocket.send(JSON.stringify(startMessage(bound.callSid, minted.timestamp, minted.signature)));
    const boundOk = await waitUntil(
      () => bound.everConnected === true && bound.streamSid === 'stream-1' && bound.twilioWs,
      2000
    );
    if (boundOk) {
      pass('a real start event marks the session connected');
    } else {
      fail('the media start path left everConnected false');
    }
    liveSocket.close();
    const closed = await waitUntil(() => !bound.twilioWs, 2000);
    if (!closed) fail('the media socket did not clear after close');
    mod.cleanupOrphanSessions(bound.startedAt + 1000);
    if (!mod.sessionsByCallSid.has('CA-bound') && !mod.pendingByCallSid.has('CA-bound')) {
      pass('a session that connected and then lost its sockets is removed');
    } else {
      fail('a finished media session was kept');
    }

    const ringing = mod.createSession({ callSid: 'CA-ring', goal: 'Say hello' });
    mod.pendingByCallSid.set(ringing.callSid, ringing);
    ringing.startedAt = 1_000_000;
    mod.cleanupOrphanSessions(ringing.startedAt + 120000);
    if (mod.sessionsByCallSid.has('CA-ring') && mod.pendingByCallSid.has('CA-ring')) {
      pass('a ringing session survives the 2-minute sweep');
    } else {
      fail('the 2-minute sweep removed a never-connected session');
    }

    mod.cleanupOrphanSessions(ringing.startedAt + mod.NEVER_CONNECTED_TIMEOUT_MS);
    if (mod.sessionsByCallSid.has('CA-ring') && mod.pendingByCallSid.has('CA-ring')) {
      pass('a ringing session is kept at exactly the never-connected timeout');
    } else {
      fail('exact timeout removed a never-connected session');
    }

    mod.cleanupOrphanSessions(ringing.startedAt + mod.NEVER_CONNECTED_TIMEOUT_MS + 1);
    if (!mod.sessionsByCallSid.has('CA-ring') && !mod.pendingByCallSid.has('CA-ring')) {
      pass('a never-connected session older than the timeout is removed');
    } else {
      fail('an expired ringing session was kept');
    }

    const live = mod.createSession({ callSid: 'CA-live', goal: 'Say hello' });
    let closedLive = false;
    live.everConnected = true;
    live.twilioWs = {
      readyState: WebSocket.OPEN,
      close() {
        closedLive = true;
      },
    };
    live.startedAt = 9_000_000;
    mod.cleanupOrphanSessions(live.startedAt + mod.SESSION_MAX_AGE_MS);
    if (mod.sessionsByCallSid.has('CA-live') && closedLive === false) {
      pass('a live session at exactly SESSION_MAX_AGE_MS stays up');
    } else {
      fail('a live session was hung up at exactly the max age');
    }
    mod.cleanupOrphanSessions(live.startedAt + mod.SESSION_MAX_AGE_MS + 1);
    if (!mod.sessionsByCallSid.has('CA-live') && closedLive === true) {
      pass('a live session older than SESSION_MAX_AGE_MS is hung up');
    } else {
      fail('an over-age live session was not hung up');
    }
  } finally {
    if (liveSocket) {
      try {
        liveSocket.terminate();
      } catch {
        /* ignore */
      }
    }
    await Promise.race([
      new Promise((resolve) => mod.server.close(resolve)),
      delay(1000),
    ]);
  }

  if (failed > 0) {
    console.error(`\n${failed} ringing-session GC test(s) failed`);
    process.exit(1);
  }
  console.log('\n✓ All ringing-session GC tests passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
