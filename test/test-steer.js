#!/usr/bin/env node
'use strict';

process.env.BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || 'ci-test-key';

const http = require('http');
const { app, applyOperatorSteer } = require('../src/server.js');

const KEY = process.env.BRIDGE_API_KEY;
let failed = 0;

function fail(message) {
  console.error(`  ✗ ${message}`);
  failed += 1;
}

function pass(message) {
  console.log(`  ✓ ${message}`);
}

function counts(sent) {
  return {
    update: sent.filter((obj) => obj.type === 'session.update').length,
    create: sent.filter((obj) => obj.type === 'response.create').length,
  };
}

function steer(session, text, respond) {
  const sent = [];
  const options = { send: (obj) => sent.push(obj) };
  if (respond !== undefined) options.respond = respond;
  applyOperatorSteer(session, text, options);
  return counts(sent);
}

function freshSession() {
  return {
    callSid: 'call-1',
    goal: 'Book a table for two',
    context: 'weekday evening',
    style: 'support',
    instructions: 'STALE',
  };
}

const silent = steer(freshSession(), 'note', false);
if (silent.update === 1 && silent.create === 0) {
  pass('respond false sends one session.update and no response.create');
} else {
  fail(`respond false counts ${JSON.stringify(silent)}`);
}

const omitted = steer(freshSession(), 'note', undefined);
if (omitted.update === 1 && omitted.create === 1) {
  pass('omitted respond sends session.update and response.create');
} else {
  fail(`omitted respond counts ${JSON.stringify(omitted)}`);
}

const spoken = steer(freshSession(), 'note', true);
if (spoken.update === 1 && spoken.create === 1) {
  pass('respond true sends session.update and response.create');
} else {
  fail(`respond true counts ${JSON.stringify(spoken)}`);
}

const replaced = freshSession();
applyOperatorSteer(replaced, 'first note', { respond: false, send: () => {} });
applyOperatorSteer(replaced, 'second note', { respond: false, send: () => {} });
if (
  replaced.instructions.includes('second note') &&
  !replaced.instructions.includes('first note') &&
  !replaced.instructions.includes('STALE') &&
  replaced.instructions.includes('Book a table for two')
) {
  pass('each steer replaces prior coaching');
} else {
  fail('coaching was not rebuilt from the base instructions');
}

function post(body, headers) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/steer',
          method: 'POST',
          headers: Object.assign(
            {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            },
            headers || {}
          ),
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            server.close(() => {
              resolve({
                status: res.statusCode,
                body: Buffer.concat(chunks).toString('utf8'),
              });
            });
          });
        }
      );
      req.on('error', (err) => {
        server.close(() => reject(err));
      });
      req.write(payload);
      req.end();
    });
  });
}

async function main() {
  const unauth = await post({ callSid: 'call-1', text: 'hello', respond: false });
  if (unauth.status === 401) pass('missing auth is 401');
  else fail(`missing auth status ${unauth.status} body ${unauth.body}`);

  const auth = { authorization: `Bearer ${KEY}` };
  const cases = ['false', 0, null, 1, 'true'];
  for (const respond of cases) {
    const res = await post({ callSid: 'call-1', text: 'hello', respond }, auth);
    if (res.status === 400) pass(`non-boolean respond ${JSON.stringify(respond)} is 400`);
    else fail(`respond ${JSON.stringify(respond)} status ${res.status} body ${res.body}`);
  }

  const missingSession = await post({ callSid: 'call-1', text: 'hello', respond: false }, auth);
  if (missingSession.status === 404) pass('boolean false with no session is 404, not 400');
  else fail(`false without session status ${missingSession.status}`);

  if (failed > 0) {
    console.error(`\n${failed} steer test(s) failed`);
    process.exit(1);
  }
  console.log('\n✓ All steer tests passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
