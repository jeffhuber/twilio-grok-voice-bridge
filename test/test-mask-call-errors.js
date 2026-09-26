#!/usr/bin/env node
'use strict';

process.env.BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || 'operator-test-key';
process.env.PUBLIC_HOST = process.env.PUBLIC_HOST || 'bridge.example.com';
process.env.XAI_API_KEY = 'xai-test-key';
process.env.VOICE_ALIASES = '+8613800000000';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;

const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');

const voiceAliasWarnings = [];
const originalWarn = console.warn;
console.warn = (...args) => {
  voiceAliasWarnings.push(args.map((part) => String(part)).join(' '));
};
const {
  app,
  server,
  createSession,
  maskPhoneNumbersInText,
  isE164,
  logTwimlConnectError,
  logHttpUnexpectedError,
  logBodyParseError,
  logGrokSocketError,
  logGrokJsonParseError,
  logTwilioJsonParseError,
  setTwilioClientForTests,
  setGrokRealtimeUrlForTests,
  sessionsByCallSid,
  handleTwilioMessage,
} = require('../src/server.js');
console.warn = originalWarn;
setGrokRealtimeUrlForTests('ws://127.0.0.1:9');

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
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args) => {
    lines.push(args.map((part) => String(part)).join(' '));
  };
  console.log = (...args) => {
    lines.push(args.map((part) => String(part)).join(' '));
  };
  try {
    fn();
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
  return lines;
}

function installStderrCapture() {
  const lines = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args) => {
    lines.push(args.map((part) => String(part)).join(' '));
    originalError(...args);
  };
  console.log = (...args) => {
    lines.push(args.map((part) => String(part)).join(' '));
    originalLog(...args);
  };
  return {
    lines,
    restore() {
      console.error = originalError;
      console.log = originalLog;
    },
  };
}

function requestJson(port, method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...(headers || {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode, raw, json: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requestRaw(port, method, path, rawBody, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(rawBody),
          ...(headers || {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLog(stderr, start, needle, ms) {
  const deadline = Date.now() + ms;
  let found = [];
  while (Date.now() <= deadline) {
    found = stderr.lines.slice(start).filter((line) => line.includes(needle));
    if (found.length > 0) return found;
    await delay(20);
  }
  return found;
}

function assertMasked(label, raw, masked, last4) {
  if (!masked.includes(raw) && masked.includes(last4) && !/\d{7,}/.test(masked.replace(/x/g, ''))) {
    pass(label);
    return;
  }
  if (!masked.includes(raw) && masked.includes(last4)) {
    pass(label);
    return;
  }
  fail(`${label}: ${masked}`);
}

async function main() {
  const samples = [
    ['555-0100', '0100'],
    ['(555) 555-0100', '0100'],
    ['+1 555 555 0100', '0100'],
    ['+1-555-555-0100', '0100'],
    ['15555550100', '0100'],
    ['5555550100', '0100'],
    ['+15555550100', '0100'],
  ];
  for (const [raw, last4] of samples) {
    const masked = maskPhoneNumbersInText(`failed for ${raw} today`);
    assertMasked(raw, raw, masked, last4);
  }

  const sid = 'CA12345678901234567890123456789012';
  const withSid = maskPhoneNumbersInText(`missing ${sid} code 21211`);
  if (withSid.includes(sid) && withSid.includes('21211')) {
    pass('a Call SID and a short error code stay intact');
  } else {
    fail(`sid or error code was changed: ${withSid}`);
  }

  const edged = maskPhoneNumbersInText('x5555550100 5555550100y');
  if (edged === 'x5555550100 5555550100y') {
    pass('a letter beside a digit run is not masked');
  } else {
    fail(`edged digit run changed: ${edged}`);
  }

  const kept = maskPhoneNumbersInText('from 203.0.113.50 on 2026-09-26 at 1727350123456');
  if (
    kept.includes('203.0.113.50') &&
    kept.includes('2026-09-26') &&
    !kept.includes('1727350123456') &&
    kept.includes('3456')
  ) {
    pass('IPv4 addresses and dates stay, and a 13-digit timestamp is masked');
  } else {
    fail(`non-phone numbers were masked: ${kept}`);
  }
  const epochEdge = maskPhoneNumbersInText('at 1000000000000 and 2100000000000 then 2100000000001');
  if (
    !epochEdge.includes('1000000000000') &&
    !epochEdge.includes('2100000000000') &&
    !epochEdge.includes('2100000000001') &&
    epochEdge.includes('0000') &&
    epochEdge.includes('0001')
  ) {
    pass('13-digit runs are masked, with no epoch-millisecond exemption');
  } else {
    fail(`epoch window was ${epochEdge}`);
  }

  const intlSamples = [
    ['+8613800000000', '0000', '+8613800000000'],
    ['+4930123456789', '6789', '+4930123456789'],
    ['+8613812345678', '5678', '+8613812345678'],
    ['+4915112345678', '5678', '+4915112345678'],
    ['+86 138 0000 0000', '0000', '+86'],
    ['+2100000000000', '0000', '+2100000000000'],
    ['8613800000000', '0000', '8613800000000'],
  ];
  for (const [raw, last4, hidden] of intlSamples) {
    const masked = maskPhoneNumbersInText(`failed for ${raw} today`);
    const countryHidden = raw.startsWith('+86 ') ? !masked.includes('+86') && !masked.includes('138') : !masked.includes(hidden);
    if (!masked.includes(raw) && masked.includes(last4) && countryHidden) {
      pass(`masks ${raw}`);
    } else {
      fail(`international mask ${raw}: ${masked}`);
    }
  }
  const aliasWarnings = voiceAliasWarnings.filter((line) => line.includes('VOICE_ALIASES'));
  if (
    aliasWarnings.length === 1 &&
    !aliasWarnings[0].includes('+8613800000000') &&
    aliasWarnings[0].includes('0000')
  ) {
    pass('VOICE_ALIASES parse errors are masked');
  } else {
    fail(`VOICE_ALIASES warning was ${JSON.stringify(aliasWarnings)}`);
  }

  if (isE164('+15555550100') && !isE164('555-0100') && !isE164('+15555550100 ')) {
    pass('E.164 accepts only a leading plus and digits');
  } else {
    fail('isE164 accepted a non-E.164 value');
  }

  const helperLines = capture(() => {
    logTwimlConnectError(new Error('dial +1 555 555 0100 failed'));
    logHttpUnexpectedError(new Error('boom (555) 555-0100'));
    logBodyParseError(new Error('bad 5555550100 json'));
    logGrokSocketError({ callSid: 'CA123' }, new Error('model said 555-0100'));
    logGrokJsonParseError({ callSid: 'CA123' }, new Error('bad json 555-0100'));
    logTwilioJsonParseError({ callSid: 'CA123' }, new Error('bad frame 555-0199'));
  });
  const helperJoined = helperLines.join('\n');
  if (
    helperLines.length === 6 &&
    helperJoined.includes('[twiml-connect] Error:') &&
    helperJoined.includes('[http] unexpected error:') &&
    helperJoined.includes('[http] 400 body parse error:') &&
    helperJoined.includes('[grok] error callSid=CA123:') &&
    helperJoined.includes('[grok] JSON parse error callSid=CA123:') &&
    helperJoined.includes('[twilio] JSON parse error callSid=CA123:') &&
    !helperJoined.includes('555-0100') &&
    !helperJoined.includes('(555) 555-0100') &&
    !helperJoined.includes('5555550100') &&
    !helperJoined.includes('555-0199') &&
    helperJoined.includes('0100') &&
    helperJoined.includes('0199')
  ) {
    pass('twiml, http, body-parse, grok, and twilio error logs mask digit runs');
  } else {
    fail(`helper logs were ${JSON.stringify(helperLines)}`);
  }

  const auth = { authorization: `Bearer ${process.env.BRIDGE_API_KEY}` };
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const stderr = installStderrCapture();
  try {
    const badTo = await requestJson(port, 'POST', '/call', { to: '555-0100', goal: 'hi' }, auth);
    const echoed =
      badTo.raw.includes('555-0100') ||
      badTo.raw.includes('5550100') ||
      (badTo.json && JSON.stringify(badTo.json).includes('555'));
    if (badTo.status === 400 && badTo.json && badTo.json.error === 'to must be an E.164 number' && !echoed) {
      pass('non-E.164 to is rejected without echoing it');
    } else {
      fail(`non-E.164 to response ${badTo.status} ${badTo.raw}`);
    }

    setTwilioClientForTests({
      calls: Object.assign(
        () => ({
          update() {
            return Promise.reject(new Error('The requested resource +15555550100 was not found'));
          },
        }),
        {
          create() {
            return Promise.reject(new Error('Unable to create record for +1 (555) 555-0100'));
          },
        }
      ),
    });

    const beforeCall = stderr.lines.length;
    const callRes = await requestJson(port, 'POST', '/call', { to: '+15555550100', goal: 'hi' }, auth);
    const callLogs = stderr.lines.slice(beforeCall).filter((line) => line.includes('[call] error:'));
    if (
      callRes.status === 500 &&
      callLogs.length === 1 &&
      !callLogs[0].includes('+1 (555) 555-0100') &&
      !callLogs[0].includes('5555550100') &&
      callLogs[0].includes('0100') &&
      !callRes.raw.includes('+1 (555) 555-0100') &&
      !callRes.raw.includes('5555550100') &&
      callRes.raw.includes('0100')
    ) {
      pass('POST /call logs and returns a thrown Twilio error with the number masked');
    } else {
      fail(`call log ${JSON.stringify(callLogs)} status ${callRes.status} body ${callRes.raw}`);
    }

    const session = createSession({ callSid: 'CA-hang', goal: 'hi', to: '+15555550199' });
    const beforeHangup = stderr.lines.length;
    const hangupRes = await requestJson(port, 'POST', '/hangup', { callSid: session.callSid }, auth);
    const hangupLogs = stderr.lines.slice(beforeHangup).filter((line) => line.includes('[hangup] Twilio update failed:'));
    if (
      hangupRes.status === 200 &&
      hangupLogs.length === 1 &&
      !hangupLogs[0].includes('+15555550100') &&
      hangupLogs[0].includes('0100')
    ) {
      pass('a failing hangup logs the masked Twilio error');
    } else {
      fail(`hangup log ${JSON.stringify(hangupLogs)} status ${hangupRes.status}`);
    }

    const beforeBadJson = stderr.lines.length;
    const badJson = await requestRaw(port, 'POST', '/call', 'not json 555-0100', auth);
    const badJsonLogs = stderr.lines.slice(beforeBadJson).filter((line) => line.includes('[http] 400 body parse error:'));
    if (
      badJson.status === 400 &&
      badJsonLogs.length === 1 &&
      badJsonLogs[0].includes('0100') &&
      !badJsonLogs[0].includes('555-0100')
    ) {
      pass('malformed JSON is logged with the number masked');
    } else {
      fail(`malformed JSON status ${badJson.status} logs ${JSON.stringify(badJsonLogs)}`);
    }

    const beforeParse = stderr.lines.length;
    const parseRes = await requestRaw(
      port,
      'POST',
      '/call',
      '{"to":"+15555550100","goal":',
      auth
    );
    const parseLogs = stderr.lines.slice(beforeParse).filter((line) => line.includes('[http] 400 body parse error:'));
    if (parseRes.status === 400 && parseLogs.length === 1 && !parseLogs[0].includes('+15555550100')) {
      pass('body-parse error log does not echo an E.164 number from the message');
    } else if (parseRes.status === 400 && parseLogs.length === 1) {
      fail(`body-parse log contained a phone number: ${parseLogs[0]}`);
    } else {
      fail(`body-parse status ${parseRes.status} logs ${JSON.stringify(parseLogs)}`);
    }

    if (
      isE164('+8613800000000') &&
      isE164('+4930123456789') &&
      isE164('+8613812345678') &&
      isE164('+4915112345678') &&
      !isE164('+86 138 0000 0000')
    ) {
      pass('compact +86 and +49 numbers are E.164 and the spaced form is not');
    } else {
      fail('E.164 classification of +86/+49 changed');
    }

    const intlCalls = [
      ['+8613800000000', '0000'],
      ['+4930123456789', '6789'],
      ['+8613812345678', '5678'],
      ['+4915112345678', '5678'],
    ];
    for (const [number, last4] of intlCalls) {
      setTwilioClientForTests({
        calls: Object.assign(
          () => ({
            update() {
              return Promise.resolve({});
            },
          }),
          {
            create() {
              return Promise.reject(new Error(`Unable to create record for ${number}`));
            },
          }
        ),
      });
      const beforeIntl = stderr.lines.length;
      const intlRes = await requestJson(port, 'POST', '/call', { to: number, goal: 'hi' }, auth);
      const intlLogs = stderr.lines.slice(beforeIntl).filter((line) => line.includes('[call] error:'));
      if (
        intlRes.status === 500 &&
        intlLogs.length === 1 &&
        !intlLogs[0].includes(number) &&
        intlLogs[0].includes(last4) &&
        !intlRes.raw.includes(number) &&
        intlRes.raw.includes(last4)
      ) {
        pass(`POST /call accepts ${number} and masks it in the log and 500 body`);
      } else {
        fail(`intl call ${number} log ${JSON.stringify(intlLogs)} status ${intlRes.status} body ${intlRes.raw}`);
      }
    }

    const spaced = '+86 138 0000 0000';
    const spacedRes = await requestJson(port, 'POST', '/call', { to: spaced, goal: 'hi' }, auth);
    if (
      spacedRes.status === 400 &&
      spacedRes.json &&
      spacedRes.json.error === 'to must be an E.164 number' &&
      !spacedRes.raw.includes('+86') &&
      !spacedRes.raw.includes('138')
    ) {
      pass('spaced +86 is rejected without echoing the country code');
    } else {
      fail(`spaced +86 response ${spacedRes.status} ${spacedRes.raw}`);
    }

    const beforeCharset = stderr.lines.length;
    const charsetRes = await requestRaw(port, 'POST', '/call', '{}', {
      authorization: `Bearer ${process.env.BRIDGE_API_KEY}`,
      'content-type': 'application/json; charset="+8613800000000"',
    });
    const charsetLogs = stderr.lines.slice(beforeCharset).filter((line) => line.includes('[http] unexpected error:'));
    if (
      charsetRes.status === 500 &&
      charsetLogs.length === 1 &&
      !charsetLogs[0].includes('+8613800000000') &&
      charsetLogs[0].includes('0000')
    ) {
      pass('unexpected HTTP errors mask numbers from the real error handler');
    } else {
      fail(`charset log ${JSON.stringify(charsetLogs)} status ${charsetRes.status}`);
    }

    setTwilioClientForTests({
      calls: Object.assign(
        () => ({
          update() {
            return Promise.resolve({});
          },
        }),
        {
          create() {
            return Promise.resolve({ sid: 'CA-mask-path', status: 'queued' });
          },
        }
      ),
    });
    const placed = await requestJson(port, 'POST', '/call', { to: '+15555550100', goal: 'hi' }, auth);
    const placedSession = sessionsByCallSid.get('CA-mask-path');
    if (placed.status !== 200 || !placedSession) {
      fail(`could not place a session for handler coverage ${placed.status} ${placed.raw}`);
    } else {
      Object.defineProperty(placedSession, 'goal', {
        configurable: true,
        get() {
          throw new Error('twiml failed for +4930123456789');
        },
      });
      const beforeTwiml = stderr.lines.length;
      const twimlRes = await requestJson(
        port,
        'POST',
        '/twiml-connect',
        { sessionId: 'CA-mask-path', CallSid: 'CA-mask-path' },
        auth
      );
      const twimlLogs = stderr.lines.slice(beforeTwiml).filter((line) => line.includes('[twiml-connect] Error:'));
      if (
        twimlRes.status === 500 &&
        twimlLogs.length === 1 &&
        !twimlLogs[0].includes('+4930123456789') &&
        twimlLogs[0].includes('6789')
      ) {
        pass('twiml-connect errors mask numbers from the real catch');
      } else {
        fail(`twiml log ${JSON.stringify(twimlLogs)} status ${twimlRes.status} body ${twimlRes.raw}`);
      }
      Object.defineProperty(placedSession, 'goal', { configurable: true, value: 'hi', writable: true });
      const twimlOk = await requestJson(
        port,
        'POST',
        '/twiml-connect',
        { sessionId: 'CA-mask-path', CallSid: 'CA-mask-path' },
        auth
      );
      const urlMatch = twimlOk.raw.match(/url="([^"]+)"/);
      if (twimlOk.status !== 200 || !urlMatch) {
        fail(`twiml-connect did not return a stream url ${twimlOk.status} ${twimlOk.raw}`);
      }

      const grokHttp = http.createServer();
      const grokWss = new WebSocket.Server({ server: grokHttp });
      grokWss.on('connection', (socket) => {
        socket.send('+8613800000000');
      });
      await new Promise((resolve) => grokHttp.listen(0, '127.0.0.1', resolve));
      setGrokRealtimeUrlForTests(`ws://127.0.0.1:${grokHttp.address().port}`);
      try {
        const streamUrl = new URL(urlMatch[1].replace(/&amp;/g, '&'));
        const mediaUrl = `ws://127.0.0.1:${port}${streamUrl.pathname}${streamUrl.search}`;
        const mediaSock = await new Promise((resolve, reject) => {
          const sock = new WebSocket(mediaUrl);
          const timer = setTimeout(() => {
            sock.terminate();
            reject(new Error('media open timed out'));
          }, 2000);
          sock.on('open', () => {
            clearTimeout(timer);
            resolve(sock);
          });
          sock.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });
        const beforeInner = stderr.lines.length;
        handleTwilioMessage(placedSession, '+8613800000000');
        const innerLogs = stderr.lines.slice(beforeInner).filter((line) => line.includes('[twilio] JSON parse error callSid='));
        if (
          innerLogs.length === 1 &&
          !innerLogs[0].includes('+8613800000000') &&
          innerLogs[0].includes('0000')
        ) {
          pass('handleTwilioMessage masks JSON parse errors');
        } else {
          fail(`twilio json log ${JSON.stringify(innerLogs)}`);
        }

        mediaSock.send(JSON.stringify({
          event: 'start',
          streamSid: 'stream-mask',
          start: { callSid: 'CA-mask-path', streamSid: 'stream-mask' },
        }));
        const grokLogs = await waitForLog(stderr, beforeInner, '[grok] JSON parse error callSid=', 2000);
        if (
          grokLogs.length >= 1 &&
          grokLogs.every((line) => !line.includes('+8613800000000') && line.includes('0000'))
        ) {
          pass('grok JSON parse errors mask numbers from the socket handler');
        } else {
          fail(`grok json log ${JSON.stringify(grokLogs)}`);
        }

        const beforeGrokErr = stderr.lines.length;
        if (!placedSession.grokWs) {
          fail('grok socket was not opened');
        } else {
          placedSession.grokWs.emit('error', new Error('upstream +4930123456789'));
          const grokErrLogs = stderr.lines.slice(beforeGrokErr).filter((line) => line.includes('[grok] error callSid='));
          if (
            grokErrLogs.length === 1 &&
            !grokErrLogs[0].includes('+4930123456789') &&
            grokErrLogs[0].includes('6789')
          ) {
            pass('grok socket errors mask numbers from the real listener');
          } else {
            fail(`grok error log ${JSON.stringify(grokErrLogs)}`);
          }
        }

        mediaSock.close();
      } finally {
        setGrokRealtimeUrlForTests('ws://127.0.0.1:9');
        await new Promise((resolve) => grokHttp.close(resolve));
      }

      const originalEqual = crypto.timingSafeEqual;
      crypto.timingSafeEqual = () => {
        throw new Error('compare +8613800000000');
      };
      try {
        const sigTs = Date.now();
        const sig = crypto
          .createHmac('sha256', process.env.BRIDGE_API_KEY)
          .update(`CA-sig:${sigTs}`)
          .digest('base64url');
        const beforeSig = stderr.lines.length;
        await Promise.race([
          new Promise((resolve) => {
          const req = http.request(
            {
              host: '127.0.0.1',
              port,
              path: `/media-stream?callSid=CA-sig&timestamp=${sigTs}&signature=${encodeURIComponent(sig)}`,
              headers: {
                connection: 'Upgrade',
                upgrade: 'websocket',
                'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
                'sec-websocket-version': '13',
              },
            },
            (res) => {
              res.resume();
              res.on('end', resolve);
            }
          );
          req.on('upgrade', (res, socket) => {
            socket.destroy();
            resolve();
          });
          req.on('error', resolve);
          req.end();
        }),
          delay(2000),
        ]);
        await delay(50);
        const sigLogs = stderr.lines.slice(beforeSig).filter((line) => line.includes('signature verification failed'));
        if (
          sigLogs.length === 1 &&
          !sigLogs[0].includes('+8613800000000') &&
          sigLogs[0].includes('0000')
        ) {
          pass('signature verification failures mask numbers');
        } else {
          fail(`signature log ${JSON.stringify(sigLogs)}`);
        }
      } finally {
        crypto.timingSafeEqual = originalEqual;
      }
    }
  } finally {
    stderr.restore();
    await new Promise((resolve) => server.close(resolve));
  }

  if (failed > 0) {
    console.error(`\n${failed} call-error mask test(s) failed`);
    process.exit(1);
  }
  console.log('\n✓ All call-error mask tests passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
