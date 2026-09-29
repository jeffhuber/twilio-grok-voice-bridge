#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'style-packs-root-'));
const tmp = path.join(scratch, 'packs');
const outsideDir = path.join(scratch, 'outside-not-in-packs');
fs.mkdirSync(tmp);
const serverPath = path.join(__dirname, '..', 'src', 'server.js');

const MAPPED = '+15555550100';
const MAPPED_SPACED = '+1 555 555 0100';
const ALIAS_MAPPED = '+15555550101';
const UNKNOWN_TARGET = '+15555550199';
const UNMAPPED = '+15555550102';
const SECRET_IN_BAD_JSON = '+15555550177';
const FILE_NUMBERS = ['+15555550188', '+15555550166', '+15555550155'];

const CANARIES = [
  'CANARY_INVALID_NAME',
  'CANARY_NOT_OBJECT',
  'CANARY_BAD_SOFT',
  'CANARY_BUILTIN_NAME',
  'CANARY_BUILTIN_ALIAS',
  'CANARY_DUPLICATE',
  'CANARY_MALFORMED',
  'CANARY_ALIAS_DUP',
  'CANARY_NOTES',
  'CANARY_NESTED',
  'CANARY_EXTRA_KEY',
  'CANARY_LINKED',
  'CANARY_ESCAPED',
];

const GENERIC_NUDGE =
  '[bridge-continue] The other party is still on the line and quiet. Speak now: next 1–2 new sentences (or finish). Do not wait. Do not repeat yourself. If the call is done, say goodbye and include [[HANGUP_REQUESTED]].';
const PACK_NUDGE = '[bridge-continue] Offer one short warm sentence, or finish the call.';
const HANGUP_TOKEN_LINES = [
  'say a brief polite closing if appropriate, then include the exact token [[HANGUP_REQUESTED]]',
  'in your spoken or textual response so the bridge can detect it.',
  'Do NOT hang up yourself — wait for the operator to approve hangup.',
].join('\n');
const PACK_NUDGE_WITH_TOKEN = `${PACK_NUDGE}\n${HANGUP_TOKEN_LINES}`;
const TOKEN_PROMPT = 'Close now and include [[HANGUP_REQUESTED]].';
const INVALID_AUTO_KEY = '15555550123';
const PACK_COUNT = 4;

const captured = [];
const orig = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  info: console.info,
};

function record(args) {
  captured.push(args.map((part) => (typeof part === 'string' ? part : String(part))).join(' '));
}

for (const level of Object.keys(orig)) {
  console[level] = (...args) => {
    record(args);
    orig[level](...args);
  };
}

let failed = 0;

function fail(message) {
  orig.error(`  ✗ ${message}`);
  failed += 1;
}

function pass(message) {
  orig.log(`  ✓ ${message}`);
}

function assert(condition, message) {
  if (condition) pass(message);
  else fail(message);
}

function writeJson(name, value) {
  fs.writeFileSync(path.join(tmp, name), `${JSON.stringify(value, null, 2)}\n`);
}

function installFixtures() {
  writeJson('10-warm-personal.json', {
    name: 'warm-personal',
    description: 'Warm personal pacing for a private call',
    aliases: ['warm'],
    role: 'You are placing a warm personal phone call.',
    coaching: ['Keep the tone warm and brief.', 'Do not invent personal details.'],
    closing: 'Thank them and say goodbye.',
    softContinue: true,
    softContinuePrompt: PACK_NUDGE,
    extraNote: 'CANARY_EXTRA_KEY',
  });
  writeJson('15-token-close.json', {
    name: 'token-close',
    description: 'Closing already names the hangup token',
    role: 'You are placing a short phone call.',
    closing: 'Say goodbye and include [[HANGUP_REQUESTED]] once.',
    softContinue: false,
    softContinuePrompt: TOKEN_PROMPT,
  });
  writeJson('16-generic-close.json', {
    name: 'generic-close',
    description: 'No closing of its own',
    role: 'You are placing a plain phone call.',
  });
  writeJson('20-invalid-name.json', {
    name: 'Not A Valid Name',
    role: 'CANARY_INVALID_NAME should not load',
  });
  fs.writeFileSync(path.join(tmp, '25-not-object.json'), '["CANARY_NOT_OBJECT"]\n');
  writeJson('22-bad-soft.json', {
    name: 'bad-soft',
    role: 'CANARY_BAD_SOFT should not load',
    softContinue: 'yes',
  });
  writeJson('30-builtin-name.json', {
    name: 'support',
    role: 'CANARY_BUILTIN_NAME should not load',
  });
  writeJson('35-builtin-alias.json', {
    name: 'polite-errand',
    role: 'CANARY_BUILTIN_ALIAS should not load',
    aliases: ['errand'],
  });
  writeJson('40-duplicate-name.json', {
    name: 'warm-personal',
    role: 'CANARY_DUPLICATE should not replace the first pack',
    aliases: ['second-warm'],
  });
  fs.writeFileSync(
    path.join(tmp, '50-malformed.json'),
    '{ "note": "CANARY_MALFORMED", "phone": "+15555550188"\n'
  );
  writeJson('60-alias-dup.json', {
    name: 'other-warm',
    role: 'CANARY_ALIAS_DUP should not load',
    aliases: ['warm'],
  });
  const targets = path.join(tmp, 'targets');
  fs.mkdirSync(targets);
  fs.writeFileSync(
    path.join(targets, 'inside.json'),
    `${JSON.stringify({
      name: 'linked-style',
      description: 'Loaded through a symlink inside the pack directory',
      aliases: ['linked'],
      role: 'You are placing a linked phone call.',
      extraNote: 'CANARY_LINKED',
      softContinue: false,
    })}\n`
  );
  fs.symlinkSync(path.join(targets, 'inside.json'), path.join(tmp, '70-linked.json'));
  fs.symlinkSync(targets, path.join(tmp, '80-dir-link.json'));
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(
    path.join(outsideDir, 'pack.json'),
    `${JSON.stringify({
      name: 'escaped-style',
      aliases: ['escaped'],
      role: 'CANARY_ESCAPED should not load',
    })}\n`
  );
  fs.symlinkSync(path.join(outsideDir, 'pack.json'), path.join(tmp, '71-escape.json'));
  fs.symlinkSync(path.join(tmp, 'missing-target.json'), path.join(tmp, '90-broken.json'));
  fs.writeFileSync(path.join(tmp, 'notes.txt'), 'CANARY_NOTES +15555550166\n');
  fs.mkdirSync(path.join(tmp, 'nested'));
  fs.writeFileSync(
    path.join(tmp, 'nested', 'pack.json'),
    `${JSON.stringify({
      name: 'nested-pack',
      role: 'CANARY_NESTED should not load',
      coaching: '+15555550155',
    })}\n`
  );
}

function request(port, method, urlPath, body, options) {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const headers = {};
    if (opts.auth !== false) {
      headers.Authorization = `Bearer ${process.env.BRIDGE_API_KEY}`;
    }
    if (payload != null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (err) {
            json = null;
          }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

function runChild(extraEnv) {
  const script = [
    `require(${JSON.stringify(serverPath)});`,
    'process.stdout.write("STARTED\\n");',
    'process.exit(0);',
  ].join('\n');
  return spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign(
      {
        PATH: process.env.PATH || '',
        HOME: process.env.HOME || '',
        NODE_ENV: 'test',
        BRIDGE_API_KEY: 'operator-test-key-0123456789abcdef',
        PUBLIC_HOST: 'bridge.example.com',
      },
      extraEnv
    ),
    encoding: 'utf8',
    timeout: 10000,
  });
}

function childText(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

async function waitFor(fn, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() <= deadline) {
    if (fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return fn();
}

function nudgeText(sent) {
  const item = sent.find((obj) => obj.type === 'conversation.item.create');
  if (!item || !item.item || !item.item.content || !item.item.content[0]) return '';
  return item.item.content[0].text;
}

function armNudge(session) {
  const sent = [];
  session.grokWs = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
  return sent;
}

function assertOrder(text, parts, label) {
  let cursor = -1;
  for (const part of parts) {
    const at = text.indexOf(part);
    if (at < 0 || at <= cursor) {
      fail(`${label}: missing or out of order (${part.slice(0, 48)})`);
      return;
    }
    cursor = at;
  }
  pass(label);
}

function logsContain(needle) {
  return captured.some((line) => line.includes(needle));
}

async function main() {
  installFixtures();

  for (const name of [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_FROM_NUMBER',
    'XAI_API_KEY',
    'ENABLE_RECORDING',
    'SKIP_AI_DISCLOSURE',
    'CONTACT_FULL_NAME',
    'CONTACT_MOBILE',
    'SUPPORT_ANNOUNCE_CONTACT_NAME',
    'ALLOW_PER_CALL_DISCLOSURE_OFF',
    'ALLOW_PER_CALL_RECORDING',
    'VAD_THRESHOLD',
    'VAD_SILENCE_MS',
    'VAD_SOFT_THRESHOLD',
    'VAD_SOFT_SILENCE_MS',
    'LOG_TRANSCRIPTS',
  ]) {
    delete process.env[name];
  }
  process.env.NODE_ENV = 'test';
  process.env.BRIDGE_API_KEY = 'operator-test-key-0123456789abcdef';
  process.env.PUBLIC_HOST = 'bridge.example.com';
  process.env.SOFT_CONTINUE_MS = '40';
  process.env.STYLE_PACKS_DIR = tmp;
  process.env.STYLE_AUTO_SELECT = JSON.stringify({
    [MAPPED_SPACED]: 'warm-personal',
    [ALIAS_MAPPED]: 'warm',
    [UNKNOWN_TARGET]: 'no-such-style',
    [INVALID_AUTO_KEY]: 'warm-personal',
    '+1': 'support',
  });

  const autoSelectRaw = process.env.STYLE_AUTO_SELECT;
  const server = require(serverPath);
  const {
    app,
    createSession,
    applyOperatorSteer,
    handleGrokEvent,
    setTwilioClientForTests,
    loadStylePacksForTests,
    loadStyleAutoSelectForTests,
    sessionsByCallSid,
  } = server;

  assert(typeof setTwilioClientForTests === 'function', 'test Twilio client setter is exported');
  assert(typeof loadStylePacksForTests === 'function', 'style pack reload helper is exported');

  const skipLines = captured.filter((line) => line.includes('style pack skipped'));
  assert(
    skipLines.some((line) => line.includes('20-invalid-name.json') && line.includes('reason=invalid name')),
    'invalid name is skipped with the file name and reason'
  );
  assert(
    skipLines.some((line) => line.includes('25-not-object.json') && line.includes('reason=style pack must be a JSON object')),
    'a JSON array pack is skipped'
  );
  assert(
    skipLines.some((line) => line.includes('22-bad-soft.json') && line.includes('reason=softContinue must be a boolean')),
    'a non-boolean softContinue is skipped'
  );
  assert(
    skipLines.some((line) => line.includes('30-builtin-name.json') && line.includes('reason=name reuses a built-in style')),
    'a built-in name collision is skipped'
  );
  assert(
    skipLines.some((line) => line.includes('35-builtin-alias.json') && line.includes('reason=alias reuses a built-in style')),
    'a built-in alias collision is skipped'
  );
  assert(
    skipLines.some((line) => line.includes('40-duplicate-name.json') && line.includes('reason=name reuses another style pack')),
    'a duplicate pack name is skipped'
  );
  assert(
    skipLines.some((line) => line.includes('50-malformed.json') && line.includes('reason=malformed JSON')),
    'malformed JSON is skipped'
  );
  assert(
    skipLines.some((line) => line.includes('60-alias-dup.json') && line.includes('reason=alias reuses another style pack')),
    'a duplicate alias is skipped'
  );
  assert(!skipLines.some((line) => line.includes('10-warm-personal.json')), 'the valid pack is not skipped');
  assert(!skipLines.some((line) => line.includes('15-token-close.json')), 'the token closing pack is not skipped');
  assert(!skipLines.some((line) => line.includes('16-generic-close.json')), 'a pack with no closing is not skipped');
  assert(!skipLines.some((line) => line.includes('70-linked.json')), 'a symlink to a regular file inside the pack directory is not skipped');
  assert(
    skipLines.some((line) => line.includes('71-escape.json') && line.includes('reason=symlink escapes the pack directory')),
    'a symlink to a file outside the pack directory is skipped'
  );
  assert(
    !captured.some((line) => line.includes(outsideDir) || line.includes('outside-not-in-packs') || line.includes(scratch)),
    'pack-directory logs do not include the outside path or the scratch path'
  );
  assert(
    skipLines.some((line) => line.includes('80-dir-link.json') && line.includes('reason=not a regular file')),
    'a symlink to a directory is not loaded as a pack'
  );
  assert(
    skipLines.some((line) => line.includes('90-broken.json') && line.includes('reason=unreadable')),
    'a broken symlink is skipped'
  );
  assert(
    captured.some((line) => line.includes('unknown style') && line.includes('xxxxxxxx0199')),
    'unknown auto-select target is dropped and the number is masked'
  );
  assert(
    captured.some((line) => line.includes('key must be E.164') && line.includes('xxxxxxx0123')) &&
      !captured.some((line) => line.includes(INVALID_AUTO_KEY)),
    'a non-E.164 auto-select key is dropped and the number is masked'
  );

  const calls = [];
  setTwilioClientForTests({
    calls: {
      create(params) {
        calls.push(params);
        return Promise.resolve({ sid: `CA${calls.length}`, status: 'queued' });
      },
    },
  });

  const httpServer = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => httpServer.once('listening', resolve));
    const port = httpServer.address().port;
    const health = await request(port, 'GET', '/health', null, { auth: false });
    assert(health.status === 200 && health.json && health.json.ok === true, 'unauthenticated GET /health responds');
    const styles = (health.json && health.json.styles) || [];
    assert(
      styles.length === 3 &&
        styles[0] === 'support' &&
        styles[1] === 'restaurant-book' &&
        styles[2] === 'custom',
      'unauthenticated /health styles lists only the built-ins'
    );
    assert(health.json.stylePackCount === PACK_COUNT, 'stylePackCount counts loaded packs');
    for (const secret of ['warm-personal', 'warm', 'token-close', 'generic-close', 'linked-style', 'linked', 'escaped-style', 'escaped']) {
      assert(!health.text.includes(secret), `unauthenticated /health does not include ${secret}`);
    }
    assert(health.json.styleAutoSelectCount === 2, 'styleAutoSelectCount counts only kept entries');
    assert(health.json.aiDisclosureDefault === true, 'aiDisclosureDefault is true when disclosure is on');
    assert(!health.text.includes('555555'), '/health body does not include destination digits');
    assert(!Object.prototype.hasOwnProperty.call(health.json, 'styleAutoSelect'), '/health does not include the number map');

    const shaped = createSession({
      callSid: 'shape-1',
      goal: 'Confirm a dinner time',
      context: 'Tuesday evening',
      style: 'warm',
    });
    assert(shaped.style === 'warm-personal', 'alias warm resolves to warm-personal');
    const linked = createSession({
      callSid: 'shape-linked',
      goal: 'Confirm a dinner time',
      style: 'linked',
    });
    assert(linked.style === 'linked-style', 'a symlink to a file inside the pack directory loads and its alias resolves');
    assert(!linked.instructions.includes('CANARY_LINKED'), 'a symlinked pack ignores unknown keys');
    const escaped = createSession({
      callSid: 'shape-escaped',
      goal: 'Confirm a dinner time',
      style: 'escaped',
    });
    assert(escaped.style === 'custom', 'a symlink that leaves the pack directory does not load a style');
    assert(!escaped.instructions.includes('CANARY_ESCAPED'), 'an escaped pack is not sent to the model');
    assert(shaped.softContinue === true, 'omitted softContinue uses the pack default');
    assert(shaped.vadThreshold === 0.72 && shaped.vadSilenceMs === 350, 'pack softContinue selects soft VAD');
    assert(!shaped.instructions.includes('CANARY_EXTRA_KEY'), 'unknown pack keys are not copied into instructions');
    assert(!shaped.instructions.includes('CANARY_DUPLICATE'), 'a duplicate file does not replace the first pack');
    assertOrder(
      shaped.instructions,
      [
        'You are placing a warm personal phone call.',
        'Your goal for this call: Confirm a dinner time',
        'Additional context:',
        'Tuesday evening',
        'Keep the tone warm and brief.',
        'Do not invent personal details.',
        '## Speech manners (UNIVERSAL)',
        '## AI disclosure',
        'NEVER lie about being human',
        'Never mention that you are being coached or that an operator is listening.',
        'Thank them and say goodbye.',
        'say a brief polite closing if appropriate, then include the exact token [[HANGUP_REQUESTED]]',
      ],
      'pack instructions follow role, goal, context, coaching, rules, disclosure, and closing'
    );

    const overridden = createSession({
      callSid: 'shape-off',
      goal: 'Confirm a dinner time',
      style: 'warm-personal',
      softContinue: false,
    });
    assert(overridden.softContinue === false, 'explicit softContinue false overrides the pack default');
    assert(overridden.vadThreshold === 0.7 && overridden.vadSilenceMs === 800, 'explicit false uses the normal VAD');

    const stringSoft = createSession({
      callSid: 'shape-string',
      goal: 'Confirm a dinner time',
      style: 'token-close',
      softContinue: 'true',
    });
    assert(stringSoft.softContinue === false, 'a non-boolean softContinue falls through to the pack default');

    const tokenClose = createSession({
      callSid: 'shape-token',
      goal: 'Confirm a dinner time',
      style: 'token-close',
    });
    const tokenHits = tokenClose.instructions.split('[[HANGUP_REQUESTED]]').length - 1;
    assert(tokenHits === 1, 'a closing that already has the hangup token is not given another copy');
    assert(
      tokenClose.instructions.includes('Say goodbye and include [[HANGUP_REQUESTED]] once.'),
      'pack closing text is kept when it already has the token'
    );
    assert(
      !tokenClose.instructions.includes('say a brief polite closing if appropriate'),
      'generic hangup lines are not appended when the closing already has the token'
    );

    const genericClose = createSession({
      callSid: 'shape-generic-close',
      goal: 'Confirm a dinner time',
      style: 'generic-close',
    });
    assert(
      genericClose.instructions.includes(
        'When the goal succeeds OR the call is a clear dead-end (wrong number, closed permanently, hostile hangup),'
      ) &&
        genericClose.instructions.split('[[HANGUP_REQUESTED]]').length - 1 === 1,
      'a pack with no closing uses the generic custom closing once'
    );

    const spaced = createSession({
      callSid: 'shape-spaced',
      goal: 'Confirm a dinner time',
      to: MAPPED_SPACED,
    });
    assert(spaced.style === 'warm-personal', 'auto-select matches after whitespace is stripped');

    const explicitWins = createSession({
      callSid: 'shape-explicit',
      goal: 'Confirm a dinner time',
      style: 'support',
      to: MAPPED,
    });
    assert(explicitWins.style === 'support', 'an explicit style wins over auto-select');

    const unknownExplicit = createSession({
      callSid: 'shape-unknown',
      goal: 'Confirm a dinner time',
      style: 'mystery-style',
      to: MAPPED,
    });
    assert(unknownExplicit.style === 'custom', 'an unknown explicit style still falls through to custom');
    assert(
      unknownExplicit.instructions.startsWith('You are placing a phone call. Follow the goal and context below.'),
      'unknown styles keep the custom instruction opening'
    );
    assert(
      !unknownExplicit.instructions.includes('Keep the tone warm and brief.'),
      'an unknown explicit style does not take the auto-selected pack'
    );

    async function place(body) {
      const before = calls.length;
      const result = await request(port, 'POST', '/call', body);
      return { result, before };
    }

    const autoCall = await place({ to: MAPPED, goal: 'Confirm a dinner time' });
    assert(
      autoCall.result.status === 200 && autoCall.result.json && autoCall.result.json.style === 'warm-personal',
      'omitted style uses the auto-selected pack'
    );
    assert(autoCall.result.json && autoCall.result.json.softContinue === true, 'auto-selected pack default softContinue is returned');
    assert(autoCall.result.json && autoCall.result.json.discloseAi === true, 'omitted discloseAi returns the default true');
    assert(autoCall.result.json && autoCall.result.json.record === false, 'omitted record stays off when the global flag is off');
    assert(calls.length === autoCall.before + 1, 'a successful call reaches Twilio create');
    assert(calls[calls.length - 1].record === false, 'global recording off passes record false');
    assert(calls[calls.length - 1].recordingChannels === undefined, 'recording channels are omitted when record is false');

    const forcedStyle = await place({ to: MAPPED, goal: 'Confirm a dinner time', style: 'support' });
    assert(
      forcedStyle.result.status === 200 && forcedStyle.result.json && forcedStyle.result.json.style === 'support',
      'explicit support wins over the mapped number'
    );

    const aliasCall = await place({ to: UNMAPPED, goal: 'Confirm a dinner time', style: 'warm' });
    assert(
      aliasCall.result.status === 200 && aliasCall.result.json && aliasCall.result.json.style === 'warm-personal',
      'POST /call resolves a pack alias'
    );

    const emptyStyle = await place({ to: ALIAS_MAPPED, goal: 'Confirm a dinner time', style: '' });
    assert(
      emptyStyle.result.status === 200 && emptyStyle.result.json && emptyStyle.result.json.style === 'warm-personal',
      'an empty style is treated as omitted and the alias map applies'
    );

    const nullStyle = await place({ to: MAPPED, goal: 'Confirm a dinner time', style: null });
    assert(
      nullStyle.result.status === 200 && nullStyle.result.json && nullStyle.result.json.style === 'warm-personal',
      'null style is treated as omitted'
    );

    const plain = await place({ to: UNMAPPED, goal: 'Confirm a dinner time' });
    assert(
      plain.result.status === 200 && plain.result.json && plain.result.json.style === 'support',
      'an unmapped number with no style stays on support'
    );

    const dropped = await place({ to: UNKNOWN_TARGET, goal: 'Confirm a dinner time' });
    assert(
      dropped.result.status === 200 && dropped.result.json && dropped.result.json.style === 'support',
      'a dropped auto-select entry does not change the call style'
    );

    const softOff = await place({ to: MAPPED, goal: 'Confirm a dinner time', softContinue: false });
    assert(
      softOff.result.status === 200 && softOff.result.json && softOff.result.json.softContinue === false,
      'POST /call softContinue false overrides the pack default'
    );

    delete process.env.ALLOW_PER_CALL_DISCLOSURE_OFF;
    delete process.env.ALLOW_PER_CALL_RECORDING;
    const refusedDisclosureBefore = calls.length;
    const refusedDisclosure = await request(port, 'POST', '/call', {
      to: UNMAPPED,
      goal: 'Confirm a dinner time',
      discloseAi: false,
    });
    assert(
      refusedDisclosure.status === 403 &&
        refusedDisclosure.json &&
        refusedDisclosure.json.error === 'discloseAi false requires ALLOW_PER_CALL_DISCLOSURE_OFF=1' &&
        calls.length === refusedDisclosureBefore,
      'discloseAi false is 403 and does not place a call when the allow flag is off'
    );
    const refusedRecordBefore = calls.length;
    const refusedRecord = await request(port, 'POST', '/call', {
      to: UNMAPPED,
      goal: 'Confirm a dinner time',
      record: true,
    });
    assert(
      refusedRecord.status === 403 &&
        refusedRecord.json &&
        refusedRecord.json.error === 'record true requires ALLOW_PER_CALL_RECORDING=1' &&
        calls.length === refusedRecordBefore,
      'record true is 403 and does not place a call when the allow flag is off'
    );
    process.env.ALLOW_PER_CALL_RECORDING = 'true';
    const wordyRecordBefore = calls.length;
    const wordyRecord = await request(port, 'POST', '/call', {
      to: UNMAPPED,
      goal: 'Confirm a dinner time',
      record: true,
    });
    assert(
      wordyRecord.status === 403 && calls.length === wordyRecordBefore,
      'ALLOW_PER_CALL_RECORDING=true does not enable per-call recording'
    );
    delete process.env.ALLOW_PER_CALL_RECORDING;

    process.env.ALLOW_PER_CALL_DISCLOSURE_OFF = '1';
    process.env.ALLOW_PER_CALL_RECORDING = '1';
    const unauthBefore = calls.length;
    const unauth = await request(
      port,
      'POST',
      '/call',
      { to: UNMAPPED, goal: 'Confirm a dinner time', record: true, discloseAi: false },
      { auth: false }
    );
    assert(
      unauth.status === 401 &&
        unauth.json &&
        unauth.json.error === 'unauthorized' &&
        calls.length === unauthBefore,
      'unauthenticated POST /call with record true and discloseAi false is 401 and does not call Twilio'
    );

    const overrideLogStart = captured.length;
    const honored = await place({
      to: UNMAPPED,
      goal: 'Confirm a dinner time',
      discloseAi: false,
      record: true,
    });
    const honoredSid = honored.result.json && honored.result.json.callSid;
    const honoredLogs = captured.slice(overrideLogStart);
    const disclosureLog = honoredLogs.find((line) => line.includes('disclosure=off'));
    const recordingLog = honoredLogs.find((line) => line.includes('recording=on'));
    assert(
      honored.result.status === 200 &&
        disclosureLog === `[call] disclosure=off callSid=${honoredSid}` &&
        recordingLog === `[call] recording=on callSid=${honoredSid}`,
      'honored overrides log disclosure=off and recording=on with the call SID and no phone number'
    );

    const disclosureCases = [
      { skip: undefined, discloseAi: undefined, effective: true, inText: true, label: 'default disclosure on' },
      { skip: undefined, discloseAi: false, effective: false, inText: false, label: 'discloseAi false omits the block' },
      { skip: undefined, discloseAi: true, effective: true, inText: true, label: 'discloseAi true keeps the block' },
      { skip: '1', discloseAi: undefined, effective: false, inText: false, label: 'SKIP_AI_DISCLOSURE omits the block' },
      { skip: '1', discloseAi: true, effective: true, inText: true, label: 'discloseAi true overrides SKIP_AI_DISCLOSURE' },
      { skip: '1', discloseAi: false, effective: false, inText: false, label: 'discloseAi false stays off when disclosure is skipped' },
    ];
    for (const item of disclosureCases) {
      if (item.skip === undefined) delete process.env.SKIP_AI_DISCLOSURE;
      else process.env.SKIP_AI_DISCLOSURE = item.skip;
      const body = { to: UNMAPPED, goal: 'Confirm a dinner time', style: 'warm-personal' };
      if (item.discloseAi !== undefined) body.discloseAi = item.discloseAi;
      const placed = await place(body);
      const session = placed.result.json && sessionsByCallSid.get(placed.result.json.callSid);
      const text = session ? session.instructions : '';
      const hasBlock = text.includes('## AI disclosure') && text.includes('NEVER lie about being human');
      const healthNow = await request(port, 'GET', '/health');
      assert(
        placed.result.status === 200 &&
          placed.result.json &&
          placed.result.json.discloseAi === item.effective &&
          hasBlock === item.inText &&
          healthNow.json &&
          healthNow.json.aiDisclosureDefault === (item.skip !== '1'),
        item.label
      );
    }

    const invalidDisclose = ['false', 0, null, 1, 'true'];
    for (const skip of [undefined, '1']) {
      if (skip === undefined) delete process.env.SKIP_AI_DISCLOSURE;
      else process.env.SKIP_AI_DISCLOSURE = skip;
      for (const value of invalidDisclose) {
        const before = calls.length;
        const result = await request(port, 'POST', '/call', {
          to: UNMAPPED,
          goal: 'Confirm a dinner time',
          discloseAi: value,
        });
        const skipLabel = skip === '1' ? 'with SKIP_AI_DISCLOSURE' : 'without SKIP_AI_DISCLOSURE';
        assert(
          result.status === 400 &&
            result.json &&
            result.json.error === 'discloseAi must be a boolean when provided' &&
            calls.length === before,
          `discloseAi ${JSON.stringify(value)} is 400 ${skipLabel}`
        );
      }
    }
    delete process.env.SKIP_AI_DISCLOSURE;
    delete process.env.ALLOW_PER_CALL_DISCLOSURE_OFF;

    async function assertRecord(body, expected, label) {
      const before = calls.length;
      const result = await request(port, 'POST', '/call', body);
      const params = calls[calls.length - 1];
      const channelsOk = expected ? params && params.recordingChannels === 'dual' : params && params.recordingChannels === undefined;
      assert(
        result.status === 200 &&
          result.json &&
          result.json.record === expected &&
          calls.length === before + 1 &&
          params &&
          params.record === expected &&
          channelsOk,
        label
      );
    }

    delete process.env.ENABLE_RECORDING;
    process.env.ALLOW_PER_CALL_RECORDING = '1';
    await assertRecord({ to: UNMAPPED, goal: 'Confirm a dinner time' }, false, 'record omitted stays off by default');
    await assertRecord({ to: UNMAPPED, goal: 'Confirm a dinner time', record: true }, true, 'record true requests dual-channel recording when the global flag is off');
    await assertRecord({ to: UNMAPPED, goal: 'Confirm a dinner time', record: false }, false, 'record false stays off when the global flag is off');

    process.env.ENABLE_RECORDING = '1';
    await assertRecord({ to: UNMAPPED, goal: 'Confirm a dinner time' }, true, 'record omitted follows ENABLE_RECORDING=1');
    await assertRecord({ to: UNMAPPED, goal: 'Confirm a dinner time', record: false }, false, 'record false overrides ENABLE_RECORDING=1');
    await assertRecord({ to: UNMAPPED, goal: 'Confirm a dinner time', record: true }, true, 'record true stays on when ENABLE_RECORDING=1');

    const invalidRecord = ['true', 0, null, 1];
    for (const flag of [undefined, '1']) {
      if (flag === undefined) delete process.env.ENABLE_RECORDING;
      else process.env.ENABLE_RECORDING = flag;
      for (const value of invalidRecord) {
        const before = calls.length;
        const result = await request(port, 'POST', '/call', {
          to: UNMAPPED,
          goal: 'Confirm a dinner time',
          record: value,
        });
        const flagLabel = flag === '1' ? 'with ENABLE_RECORDING' : 'without ENABLE_RECORDING';
        assert(
          result.status === 400 &&
            result.json &&
            result.json.error === 'record must be a boolean when provided' &&
            calls.length === before,
          `record ${JSON.stringify(value)} is 400 ${flagLabel}`
        );
      }
    }
    delete process.env.ENABLE_RECORDING;
    delete process.env.ALLOW_PER_CALL_RECORDING;

    process.env.SKIP_AI_DISCLOSURE = '1';
    const steeredOn = createSession({
      callSid: 'steer-on',
      goal: 'Confirm a dinner time',
      context: 'Tuesday evening',
      style: 'warm-personal',
      discloseAi: true,
    });
    const steeredMessages = [];
    applyOperatorSteer(steeredOn, 'Ask about the patio.', {
      respond: false,
      send(obj) {
        steeredMessages.push(obj);
      },
    });
    assert(
      steeredOn.instructions.includes('Keep the tone warm and brief.') &&
        steeredOn.instructions.includes('Ask about the patio.') &&
        steeredOn.instructions.includes('## AI disclosure') &&
        steeredOn.instructions.includes('NEVER lie about being human') &&
        steeredMessages.length === 1 &&
        steeredMessages[0].type === 'session.update' &&
        steeredMessages[0].session.instructions === steeredOn.instructions,
      'steer rebuild keeps pack coaching and discloseAi true'
    );

    delete process.env.SKIP_AI_DISCLOSURE;
    const steeredOff = createSession({
      callSid: 'steer-off',
      goal: 'Confirm a dinner time',
      style: 'warm-personal',
      discloseAi: false,
    });
    applyOperatorSteer(steeredOff, 'Ask about the patio.', { respond: false, send() {} });
    assert(
      steeredOff.instructions.includes('Keep the tone warm and brief.') &&
        steeredOff.instructions.includes('Ask about the patio.') &&
        !steeredOff.instructions.includes('## AI disclosure') &&
        !steeredOff.instructions.includes('NEVER lie about being human'),
      'steer rebuild keeps pack coaching and discloseAi false'
    );
    delete process.env.SKIP_AI_DISCLOSURE;

    delete process.env.CONTACT_FULL_NAME;
    const supportPlain = createSession({
      callSid: 'support-plain',
      goal: 'Check a store hour',
      style: 'support',
    });
    assert(
      supportPlain.instructions.split('\n')[0] ===
        'You are placing a phone call to handle an errand or customer-support matter.',
      'support keeps the original first line when CONTACT_FULL_NAME is unset'
    );
    const restaurantPlain = createSession({
      callSid: 'restaurant-plain',
      goal: 'Book a table',
      style: 'restaurant-book',
    });
    assert(
      restaurantPlain.instructions.startsWith('You are placing a phone call to book a restaurant reservation.'),
      'restaurant-book opening stays unchanged'
    );

    process.env.CONTACT_FULL_NAME = 'Example Person';
    delete process.env.SUPPORT_ANNOUNCE_CONTACT_NAME;
    const supportHidden = createSession({
      callSid: 'support-hidden',
      goal: 'Check a store hour',
      style: 'support',
    });
    assert(
      supportHidden.instructions.split('\n')[0] ===
        'You are placing a phone call to handle an errand or customer-support matter.' &&
        !supportHidden.instructions.includes('Example Person'),
      'CONTACT_FULL_NAME does not change support calls unless the support announcement is enabled'
    );
    const restaurantNamed = createSession({
      callSid: 'restaurant-named',
      goal: 'Book a table',
      style: 'restaurant-book',
    });
    assert(
      restaurantNamed.instructions.includes('Example Person'),
      'restaurant-book still uses CONTACT_FULL_NAME when the support announcement is off'
    );
    process.env.SUPPORT_ANNOUNCE_CONTACT_NAME = '1';
    const supportNamed = createSession({
      callSid: 'support-named',
      goal: 'Check a store hour',
      style: 'support',
    });
    assert(
      supportNamed.instructions.split('\n')[0] ===
        'You are placing a phone call on behalf of Example Person to handle an errand or customer-support matter.',
      'support first line names CONTACT_FULL_NAME when SUPPORT_ANNOUNCE_CONTACT_NAME is exactly 1'
    );
    process.env.SUPPORT_ANNOUNCE_CONTACT_NAME = 'true';
    const supportWord = createSession({
      callSid: 'support-word',
      goal: 'Check a store hour',
      style: 'support',
    });
    assert(
      !supportWord.instructions.includes('Example Person'),
      'SUPPORT_ANNOUNCE_CONTACT_NAME=true does not announce the contact name'
    );
    delete process.env.CONTACT_FULL_NAME;
    delete process.env.SUPPORT_ANNOUNCE_CONTACT_NAME;

    const quiet = createSession({
      callSid: 'nudge-quiet',
      goal: 'Confirm a dinner time',
      style: 'warm-personal',
      softContinue: false,
    });
    const quietSent = armNudge(quiet);
    handleGrokEvent(quiet, { type: 'response.done' });
    const quietFired = await waitFor(() => quietSent.length > 0, 150);
    assert(!quietFired && quietSent.length === 0, 'softContinue false does not send a nudge');

    const nudged = createSession({
      callSid: 'nudge-pack',
      goal: 'Confirm a dinner time',
      style: 'warm-personal',
    });
    const nudgedSent = armNudge(nudged);
    handleGrokEvent(nudged, { type: 'response.done' });
    const nudgedFired = await waitFor(() => nudgeText(nudgedSent) === PACK_NUDGE_WITH_TOKEN, 500);
    assert(nudgedFired, 'a pack prompt without the hangup token gets the generic token lines');
    assert(
      nudgedFired && nudgeText(nudgedSent).split('[[HANGUP_REQUESTED]]').length - 1 === 1,
      'the appended prompt contains the hangup token once'
    );
    assert(nudgeText(nudgedSent) !== GENERIC_NUDGE, 'the pack prompt replaces the generic nudge');

    const generic = createSession({
      callSid: 'nudge-generic',
      goal: 'Confirm a dinner time',
      style: 'generic-close',
      softContinue: true,
    });
    const genericSent = armNudge(generic);
    handleGrokEvent(generic, { type: 'response.done' });
    const genericFired = await waitFor(() => nudgeText(genericSent) === GENERIC_NUDGE, 500);
    assert(genericFired, 'a pack without softContinuePrompt keeps the generic nudge');

    const tokenNudge = createSession({
      callSid: 'nudge-token-prompt',
      goal: 'Confirm a dinner time',
      style: 'token-close',
      softContinue: true,
    });
    const tokenSent = armNudge(tokenNudge);
    handleGrokEvent(tokenNudge, { type: 'response.done' });
    const tokenFired = await waitFor(() => nudgeText(tokenSent) === TOKEN_PROMPT, 500);
    assert(tokenFired, 'a prompt that already has the hangup token is not extended');
    assert(
      tokenFired && nudgeText(tokenSent).split('[[HANGUP_REQUESTED]]').length - 1 === 1,
      'a prompt that already has the hangup token keeps a single copy'
    );

    const badJsonLines = [];
    const warnBefore = console.warn;
    console.warn = (...args) => {
      badJsonLines.push(args.map((part) => String(part)).join(' '));
      warnBefore(...args);
    };
    loadStyleAutoSelectForTests(`{"${SECRET_IN_BAD_JSON}":"warm-personal"`);
    console.warn = warnBefore;
    assert(
      badJsonLines.some((line) => line.includes('not valid JSON')) &&
        !badJsonLines.join('\n').includes('555555'),
      'invalid STYLE_AUTO_SELECT JSON warns without logging numbers'
    );
    loadStyleAutoSelectForTests(autoSelectRaw);
    const restored = await request(port, 'GET', '/health');
    assert(restored.json && restored.json.styleAutoSelectCount === 2, 'restoring STYLE_AUTO_SELECT keeps two entries');

    const beforeMissing = captured.length;
    loadStylePacksForTests(path.join(tmp, 'does-not-exist'));
    const missingLines = captured.slice(beforeMissing).filter((line) => line.includes('STYLE_PACKS_DIR'));
    assert(missingLines.length === 1 && missingLines[0].includes('missing or unreadable'), 'a missing directory warns once');
    loadStylePacksForTests(tmp);
    const reloaded = await request(port, 'GET', '/health');
    assert(
      reloaded.json &&
        reloaded.json.stylePackCount === PACK_COUNT &&
        !reloaded.text.includes('warm-personal') &&
        !reloaded.text.includes('linked-style'),
      'reloading the pack directory restores the pack count without listing names'
    );

    const relativeBefore = captured.length;
    loadStylePacksForTests('relative/style-packs');
    const relativeLines = captured.slice(relativeBefore).filter((line) => line.includes('absolute path'));
    assert(relativeLines.length === 1, 'a relative STYLE_PACKS_DIR warns once and is ignored');
    loadStylePacksForTests(tmp);
    loadStyleAutoSelectForTests(autoSelectRaw);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }

  const missingChild = runChild({ STYLE_PACKS_DIR: path.join(tmp, 'missing-at-startup') });
  const missingOut = childText(missingChild);
  const missingWarnings = missingOut.split('\n').filter((line) => line.includes('STYLE_PACKS_DIR is missing or unreadable'));
  assert(
    missingChild.status === 0 && missingOut.includes('STARTED') && missingWarnings.length === 1,
    'a missing STYLE_PACKS_DIR warns once and the server still starts'
  );

  const fileDir = path.join(tmp, 'not-a-directory');
  fs.writeFileSync(fileDir, 'not a directory\n');
  const fileChild = runChild({ STYLE_PACKS_DIR: fileDir });
  const fileOut = childText(fileChild);
  const fileWarnings = fileOut.split('\n').filter((line) => line.includes('STYLE_PACKS_DIR is missing or unreadable'));
  assert(
    fileChild.status === 0 && fileOut.includes('STARTED') && fileWarnings.length === 1,
    'an unreadable STYLE_PACKS_DIR warns once and the server still starts'
  );

  const badChild = runChild({ STYLE_AUTO_SELECT: `{"${SECRET_IN_BAD_JSON}": "warm-personal"` });
  const badOut = childText(badChild);
  assert(
    badChild.status === 0 &&
      badOut.includes('STARTED') &&
      badOut.includes('not valid JSON') &&
      !badOut.includes('555555') &&
      !badOut.includes(SECRET_IN_BAD_JSON),
    'startup ignores invalid STYLE_AUTO_SELECT JSON and does not log the number'
  );

  const forbidden = [
    MAPPED,
    MAPPED_SPACED,
    ALIAS_MAPPED,
    UNKNOWN_TARGET,
    UNMAPPED,
    SECRET_IN_BAD_JSON,
    INVALID_AUTO_KEY,
    ...FILE_NUMBERS,
    '555555',
    '555 555',
  ];
  const leakedLogs = captured.filter((line) => forbidden.some((needle) => line.includes(needle)));
  assert(leakedLogs.length === 0, 'server logs do not contain unmasked numbers');
  const leakedCanaries = captured.filter((line) => CANARIES.some((needle) => line.includes(needle)));
  assert(leakedCanaries.length === 0, 'server logs do not contain style pack file contents');

  fs.rmSync(scratch, { recursive: true, force: true });
  if (failed > 0) {
    orig.error(`\n${failed} style pack test(s) failed`);
    process.exit(1);
  }
  orig.log('\n✓ All style pack tests passed');
  process.exit(0);
}

main().catch((err) => {
  orig.error(err);
  process.exit(1);
});
