#!/usr/bin/env node
'use strict';

const http = require('http');

process.env.BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || 'operator-test-key';
const OPERATOR_KEY = process.env.BRIDGE_API_KEY;
delete process.env.DISABLE_OPENER_ON_CONNECT;
delete process.env.OPENER_ON_CONNECT;
delete process.env.XAI_API_KEY;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;

const {
  app,
  createSession,
  handleGrokEvent,
  onGrokSocketOpen,
  connectOpenerEnabled,
} = require('../src/server.js');

let failed = 0;

function fail(message) {
  console.error(`  ✗ ${message}`);
  failed += 1;
}

function pass(message) {
  console.log(`  ✓ ${message}`);
}

function responseCreates(sent) {
  return sent.filter((obj) => obj.type === 'response.create');
}

function freshSession(overrides) {
  return createSession({
    callSid: 'call-1',
    goal: 'Say hello',
    ...overrides,
  });
}

function pcmuAck() {
  return {
    type: 'session.updated',
    session: {
      audio: {
        output: {
          format: { type: 'audio/pcmu' },
        },
      },
    },
  };
}

function greetCycle(session) {
  const sent = [];
  const send = (_session, obj) => {
    sent.push(obj);
  };
  onGrokSocketOpen(session, send);
  handleGrokEvent(session, pcmuAck(), { sendGrok: send });
  return sent;
}

function postCall(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/call',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Bearer ${OPERATOR_KEY}`,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  const sent = [];
  const send = (_session, obj) => {
    sent.push(obj);
  };
  const session = freshSession();

  handleGrokEvent(session, { type: 'session.created' }, { sendGrok: send });
  handleGrokEvent(session, pcmuAck(), { sendGrok: send });
  if (responseCreates(sent).length === 0 && session.openerSent === false && session.awaitingAudioConfigAck === false) {
    pass('no greeting before audio config is sent');
  } else {
    fail('greeting fired before audio config');
  }

  onGrokSocketOpen(session, send);
  const config = sent[0];
  const audioReady =
    config &&
    config.type === 'session.update' &&
    config.session.audio.input.format.type === 'audio/pcmu' &&
    config.session.audio.output.format.type === 'audio/pcmu';
  if (audioReady && responseCreates(sent).length === 0 && session.awaitingAudioConfigAck === true) {
    pass('socket open sends audio format and does not greet yet');
  } else {
    fail('socket open did not apply audio format before any greeting');
  }

  handleGrokEvent(session, { type: 'session.created' }, { sendGrok: send });
  if (responseCreates(sent).length === 0 && session.awaitingAudioConfigAck === true) {
    pass('session.created does not greet or clear the wait');
  } else {
    fail('session.created changed the opener wait');
  }

  handleGrokEvent(session, { type: 'session.updated' }, { sendGrok: send });
  if (responseCreates(sent).length === 0 && session.awaitingAudioConfigAck === true && session.openerSent === false) {
    pass('session.updated without pcmu output leaves the arm set');
  } else {
    fail('non-pcmu session.updated consumed the opener arm');
  }

  handleGrokEvent(session, pcmuAck(), { sendGrok: send });
  handleGrokEvent(session, pcmuAck(), { sendGrok: send });
  onGrokSocketOpen(session, send);
  handleGrokEvent(session, pcmuAck(), { sendGrok: send });
  if (responseCreates(sent).length === 1 && responseCreates(sent)[0].type === 'response.create') {
    pass('first pcmu session.updated greets once and later updates do not');
  } else {
    fail(`expected one response.create, saw ${responseCreates(sent).length}`);
  }

  const optedOut = freshSession({ callSid: 'call-2', openerOnConnect: false });
  if (responseCreates(greetCycle(optedOut)).length === 0 && optedOut.openerSent === true) {
    pass('per-call openerOnConnect false skips the greeting');
  } else {
    fail('per-call opt-out still greeted');
  }

  process.env.DISABLE_OPENER_ON_CONNECT = '1';
  const envOff = freshSession({ callSid: 'call-3' });
  if (responseCreates(greetCycle(envOff)).length === 0 && connectOpenerEnabled(envOff) === false) {
    pass("DISABLE_OPENER_ON_CONNECT=1 skips the greeting");
  } else {
    fail('exact disable flag still greeted');
  }

  const forced = freshSession({ callSid: 'call-4', openerOnConnect: true });
  if (responseCreates(greetCycle(forced)).length === 1 && connectOpenerEnabled(forced) === true) {
    pass('per-call true greets even when DISABLE_OPENER_ON_CONNECT=1');
  } else {
    fail('per-call true did not greet');
  }

  for (const value of ['0', 'false', '']) {
    process.env.DISABLE_OPENER_ON_CONNECT = value;
    const stillOn = freshSession({ callSid: `call-env-${value || 'empty'}` });
    if (responseCreates(greetCycle(stillOn)).length === 1 && connectOpenerEnabled(stillOn) === true) {
      pass(`DISABLE_OPENER_ON_CONNECT=${JSON.stringify(value)} leaves the greeting on`);
    } else {
      fail(`non-exact disable value ${JSON.stringify(value)} turned the greeting off`);
    }
  }
  delete process.env.DISABLE_OPENER_ON_CONNECT;
  const unset = freshSession({ callSid: 'call-unset' });
  if (responseCreates(greetCycle(unset)).length === 1) {
    pass('unset DISABLE_OPENER_ON_CONNECT leaves the greeting on');
  } else {
    fail('unset disable flag turned the greeting off');
  }

  const errored = freshSession({ callSid: 'call-error' });
  const errorSent = [];
  const errorSend = (_session, obj) => errorSent.push(obj);
  onGrokSocketOpen(errored, errorSend);
  handleGrokEvent(errored, { type: 'error', error: { message: 'session.update rejected' } }, { sendGrok: errorSend });
  if (errored.awaitingAudioConfigAck === false && errored.openerSent === false) {
    pass('grok error clears the opener arm without marking it sent');
  } else {
    fail('grok error left the opener arm armed');
  }
  handleGrokEvent(errored, pcmuAck(), { sendGrok: errorSend });
  if (responseCreates(errorSent).length === 0) {
    pass('a later pcmu ack does not greet after the arm was cleared by error');
  } else {
    fail('later session.updated greeted after an error cleared the arm');
  }

  const thrown = freshSession({ callSid: 'call-throw' });
  let threw = false;
  try {
    onGrokSocketOpen(thrown, () => {
      throw new Error('send failed');
    });
  } catch (err) {
    threw = err && err.message === 'send failed';
  }
  const throwSent = [];
  if (threw && thrown.awaitingAudioConfigAck === false && thrown.openerSent === false) {
    pass('a thrown initial session.update clears the opener arm');
  } else {
    fail('thrown session.update left the opener arm armed');
  }
  handleGrokEvent(thrown, pcmuAck(), {
    sendGrok: (_session, obj) => throwSent.push(obj),
  });
  if (responseCreates(throwSent).length === 0) {
    pass('a later pcmu ack does not greet after the initial send threw');
  } else {
    fail('later session.updated greeted after the initial send threw');
  }

  const speaking = freshSession({ callSid: 'call-speaking' });
  const speakingSent = [];
  const speakingSend = (_session, obj) => speakingSent.push(obj);
  onGrokSocketOpen(speaking, speakingSend);
  speaking.userSpeaking = true;
  handleGrokEvent(speaking, pcmuAck(), { sendGrok: speakingSend });
  speaking.userSpeaking = false;
  handleGrokEvent(speaking, pcmuAck(), { sendGrok: speakingSend });
  if (
    responseCreates(speakingSent).length === 0 &&
    speaking.openerSent === true &&
    speaking.awaitingAudioConfigAck === false
  ) {
    pass('userSpeaking skips the greeting and does not greet on a later ack');
  } else {
    fail('userSpeaking still produced a greeting');
  }

  const spoke = freshSession({ callSid: 'call-spoke' });
  spoke.transcript = [{ role: 'them', text: 'hi' }];
  if (responseCreates(greetCycle(spoke)).length === 0 && spoke.openerSent === true) {
    pass('a callee transcript line skips the greeting');
  } else {
    fail('callee transcript still produced a greeting');
  }

  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const cases = [
      { body: { to: '+15555550100', goal: 'hi', openerOnConnect: 'false' }, expect400: true, label: 'string false' },
      { body: { to: '+15555550100', goal: 'hi', openerOnConnect: 0 }, expect400: true, label: 'number 0' },
      { body: { to: '+15555550100', goal: 'hi', openerOnConnect: null }, expect400: true, label: 'null' },
      { body: { to: '+15555550100', goal: 'hi' }, expect400: false, label: 'omitted' },
      { body: { to: '+15555550100', goal: 'hi', openerOnConnect: false }, expect400: false, label: 'boolean false' },
      { body: { to: '+15555550100', goal: 'hi', openerOnConnect: true }, expect400: false, label: 'boolean true' },
    ];
    for (const item of cases) {
      const result = await postCall(port, item.body);
      const is400 = result.status === 400 && result.json && result.json.error === 'openerOnConnect must be a boolean when provided';
      if (item.expect400 && is400) {
        pass(`POST /call openerOnConnect ${item.label} is 400`);
      } else if (!item.expect400 && result.status === 500 && result.json && result.json.error === 'Twilio client not configured') {
        pass(`POST /call openerOnConnect ${item.label} passes the boolean check`);
      } else {
        fail(`POST /call openerOnConnect ${item.label} status=${result.status} body=${JSON.stringify(result.json)}`);
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  if (failed > 0) {
    console.error(`\n${failed} opener test(s) failed`);
    process.exit(1);
  }
  console.log('\n✓ All connect opener tests passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
