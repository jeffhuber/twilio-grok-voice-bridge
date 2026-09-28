#!/usr/bin/env node
'use strict';

process.env.NODE_ENV = 'test';
process.env.BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || 'operator-test-key';
process.env.PUBLIC_HOST = process.env.PUBLIC_HOST || 'bridge.example.com';
process.env.XAI_API_KEY = 'xai-test-key';
process.env.VOICE_ALIASES = '+8613800000000';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
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
if (typeof setTwilioClientForTests !== 'function' || typeof setGrokRealtimeUrlForTests !== 'function') {
  console.error('test setters are missing; set NODE_ENV=test before loading the server');
  process.exit(1);
}
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

function childEnvForExportProbe(nodeEnv) {
  const env = Object.assign({}, process.env, {
    VOICE_ALIASES: '',
    PUBLIC_HOST: 'bridge.example.com',
  });
  delete env.DOTENV_KEY;
  if (!env.BRIDGE_API_KEY) env.BRIDGE_API_KEY = 'operator-test-key';
  if (nodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = nodeEnv;
  return env;
}

function probeSetterExport(nodeEnv, dotenvBody) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-dotenv-'));
  const env = childEnvForExportProbe(nodeEnv);
  if (nodeEnv === undefined && Object.prototype.hasOwnProperty.call(env, 'NODE_ENV')) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return {
      status: 1,
      stdout: '',
      stderr: 'NODE_ENV was not deleted from the child environment',
      error: null,
    };
  }
  let result;
  try {
    if (dotenvBody != null) {
      fs.writeFileSync(path.join(tmp, '.env'), dotenvBody, { mode: 0o600 });
    }
    const script = [
      'const server = require(' + JSON.stringify(path.join(__dirname, '..', 'src', 'server.js')) + ');',
      'const names = ["setTwilioClientForTests", "setGrokRealtimeUrlForTests"];',
      'const leaked = names.filter((name) => typeof server[name] !== "undefined");',
      'const nodeEnv = Object.prototype.hasOwnProperty.call(process.env, "NODE_ENV") ? process.env.NODE_ENV : null;',
      'process.stdout.write(JSON.stringify({ leaked: leaked, nodeEnv: nodeEnv }));',
      'process.exit(leaked.length ? 1 : 0);',
    ].join('\n');
    result = spawnSync(process.execPath, ['-e', script], {
      cwd: tmp,
      env,
      encoding: 'utf8',
      timeout: 8000,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return result;
}

function assertSettersOmitted(label, nodeEnv, options) {
  const opts = options || {};
  const result = probeSetterExport(nodeEnv, opts.dotenvBody);
  if (result.error) {
    fail(`${label}: ${result.error.message}`);
    return;
  }
  let report = null;
  try {
    report = JSON.parse(result.stdout || '');
  } catch {
    report = null;
  }
  if (!report || !Array.isArray(report.leaked)) {
    const detail = (result.stderr || result.stdout || '').trim();
    fail(`${label}: child exited ${result.status} without a setter report${detail ? `: ${detail}` : ''}`);
    return;
  }
  const problems = [];
  if (report.leaked.length !== 0) {
    problems.push(`setters still exported (${report.leaked.join(', ')})`);
  }
  if (Object.prototype.hasOwnProperty.call(opts, 'expectNodeEnv') && report.nodeEnv !== opts.expectNodeEnv) {
    problems.push(`process.env.NODE_ENV after load was ${String(report.nodeEnv)}`);
  }
  if (problems.length === 0 && result.status !== 0) {
    problems.push(`child exited ${result.status}`);
  }
  if (problems.length === 0) {
    pass(label);
    return;
  }
  fail(`${label}: ${problems.join('; ')}`);
}

function probeSetterExportWithPreload(nodeEnv, dotenvBody, options) {
  const opts = options || {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-dotenv-'));
  const env = childEnvForExportProbe(nodeEnv);
  if (nodeEnv === undefined && Object.prototype.hasOwnProperty.call(env, 'NODE_ENV')) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return {
      status: 1,
      stdout: '',
      stderr: 'NODE_ENV was not deleted from the child environment',
      error: null,
    };
  }
  try {
    if (dotenvBody != null) {
      fs.writeFileSync(path.join(tmp, '.env'), dotenvBody, { mode: 0o600 });
    }
    const dotenvConfigPath = require.resolve('dotenv/config');
    const script = [
      '// Capture NODE_ENV and sentinel BEFORE require(server), so we see preload state before server dotenv.config',
      'const preNodeEnv = Object.prototype.hasOwnProperty.call(process.env, "NODE_ENV") ? process.env.NODE_ENV : null;',
      'const preSentinel = process.env.DOTENV_PRELOAD_SENTINEL || null;',
      'const server = require(' + JSON.stringify(path.join(__dirname, '..', 'src', 'server.js')) + ');',
      'const names = ["setTwilioClientForTests", "setGrokRealtimeUrlForTests"];',
      'const leaked = names.filter((name) => typeof server[name] !== "undefined");',
      'process.stdout.write(JSON.stringify({ leaked: leaked, preNodeEnv: preNodeEnv, preSentinel: preSentinel }));',
      'process.exit(leaked.length ? 1 : 0);',
    ].join('\n');
    let execArgv = [];
    if (opts.preloadType === 'require-execArgv') {
      execArgv = ['-r', dotenvConfigPath];
    } else if (opts.preloadType === 'import-execArgv') {
      execArgv = ['--import', dotenvConfigPath];
    } else if (opts.preloadType === 'env-file-execArgv') {
      execArgv = ['--env-file', path.join(tmp, '.env')];
    } else if (opts.preloadType === 'env-file-if-exists-separate') {
      execArgv = ['--env-file-if-exists', path.join(tmp, '.env')];
    } else if (opts.preloadType === 'env-file-if-exists-equals') {
      execArgv = [`--env-file-if-exists=${path.join(tmp, '.env')}`];
    } else if (opts.preloadType === 'env-file-if-exists-missing') {
      execArgv = ['--env-file-if-exists', path.join(tmp, 'missing.env')];
    } else if (opts.preloadType === 'env-file-if-exists-missing-equals') {
      execArgv = [`--env-file-if-exists=${path.join(tmp, 'missing.env')}`];
    } else if (opts.preloadType === 'env-file-if-exists-relative-existing') {
      execArgv = ['--env-file-if-exists', '.env'];
    } else if (opts.preloadType === 'env-file-if-exists-relative-missing') {
      execArgv = ['--env-file-if-exists', 'missing.env'];
    } else if (opts.preloadType === 'env-file-if-exists-mixed') {
      execArgv = ['--env-file-if-exists', path.join(tmp, 'missing.env'), '--env-file-if-exists', path.join(tmp, '.env')];
    } else if (opts.preloadType === 'env-file-if-exists-directory') {
      const dirPath = path.join(tmp, 'testdir');
      fs.mkdirSync(dirPath, { recursive: true });
      execArgv = ['--env-file-if-exists', dirPath];
    } else if (opts.preloadType === 'require-nodeOptions') {
      env.NODE_OPTIONS = `--require ${dotenvConfigPath}`;
    } else if (opts.preloadType === 'import-nodeOptions') {
      env.NODE_OPTIONS = `--import ${dotenvConfigPath}`;
    } else if (opts.preloadType === 'none') {
      // No preload flags - control case
    }
    return spawnSync(process.execPath, [...execArgv, '-e', script], {
      cwd: tmp,
      env,
      encoding: 'utf8',
      timeout: 8000,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function assertProductionExportOmitsTestSetters() {
  assertSettersOmitted('production module.exports omits test setters', 'production', {
    expectNodeEnv: 'production',
  });
  // Shell NODE_ENV is deleted or set to development. Each child also gets a
  // temp .env of NODE_ENV=test. Override still copies that into process.env.
  // The setters stay undefined because the gate uses the shell value from
  // before dotenv. These fail if the gate is !== 'production' (the shell
  // value is not production) and if the gate reads process.env after dotenv
  // (the file has set NODE_ENV=test).
  const dotenvTest = 'NODE_ENV=test\n';
  assertSettersOmitted('unset NODE_ENV omits test setters when .env sets NODE_ENV=test', undefined, {
    dotenvBody: dotenvTest,
    expectNodeEnv: 'test',
  });
  assertSettersOmitted('development NODE_ENV omits test setters when .env sets NODE_ENV=test', 'development', {
    dotenvBody: dotenvTest,
    expectNodeEnv: 'test',
  });
}

function assertPreloadRefusesTestSetters() {
  const dotenvTest = 'NODE_ENV=test\nDOTENV_PRELOAD_SENTINEL=loaded\n';
  const failures = [];
  
  // Positive case: shell NODE_ENV=test still exports them
  const positiveResult = probeSetterExport('test', null);
  if (positiveResult.error) {
    failures.push(`dotenv preload positive case: ${positiveResult.error.message}`);
  } else {
    let positiveReport = null;
    try {
      positiveReport = JSON.parse(positiveResult.stdout || '');
    } catch {
      positiveReport = null;
    }
    if (!positiveReport || !Array.isArray(positiveReport.leaked) || positiveReport.leaked.length === 0) {
      failures.push('dotenv preload positive case: shell NODE_ENV=test did not export setters');
    } else {
      pass('dotenv preload positive case: shell NODE_ENV=test exports setters');
    }
  }
  
  // Control case: no preload flag, .env with NODE_ENV=test, confirm pre-require values are absent
  const controlResult = probeSetterExportWithPreload(undefined, dotenvTest, { preloadType: 'none' });
  if (controlResult.error) {
    failures.push(`control case (no preload): ${controlResult.error.message}`);
  } else {
    let controlReport = null;
    try {
      controlReport = JSON.parse(controlResult.stdout || '');
    } catch {
      controlReport = null;
    }
    if (!controlReport || !Array.isArray(controlReport.leaked)) {
      failures.push('control case (no preload): child exited without a setter report');
    } else if (controlReport.preNodeEnv !== null || controlReport.preSentinel !== null) {
      failures.push(`control case (no preload): pre-require values should be absent (preNodeEnv=${controlReport.preNodeEnv}, preSentinel=${controlReport.preSentinel})`);
    } else if (controlReport.leaked.length !== 0) {
      failures.push(`control case (no preload): setters still exported (${controlReport.leaked.join(', ')})`);
    } else {
      pass('control case (no preload): pre-require values absent, setters omitted');
    }
  }

  // Test each preload variant
  // Note: --env-file* only works via execArgv, not NODE_OPTIONS (Node.js restriction)
  const variants = [
    { preloadType: 'require-execArgv', label: 'execArgv -r dotenv/config' },
    { preloadType: 'import-execArgv', label: 'execArgv --import dotenv/config' },
    { preloadType: 'env-file-execArgv', label: 'execArgv --env-file .env' },
    { preloadType: 'env-file-if-exists-separate', label: 'execArgv --env-file-if-exists .env (separate)' },
    { preloadType: 'env-file-if-exists-equals', label: 'execArgv --env-file-if-exists=.env' },
    { preloadType: 'require-nodeOptions', label: 'NODE_OPTIONS --require dotenv/config' },
    { preloadType: 'import-nodeOptions', label: 'NODE_OPTIONS --import dotenv/config' },
  ];

  for (const variant of variants) {
    const result = probeSetterExportWithPreload(undefined, dotenvTest, variant);
    if (result.error) {
      failures.push(`${variant.label}: ${result.error.message}`);
      continue;
    }
    let report = null;
    try {
      report = JSON.parse(result.stdout || '');
    } catch {
      report = null;
    }
    if (!report || !Array.isArray(report.leaked)) {
      failures.push(`${variant.label}: child exited without a setter report`);
      continue;
    }
    
    // Positively assert the preload took effect (check pre-require values)
    const preloadTookEffect = report.preNodeEnv === 'test' || report.preSentinel === 'loaded';
    if (!preloadTookEffect) {
      failures.push(`${variant.label}: preload did not take effect (preNodeEnv=${report.preNodeEnv}, preSentinel=${report.preSentinel})`);
      continue;
    }
    
    if (report.leaked.length !== 0) {
      failures.push(`${variant.label}: setters still exported (${report.leaked.join(', ')}) despite preload`);
      continue;
    }
    
    pass(`${variant.label} omits test setters when .env sets NODE_ENV=test`);
  }
  
  // Test --env-file-if-exists with missing files (should export setters)
  const missingTests = [
    { preloadType: 'env-file-if-exists-missing', label: '--env-file-if-exists <missing> (space-separated)' },
    { preloadType: 'env-file-if-exists-missing-equals', label: '--env-file-if-exists=<missing> (equals form)' },
  ];
  
  for (const test of missingTests) {
    const result = probeSetterExportWithPreload('test', null, test);
    if (result.error) {
      failures.push(`${test.label}: ${result.error.message}`);
    } else {
      let report = null;
      try {
        report = JSON.parse(result.stdout || '');
      } catch {
        report = null;
      }
      if (!report || !Array.isArray(report.leaked)) {
        failures.push(`${test.label}: child exited without a setter report`);
      } else if (report.leaked.length === 0) {
        failures.push(`${test.label}: setters were NOT exported (should export when file is missing)`);
      } else {
        pass(`${test.label} exports setters (file does not exist, no preload)`);
      }
    }
  }
  
  // Test relative paths resolved against cwd
  const relativeExistingResult = probeSetterExportWithPreload(undefined, dotenvTest, { preloadType: 'env-file-if-exists-relative-existing' });
  if (relativeExistingResult.error) {
    failures.push(`--env-file-if-exists .env (relative, existing): ${relativeExistingResult.error.message}`);
  } else {
    let relReport = null;
    try {
      relReport = JSON.parse(relativeExistingResult.stdout || '');
    } catch {
      relReport = null;
    }
    if (!relReport || !Array.isArray(relReport.leaked)) {
      failures.push('--env-file-if-exists .env (relative, existing): child exited without a setter report');
    } else if (relReport.leaked.length !== 0) {
      failures.push(`--env-file-if-exists .env (relative, existing): setters still exported (${relReport.leaked.join(', ')}) when file exists`);
    } else if (!relReport.preSentinel) {
      failures.push('--env-file-if-exists .env (relative, existing): file was not loaded (sentinel missing)');
    } else {
      pass('--env-file-if-exists .env (relative, existing) refuses (file exists in cwd)');
    }
  }
  
  const relativeMissingResult = probeSetterExportWithPreload('test', null, { preloadType: 'env-file-if-exists-relative-missing' });
  if (relativeMissingResult.error) {
    failures.push(`--env-file-if-exists missing.env (relative, missing): ${relativeMissingResult.error.message}`);
  } else {
    let relMissReport = null;
    try {
      relMissReport = JSON.parse(relativeMissingResult.stdout || '');
    } catch {
      relMissReport = null;
    }
    if (!relMissReport || !Array.isArray(relMissReport.leaked)) {
      failures.push('--env-file-if-exists missing.env (relative, missing): child exited without a setter report');
    } else if (relMissReport.leaked.length === 0) {
      failures.push('--env-file-if-exists missing.env (relative, missing): setters were NOT exported (should export when file is missing)');
    } else {
      pass('--env-file-if-exists missing.env (relative, missing) exports setters');
    }
  }
  
  // Test mixed: one missing + one existing (should refuse because one exists)
  const mixedResult = probeSetterExportWithPreload(undefined, dotenvTest, { preloadType: 'env-file-if-exists-mixed' });
  if (mixedResult.error) {
    failures.push(`--env-file-if-exists mixed (missing + existing): ${mixedResult.error.message}`);
  } else {
    let mixedReport = null;
    try {
      mixedReport = JSON.parse(mixedResult.stdout || '');
    } catch {
      mixedReport = null;
    }
    if (!mixedReport || !Array.isArray(mixedReport.leaked)) {
      failures.push('--env-file-if-exists mixed (missing + existing): child exited without a setter report');
    } else if (mixedReport.leaked.length !== 0) {
      failures.push(`--env-file-if-exists mixed (missing + existing): setters still exported (${mixedReport.leaked.join(', ')}) when one file exists`);
    } else if (!mixedReport.preSentinel) {
      failures.push('--env-file-if-exists mixed (missing + existing): existing file was not loaded (sentinel missing)');
    } else {
      pass('--env-file-if-exists mixed (missing + existing) refuses (one file exists)');
    }
  }
  
  // Test fail-closed: directory instead of file
  const dirResult = probeSetterExportWithPreload(undefined, dotenvTest, { preloadType: 'env-file-if-exists-directory' });
  // Node refuses to start when --env-file-if-exists points to a directory
  if (dirResult.status !== 0 && dirResult.stderr && dirResult.stderr.includes('invalid format')) {
    pass('--env-file-if-exists <directory> refused by Node (invalid format)');
  } else if (dirResult.error) {
    failures.push(`--env-file-if-exists <directory>: ${dirResult.error.message}`);
  } else {
    let dirReport = null;
    try {
      dirReport = JSON.parse(dirResult.stdout || '');
    } catch {
      dirReport = null;
    }
    if (!dirReport || !Array.isArray(dirReport.leaked)) {
      failures.push(`--env-file-if-exists <directory>: child exited without a setter report (status=${dirResult.status}, stderr=${dirResult.stderr})`);
    } else if (dirReport.leaked.length !== 0) {
      failures.push(`--env-file-if-exists <directory>: setters still exported (${dirReport.leaked.join(', ')}) for directory (should fail-closed)`);
    } else {
      pass('--env-file-if-exists <directory> refuses (fail-closed: directory exists but is not a file)');
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      fail(failure);
    }
  }
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
  assertProductionExportOmitsTestSetters();
  assertPreloadRefusesTestSetters();

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

  const kept = maskPhoneNumbersInText('from 203.0.113.50 and 198.51.100.10 on 2026-09-26 at 1727350123456');
  if (
    kept.includes('203.0.113.50') &&
    kept.includes('198.51.100.10') &&
    !kept.includes('198.xxxxx0.10') &&
    kept.includes('2026-09-26') &&
    !kept.includes('1727350123456') &&
    kept.includes('3456')
  ) {
    pass('whole IPv4 addresses and dates stay, and a 13-digit timestamp is masked');
  } else {
    fail(`non-phone numbers were masked: ${kept}`);
  }
  const glued = maskPhoneNumbersInText('2026-09-26 198.51.100.10');
  if (glued === '2026-09-26 198.51.100.10') {
    pass('a date and an IPv4 address separated by a space both stay');
  } else {
    fail(`glued date and address were masked: ${glued}`);
  }
  // The phone group is flushed when the exempt address is seen, not at the end of the run.
  // If that mid-run flush stops masking, the phone digits remain next to the address.
  const beforeExempt = maskPhoneNumbersInText('555 555 0100 198.51.100.10');
  const beforeExemptThenPhone = maskPhoneNumbersInText('555 555 0100 198.51.100.10 555 555 0199');
  if (
    beforeExempt === 'xxxxxxxx0100 198.51.100.10' &&
    beforeExemptThenPhone === 'xxxxxxxx0100 198.51.100.10 xxxxxxxx0199'
  ) {
    pass('a phone number immediately before an exempt token is masked');
  } else {
    fail(`phone before exempt token was ${beforeExempt} | ${beforeExemptThenPhone}`);
  }
  const leadingIp = maskPhoneNumbersInText('198.51.100.10 is documentation');
  if (leadingIp === '198.51.100.10 is documentation') {
    pass('an IPv4 address at the start of a string stays');
  } else {
    fail(`leading address was masked: ${leadingIp}`);
  }
  const leadingZeros = maskPhoneNumbersInText('saw 000.123.45.67 today');
  if (!leadingZeros.includes('000.123.45.67') && !leadingZeros.includes('000') && leadingZeros.includes('5.67')) {
    pass('a leading-zero dotted quad is masked');
  } else {
    fail(`leading-zero quad was kept: ${leadingZeros}`);
  }
  const dottedCorpus = [
    ['198.51.100.10', '198.51.100.10', 'IPv4'],
    ['000.123.45.67', 'xxxxxxxx5.67', 'IPv4 with leading zeros'],
    ['2026-09-26', '2026-09-26', 'calendar date'],
    ['2026.09.26', '2026.09.26', 'dotted calendar date'],
    ['1.2.3', '1.2.3', 'version'],
    ['v1.2.3', 'v1.2.3', 'version with a letter'],
    ['10.20.30', '10.20.30', 'version under 7 digits'],
    ['555.555.0100', 'xxxxxxxx0100', 'dotted phone'],
    ['555.0100', 'xxxx0100', 'short dotted phone'],
    ['123.45.67.89', '123.45.67.89', 'known residual treated as IPv4'],
  ];
  const corpusMisses = [];
  for (const [raw, expected, label] of dottedCorpus) {
    const masked = maskPhoneNumbersInText(`saw ${raw} today`);
    if (masked !== `saw ${expected} today`) corpusMisses.push(`${label}: ${masked}`);
  }
  const mixedDotted = maskPhoneNumbersInText(
    'version 1.2.3 at 2026-09-26 from 198.51.100.10 phone 555.555.0100 quad 000.123.45.67 residual 123.45.67.89'
  );
  if (
    mixedDotted !==
    'version 1.2.3 at 2026-09-26 from 198.51.100.10 phone xxxxxxxx0100 quad xxxxxxxx5.67 residual 123.45.67.89'
  ) {
    corpusMisses.push(`mixed: ${mixedDotted}`);
  }
  if (corpusMisses.length === 0) {
    pass('dotted tokens keep IPv4, leading-zero IPv4, dates, versions, dotted phones, and the 123.45.67.89 IPv4 residual');
  } else {
    fail(`dotted token corpus changed: ${corpusMisses.join(' | ')}`);
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
    ['+4930000000000', '0000', '+4930000000000'],
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
      isE164('+4930000000000') &&
      !isE164('+86 138 0000 0000')
    ) {
      pass('compact +86 and +49 numbers are E.164 and the spaced form is not');
    } else {
      fail('E.164 classification of +86/+49 changed');
    }

    const intlCalls = [
      ['+8613800000000', '0000'],
      ['+4930000000000', '0000'],
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
          throw new Error('twiml failed for +4930000000000');
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
        !twimlLogs[0].includes('+4930000000000') &&
        twimlLogs[0].includes('0000')
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
      let grokPeer = null;
      grokWss.on('connection', (socket) => {
        grokPeer = socket;
        socket.send('+8613800000000');
      });
      await new Promise((resolve) => grokHttp.listen(0, '127.0.0.1', resolve));
      setGrokRealtimeUrlForTests(`ws://127.0.0.1:${grokHttp.address().port}`);
      try {
        const xmlParam = (name) => {
          const named = new RegExp(`<Parameter[^>]*name="${name}"[^>]*value="([^"]*)"`);
          const valued = new RegExp(`<Parameter[^>]*value="([^"]*)"[^>]*name="${name}"`);
          const match = twimlOk.raw.match(named) || twimlOk.raw.match(valued);
          return match ? match[1].replace(/&amp;/g, '&') : '';
        };
        const streamUrl = new URL(urlMatch[1].replace(/&amp;/g, '&'));
        const mediaUrl = `ws://127.0.0.1:${port}${streamUrl.pathname}`;
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
          start: {
            callSid: 'CA-mask-path',
            streamSid: 'stream-mask',
            customParameters: {
              callSid: xmlParam('callSid'),
              timestamp: xmlParam('timestamp'),
              signature: xmlParam('signature'),
            },
          },
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
          placedSession.grokWs.emit('error', new Error('upstream +4930000000000'));
          const grokErrLogs = stderr.lines.slice(beforeGrokErr).filter((line) => line.includes('[grok] error callSid='));
          if (
            grokErrLogs.length === 1 &&
            !grokErrLogs[0].includes('+4930000000000') &&
            grokErrLogs[0].includes('0000')
          ) {
            pass('grok socket errors mask numbers from the real listener');
          } else {
            fail(`grok error log ${JSON.stringify(grokErrLogs)}`);
          }
          if (!grokPeer) {
            fail('grok peer was not connected');
          } else {
            placedSession.awaitingAudioConfigAck = true;
            placedSession.openerSent = false;
            const beforeServerErr = stderr.lines.length;
            grokPeer.send(JSON.stringify({ type: 'error', error: { message: 'upstream +4930000000000' } }));
            const serverErrLogs = await waitForLog(stderr, beforeServerErr, '[grok] server error:', 2000);
            if (
              serverErrLogs.length === 1 &&
              !serverErrLogs[0].includes('+4930000000000') &&
              serverErrLogs[0].includes('0000')
            ) {
              pass('grok server errors mask numbers in the event payload');
            } else {
              fail(`grok server error log ${JSON.stringify(serverErrLogs)}`);
            }
            if (placedSession.awaitingAudioConfigAck === false && placedSession.openerSent === false) {
              pass('grok server error clears the opener arm');
            } else {
              fail(
                `opener arm after masked server error ack=${placedSession.awaitingAudioConfigAck} sent=${placedSession.openerSent}`
              );
            }
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
        await delay(1100);
        const beforeSig = stderr.lines.length;
        const sigSock = await new Promise((resolve, reject) => {
          const sock = new WebSocket(`ws://127.0.0.1:${port}/media-stream`);
          const timer = setTimeout(() => {
            sock.terminate();
            reject(new Error('signature socket open timed out'));
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
        sigSock.send(JSON.stringify({
          event: 'start',
          streamSid: 'stream-sig',
          start: {
            callSid: 'CA-sig',
            streamSid: 'stream-sig',
            customParameters: {
              callSid: 'CA-sig',
              timestamp: String(sigTs),
              signature: sig,
            },
          },
        }));
        const sigLogs = await waitForLog(stderr, beforeSig, 'signature verification failed', 2000);
        sigSock.close();
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
