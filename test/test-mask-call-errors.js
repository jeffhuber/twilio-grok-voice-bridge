#!/usr/bin/env node
'use strict';

process.env.BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || 'operator-test-key';
process.env.PUBLIC_HOST = process.env.PUBLIC_HOST || 'bridge.example.com';
delete process.env.XAI_API_KEY;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;

const http = require('http');
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
  logTwilioMediaJsonParseError,
  logTwilioWsError,
  setTwilioClientForTests,
} = require('../src/server.js');

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
  if (kept.includes('203.0.113.50') && kept.includes('2026-09-26') && kept.includes('1727350123456')) {
    pass('IPv4 addresses, dates, and millisecond timestamps stay unmasked');
  } else {
    fail(`non-phone numbers were masked: ${kept}`);
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
    logTwilioMediaJsonParseError(new Error('media 5555550100'));
    logTwilioWsError(new Error('socket 555-0100'));
  });
  const helperJoined = helperLines.join('\n');
  if (
    helperLines.length === 8 &&
    helperJoined.includes('[twiml-connect] Error:') &&
    helperJoined.includes('[http] unexpected error:') &&
    helperJoined.includes('[http] 400 body parse error:') &&
    helperJoined.includes('[grok] error callSid=CA123:') &&
    helperJoined.includes('[grok] JSON parse error callSid=CA123:') &&
    helperJoined.includes('[twilio] JSON parse error callSid=CA123:') &&
    helperJoined.includes('[twilio] JSON parse error on media-stream ws:') &&
    helperJoined.includes('[twilio] ws error:') &&
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
