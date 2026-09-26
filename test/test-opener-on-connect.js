#!/usr/bin/env node
'use strict';

process.env.BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || 'operator-test-key';
delete process.env.OPENER_ON_CONNECT;

const {
  createSession,
  handleGrokEvent,
  onGrokSocketOpen,
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

function main() {
  const sent = [];
  const send = (_session, obj) => {
    sent.push(obj);
  };
  const session = freshSession();

  handleGrokEvent(session, { type: 'session.created' }, { sendGrok: send });
  handleGrokEvent(session, { type: 'session.updated' }, { sendGrok: send });
  if (responseCreates(sent).length === 0 && session.openerSent === false) {
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
  if (audioReady && responseCreates(sent).length === 0) {
    pass('socket open sends audio format and does not greet yet');
  } else {
    fail('socket open did not apply audio format before any greeting');
  }

  handleGrokEvent(session, { type: 'session.created' }, { sendGrok: send });
  if (responseCreates(sent).length === 0) {
    pass('session.created does not greet');
  } else {
    fail('session.created sent response.create');
  }

  handleGrokEvent(session, { type: 'session.updated' }, { sendGrok: send });
  handleGrokEvent(session, { type: 'session.updated' }, { sendGrok: send });
  onGrokSocketOpen(session, send);
  handleGrokEvent(session, { type: 'session.updated' }, { sendGrok: send });
  if (responseCreates(sent).length === 1 && responseCreates(sent)[0].type === 'response.create') {
    pass('first session.updated greets once and later updates do not');
  } else {
    fail(`expected one response.create, saw ${responseCreates(sent).length}`);
  }

  delete process.env.OPENER_ON_CONNECT;
  const optedOut = freshSession({ callSid: 'call-2', openerOnConnect: false });
  const optedSent = [];
  const optedSend = (_session, obj) => optedSent.push(obj);
  onGrokSocketOpen(optedOut, optedSend);
  handleGrokEvent(optedOut, { type: 'session.updated' }, { sendGrok: optedSend });
  if (responseCreates(optedSent).length === 0) {
    pass('per-call openerOnConnect false skips the greeting');
  } else {
    fail('per-call opt-out still greeted');
  }

  process.env.OPENER_ON_CONNECT = '0';
  const envOff = freshSession({ callSid: 'call-3' });
  const envSent = [];
  const envSend = (_session, obj) => envSent.push(obj);
  onGrokSocketOpen(envOff, envSend);
  handleGrokEvent(envOff, { type: 'session.updated' }, { sendGrok: envSend });
  if (responseCreates(envSent).length === 0) {
    pass('OPENER_ON_CONNECT=0 skips the greeting');
  } else {
    fail('env opt-out still greeted');
  }

  const forced = freshSession({ callSid: 'call-4', openerOnConnect: true });
  const forcedSent = [];
  const forcedSend = (_session, obj) => forcedSent.push(obj);
  onGrokSocketOpen(forced, forcedSend);
  handleGrokEvent(forced, { type: 'session.updated' }, { sendGrok: forcedSend });
  if (responseCreates(forcedSent).length === 1) {
    pass('per-call true greets even when OPENER_ON_CONNECT=0');
  } else {
    fail('per-call true did not greet');
  }

  process.env.OPENER_ON_CONNECT = 'false';
  const notExact = freshSession({ callSid: 'call-5' });
  const notExactSent = [];
  const notExactSend = (_session, obj) => notExactSent.push(obj);
  onGrokSocketOpen(notExact, notExactSend);
  handleGrokEvent(notExact, { type: 'session.updated' }, { sendGrok: notExactSend });
  if (responseCreates(notExactSent).length === 1) {
    pass("only the exact value 0 disables the greeting");
  } else {
    fail('non-exact env value disabled the greeting');
  }

  delete process.env.OPENER_ON_CONNECT;
  if (failed > 0) {
    console.error(`\n${failed} opener test(s) failed`);
    process.exit(1);
  }
  console.log('\n✓ All connect opener tests passed');
  process.exit(0);
}

main();
