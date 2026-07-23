import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  collectListeningPort,
  collectNativeConfigValidation,
  collectOpenClawVersion,
} from '../cli/bin/native-diagnostics.js';

const syntheticOpenAiToken = `sk-${'a'.repeat(40)}`;
const syntheticGithubToken = `ghp_${'b'.repeat(36)}`;

const diagnosticsSource = () => readFile(
  new URL('../cli/bin/native-diagnostics.js', import.meta.url),
  'utf8',
);
const cliSource = () => readFile(new URL('../cli/bin/clawfix.js', import.meta.url), 'utf8');

test('native diagnostics uses the process adapter instead of child_process directly', async () => {
  const source = await diagnosticsSource();
  assert.doesNotMatch(source, /node:child_process/);
  assert.match(source, /\.\.\/adapters\/process\.js/);
  assert.match(source, /runProcessSync/);
});

test('default version collector treats a hostile executable path and argv literally', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'clawfix native path '));
  const sideEffectName = `clawfix-injected-${process.pid}-${Date.now()}`;
  const sideEffect = join(process.cwd(), sideEffectName);
  const executable = join(directory, `open claw;touch ${sideEffectName};# "'$\n`);
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(sideEffect, { force: true });
  });
  await writeFile(executable, [
    '#!/usr/bin/env node',
    "if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--version'])) process.exit(42);",
    "process.stdout.write('openclaw-safe 1.2.3\\n');",
    '',
  ].join('\n'));
  await chmod(executable, 0o755);

  const result = collectOpenClawVersion(executable);

  assert.equal(result.runtimeCompatible, true);
  assert.equal(result.version, 'openclaw-safe 1.2.3');
  await assert.rejects(access(sideEffect), { code: 'ENOENT' });
});

test('normalized timeout metadata fails JSON collection closed without parsing partial output', () => {
  const result = collectNativeConfigValidation('/usr/local/bin/openclaw', () => ({
    status: null,
    signal: 'SIGTERM',
    stdout: JSON.stringify({ valid: true, issues: [] }),
    stderr: '',
    errorCode: 'ETIMEDOUT',
    errorSummary: 'Process timed out after 20000ms',
    timedOut: true,
    aborted: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    outputLimitExceeded: false,
  }));

  assert.equal(result.available, false);
  assert.equal(result.valid, null);
  assert.match(result.errors[0], /timed out/i);
});

test('normalized output-limit metadata fails JSON collection closed without parsing partial output', () => {
  const result = collectNativeConfigValidation('/usr/local/bin/openclaw', () => ({
    status: null,
    signal: 'SIGTERM',
    stdout: JSON.stringify({ valid: true, issues: [] }),
    stderr: '',
    errorCode: 'ENOBUFS',
    errorSummary: 'spawnSync openclaw ENOBUFS',
    timedOut: false,
    aborted: false,
    stdoutTruncated: true,
    stderrTruncated: false,
    outputLimitExceeded: true,
  }));

  assert.equal(result.available, false);
  assert.equal(result.valid, null);
  assert.match(result.errors[0], /ENOBUFS|output/i);
});

const validLsofOutput = [
  'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME',
  'node 4242 user 20u IPv4 1 0t0 TCP 127.0.0.1:18789 (LISTEN)',
  '',
].join('\n');

const validSsOutput = [
  'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
  'LISTEN 0 511 127.0.0.1:18789 0.0.0.0:* users:(("node",pid=4242,fd=20))',
  '',
].join('\n');

const cleanMiss = { status: 1, signal: null, stdout: '', stderr: '' };
const lsofHeader = 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n';
const ssHeader = 'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n';

test('listening-port collection reports indeterminate evidence when neither tool is trustworthy', () => {
  const cases = [
    [
      { status: null, error: { code: 'ENOENT', message: `lsof missing api_key=${syntheticOpenAiToken}` } },
      { status: null, error: { code: 'ENOENT', message: `ss missing token=${syntheticGithubToken}` } },
    ],
    [
      { status: null, signal: 'SIGTERM', errorCode: 'ETIMEDOUT', timedOut: true },
      { status: null, signal: 'SIGKILL', stdout: '', stderr: '' },
    ],
    [
      { status: null, errorCode: 'ENOBUFS', outputLimitExceeded: true, stdoutTruncated: true },
      { status: null, errorCode: 'ABORT_ERR', aborted: true },
    ],
  ];

  for (const [lsof, ss] of cases) {
    let calls = 0;
    const result = collectListeningPort(18789, () => (calls++ === 0 ? lsof : ss));
    assert.equal(result.valid, true);
    assert.equal(result.available, false);
    assert.equal(result.listening, null);
    assert.equal(result.collector, null);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length <= 1_000);
    assert.doesNotMatch(result.error, /sk-testsecret|ghp_testsecret/);
  }
});

test('listening-port collection confirms clean absence from trustworthy collectors', () => {
  const failed = { status: null, signal: null, error: { code: 'ENOENT', message: 'missing' } };
  const cases = [
    [{ status: 0, signal: null, stdout: lsofHeader, stderr: '' }, failed, 'lsof'],
    [cleanMiss, failed, 'lsof'],
    [failed, { status: 0, signal: null, stdout: ssHeader, stderr: '' }, 'ss'],
  ];

  for (const [lsof, ss, collector] of cases) {
    let calls = 0;
    const result = collectListeningPort(18789, () => (calls++ === 0 ? lsof : ss));
    assert.equal(result.valid, true);
    assert.equal(result.available, true);
    assert.equal(result.listening, false);
    assert.equal(result.collector, collector);
  }
});

test('ss status 1 is not trusted as confirmation that a port is absent', () => {
  const failed = { status: null, signal: null, error: { code: 'ENOENT', message: 'missing' } };
  let calls = 0;
  const result = collectListeningPort(18789, () => (calls++ === 0 ? failed : cleanMiss));

  assert.equal(result.available, false);
  assert.equal(result.listening, null);
});

test('CLI does not present indeterminate port evidence as available', async () => {
  const source = await cliSource();
  const unavailableBranch = source.indexOf('evidence.available === false');
  const listenerBranch = source.indexOf('if (evidence.listening)');
  assert.ok(unavailableBranch >= 0 && unavailableBranch < listenerBranch);
  assert.match(source.slice(unavailableBranch, listenerBranch), /could not inspect/);
  assert.match(source.slice(unavailableBranch, listenerBranch), /portResults\[port\] = null/);
});

test('listening-port collection rejects failed lsof output and keeps evidence indeterminate when ss also fails', () => {
  const failures = [
    { status: 0, stdout: validLsofOutput, stderr: '', error: { code: 'ENOBUFS' } },
    { status: 0, stdout: validLsofOutput, stderr: '', errorCode: 'ENOBUFS' },
    { status: 0, stdout: validLsofOutput, stderr: '', outputLimitExceeded: true },
    { status: 0, stdout: validLsofOutput, stderr: '', stdoutTruncated: true },
    { status: 0, stdout: validLsofOutput, stderr: '', stderrTruncated: true },
  ];

  for (const failure of failures) {
    let calls = 0;
    const result = collectListeningPort(18789, () => (calls++ === 0 ? failure : cleanMiss));
    assert.equal(result.available, false, JSON.stringify(failure));
    assert.equal(result.listening, null, JSON.stringify(failure));
    assert.equal(calls, 2, JSON.stringify(failure));
  }
});

test('listening-port collection rejects valid-looking ss output with terminal failure metadata', () => {
  const failures = [
    { errorCode: 'ETIMEDOUT' },
    { timedOut: true },
    { errorCode: 'ABORT_ERR' },
    { aborted: true },
    { signal: 'SIGTERM' },
    { error: {} },
    { errorCode: 'ENOBUFS' },
    { outputLimitExceeded: true },
    { stdoutTruncated: true },
    { stderrTruncated: true },
  ];

  for (const metadata of failures) {
    let calls = 0;
    const result = collectListeningPort(18789, () => {
      calls += 1;
      if (calls === 1) return cleanMiss;
      return { status: 0, stdout: validSsOutput, stderr: '', signal: null, ...metadata };
    });
    assert.equal(result.listening, false, JSON.stringify(metadata));
    assert.equal(calls, 2, JSON.stringify(metadata));
  }
});

test('listening-port collection accepts clean ss listener evidence after a clean lsof miss', () => {
  let calls = 0;
  const result = collectListeningPort(18789, () => {
    calls += 1;
    return calls === 1
      ? cleanMiss
      : { status: 0, signal: null, stdout: validSsOutput, stderr: '' };
  });

  assert.equal(result.listening, true);
  assert.equal(result.collector, 'ss');
  assert.equal(result.process, 'node');
  assert.equal(result.pid, 4242);
  assert.equal(result.endpoint, '127.0.0.1');
});

test('raw truthy process errors fail JSON collection closed even without a code or message', () => {
  const result = collectNativeConfigValidation('/usr/local/bin/openclaw', () => ({
    status: 0,
    error: {},
    stdout: JSON.stringify({ valid: true, issues: [] }),
    stderr: '',
  }));

  assert.equal(result.available, false);
  assert.equal(result.valid, null);
});
