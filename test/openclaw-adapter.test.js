import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createOpenClawAdapter } from '../cli/adapters/openclaw.js';

async function makeExecutable(directory, name = 'openclaw') {
  await mkdir(directory, { recursive: true });
  const executable = join(directory, name);
  await writeFile(executable, '#!/bin/sh\nexit 0\n');
  await chmod(executable, 0o755);
  return executable;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const ABORTED_RESULT = {
  status: null,
  signal: null,
  stdout: '',
  stderr: '',
  errorSummary: 'OpenClaw invocation aborted',
  errorCode: 'ABORT_ERR',
  timedOut: false,
  aborted: true,
  stdoutTruncated: false,
  stderrTruncated: false,
  outputLimitExceeded: false,
};

const DISCOVERY_TIMEOUT_RESULT = {
  status: null,
  signal: null,
  stdout: '',
  stderr: '',
  errorSummary: 'OpenClaw executable discovery timed out',
  errorCode: 'ETIMEDOUT',
  timedOut: true,
  aborted: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  outputLimitExceeded: false,
};

test('findExecutable treats spaces, quotes, semicolons, and newlines in PATH entries literally', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clawfix-openclaw-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'bin space"quote;semi\nline');
  const executable = await makeExecutable(directory);
  const adapter = createOpenClawAdapter({
    env: { PATH: `${join(root, 'missing')}:${directory}` },
    platform: 'linux',
  });

  assert.equal(await adapter.findExecutable(), executable);
});

test('findExecutable follows PATH order and checks compatibility fallbacks only afterward', async () => {
  const checked = [];
  const existing = new Set([
    '/second/openclaw',
    '/opt/homebrew/bin/openclaw',
    '/usr/local/bin/openclaw',
  ]);
  const fs = {
    async access(path) {
      checked.push(path);
      if (!existing.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    async stat(path) {
      if (!existing.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { isFile: () => true };
    },
  };
  const adapter = createOpenClawAdapter({ env: { PATH: '/first:/second' }, fs, platform: 'linux' });

  assert.equal(await adapter.findExecutable(), '/second/openclaw');
  assert.deepEqual(checked, ['/first/openclaw', '/second/openclaw']);
});

test('findExecutable uses POSIX fallbacks in order when PATH has no executable', async () => {
  const checked = [];
  const fs = {
    async access(path) {
      checked.push(path);
      if (path !== '/usr/local/bin/openclaw') throw new Error('missing');
    },
    async stat(path) {
      if (path !== '/usr/local/bin/openclaw') throw new Error('missing');
      return { isFile: () => true };
    },
  };
  const adapter = createOpenClawAdapter({ env: { PATH: '/missing' }, fs, platform: 'darwin' });

  assert.equal(await adapter.findExecutable(), '/usr/local/bin/openclaw');
  assert.deepEqual(checked, [
    '/missing/openclaw',
    '/opt/homebrew/bin/openclaw',
    '/usr/local/bin/openclaw',
  ]);
});

test('findExecutable honors PATHEXT order on Windows without shell discovery', async () => {
  const checked = [];
  const target = 'C:\\Tools Space\\openclaw.CMD';
  const fs = {
    async access(path) {
      checked.push(path);
      if (path.toUpperCase() !== target.toUpperCase()) throw new Error('missing');
    },
    async stat(path) {
      if (path.toUpperCase() !== target.toUpperCase()) throw new Error('missing');
      return { isFile: () => true };
    },
  };
  const adapter = createOpenClawAdapter({
    env: { PATH: 'C:\\Missing;C:\\Tools Space', PATHEXT: '.EXE;.CMD' },
    fs,
    platform: 'win32',
  });

  assert.equal(await adapter.findExecutable(), target);
  assert.deepEqual(checked, [
    'C:\\Missing\\openclaw.EXE',
    'C:\\Missing\\openclaw.CMD',
    'C:\\Tools Space\\openclaw.EXE',
    'C:\\Tools Space\\openclaw.CMD',
  ]);
});

test('version and gatewayStatus construct immutable argv and bounded process options', async () => {
  const calls = [];
  const processAdapter = {
    async run(executable, argv, options) {
      calls.push({ executable, argv, options });
      return Object.freeze({ status: 0, stdout: 'ok' });
    },
  };
  const fs = {
    async access() {},
    async stat() { return { isFile: () => true }; },
  };
  const adapter = createOpenClawAdapter({
    env: { PATH: '/tools' },
    fs,
    platform: 'linux',
    processAdapter,
  });

  await adapter.version();
  await adapter.gatewayStatus({ timeoutMs: 321, maxStdoutBytes: 99 });

  assert.deepEqual(calls.map(({ executable, argv }) => ({ executable, argv })), [
    { executable: '/tools/openclaw', argv: ['--version'] },
    { executable: '/tools/openclaw', argv: ['gateway', 'status'] },
  ]);
  assert.equal(Object.isFrozen(calls[0].argv), true);
  assert.equal(Object.isFrozen(calls[1].argv), true);
  assert.equal(calls[0].options.timeoutMs > 0, true);
  assert.equal(calls[0].options.timeoutMs <= 10_000, true);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.maxStdoutBytes, 256 * 1024);
  assert.equal(calls[1].options.timeoutMs > 0, true);
  assert.equal(calls[1].options.timeoutMs <= 321, true);
  assert.equal(calls[1].options.maxStdoutBytes, 99);
  assert.equal(calls[1].options.maxStderrBytes, 256 * 1024);
});

test('runtime collectors pass hostile values as literal argv and parse Linux service evidence', async () => {
  const calls = [];
  const processAdapter = {
    async run(executable, argv, options) {
      calls.push({ executable, argv, options });
      if (executable === 'npm') return Object.freeze({ status: 0, stdout: '10.9.4\n', stderr: '' });
      if (executable === 'pgrep') return Object.freeze({ status: 0, stdout: '42\n', stderr: '' });
      if (executable === 'systemctl') {
        return Object.freeze({
          status: 0,
          stdout: 'NRestarts=3\nActiveState=active\nSubState=running\nExecMainPID=42\n',
          stderr: '',
        });
      }
      assert.fail(`unexpected executable: ${executable}`);
    },
  };
  const adapter = createOpenClawAdapter({
    env: { PATH: '/hostile path;touch nope\n/bin' },
    fs: {
      async access() { throw new Error('not used'); },
      async stat() { throw new Error('not used'); },
    },
    platform: 'linux',
    processAdapter,
  });

  assert.equal(await adapter.npmVersion(), '10.9.4');
  assert.equal(await adapter.gatewayProcesses(), '42');
  assert.deepEqual(await adapter.serviceManagerState(), {
    manager: 'systemd',
    nRestarts: 3,
    state: 'active',
    subState: 'running',
    pid: 42,
  });
  assert.deepEqual(calls.map(({ executable, argv }) => ({ executable, argv })), [
    { executable: 'npm', argv: ['--version'] },
    { executable: 'pgrep', argv: ['-f', 'openclaw.*gateway'] },
    {
      executable: 'systemctl',
      argv: [
        'show',
        'openclaw-gateway',
        '--property=NRestarts,ActiveState,SubState,ExecMainPID,ExecMainStartTimestamp',
      ],
    },
  ]);
  for (const call of calls) {
    assert.equal(call.options.shell, false);
    assert.equal(Object.isFrozen(call.argv), true);
  }
});

test('text collectors discard failed and truncated process evidence', async () => {
  let calls = 0;
  const adapter = createOpenClawAdapter({
    fs: {
      async access() { throw new Error('not used'); },
      async stat() { throw new Error('not used'); },
    },
    processAdapter: {
      async run() {
        calls += 1;
        return calls === 1
          ? Object.freeze({ status: 7, stdout: 'untrusted-version', stderr: 'failed' })
          : Object.freeze({ status: 0, stdout: '42', stderr: '', stdoutTruncated: true });
      },
    },
  });

  assert.equal(await adapter.npmVersion(), '');
  assert.equal(await adapter.gatewayProcesses(), '');
});

test('gatewayStatusText rejects truncated status evidence from a hostile executable path', async () => {
  let observed;
  const adapter = createOpenClawAdapter({
    processAdapter: {
      async run(executable, argv) {
        observed = { executable, argv };
        return Object.freeze({
          status: 0,
          stdout: 'Runtime: running',
          stderr: '',
          stdoutTruncated: true,
        });
      },
    },
  });
  const executable = '/tmp/open claw";touch nope\n/bin';

  assert.equal(await adapter.gatewayStatusText({ executable }), '');
  assert.deepEqual(observed, { executable, argv: ['gateway', 'status'] });
});

test('readFileTail reads a hostile path with bounded bytes and returns only the requested lines', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clawfix-tail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'gateway "log";touch nope\n.log');
  await writeFile(path, `${Array.from({ length: 20 }, (_, index) => `line-${index}`).join('\n')}\n`);
  const adapter = createOpenClawAdapter();

  const result = await adapter.readFileTail(path, { maxLines: 3, maxBytes: 80 });

  assert.equal(result.text, 'line-17\nline-18\nline-19');
  assert.equal(result.truncated, true);
  assert.equal(result.errorCode, null);
  assert.equal(Object.isFrozen(result), true);
});

test('readFileTail preserves the primary read failure when handle cleanup also fails', async () => {
  let closeCalls = 0;
  const adapter = createOpenClawAdapter({
    fs: {
      async access() {},
      async stat() { return { isFile: () => true }; },
      async open() {
        return {
          async stat() { return { size: 12 }; },
          async read() { throw Object.assign(new Error('read failed'), { code: 'EIO' }); },
          async close() {
            closeCalls += 1;
            throw new Error('close failed');
          },
        };
      },
    },
  });

  const result = await adapter.readFileTail('/literal;path', { maxLines: 2, maxBytes: 8 });

  assert.deepEqual(result, {
    text: '',
    truncated: false,
    errorCode: 'EIO',
    errorSummary: 'read failed',
  });
  assert.equal(closeCalls, 1);
});

test('invoke snapshots mutable inputs before delayed executable discovery', async () => {
  let releaseDiscovery;
  const discoveryGate = new Promise((resolve) => { releaseDiscovery = resolve; });
  let observed;
  const controller = new AbortController();
  const fs = {
    async access() { await discoveryGate; },
    async stat() { return { isFile: () => true }; },
  };
  const processAdapter = {
    async run(executable, argv, options) {
      observed = { executable, argv, options };
      return Object.freeze({ status: 0, stdout: 'ok' });
    },
  };
  const adapter = createOpenClawAdapter({
    env: { PATH: '/tools' },
    fs,
    platform: 'linux',
    processAdapter,
  });
  const argv = ['gateway', 'status'];
  const callEnv = { CLAWFIX_TEST: 'original' };
  const cwd = new URL('file:///original/');
  const options = {
    timeoutMs: 123,
    maxStdoutBytes: 456,
    maxStderrBytes: 789,
    signal: controller.signal,
    cwd,
    env: callEnv,
    windowsHide: false,
  };

  const pending = adapter.invoke(argv, options);
  argv[0] = 'mutated';
  argv.push('--dangerous');
  options.timeoutMs = 1;
  options.maxStdoutBytes = 2;
  options.maxStderrBytes = 3;
  options.signal = new AbortController().signal;
  options.cwd = '/mutated';
  options.env = { CLAWFIX_TEST: 'replacement' };
  options.windowsHide = true;
  options.executable = '/mutated/openclaw';
  callEnv.CLAWFIX_TEST = 'mutated';
  cwd.pathname = '/mutated/';
  releaseDiscovery();
  await pending;

  assert.equal(observed.executable, '/tools/openclaw');
  assert.deepEqual(observed.argv, ['gateway', 'status']);
  assert.equal(Object.isFrozen(observed.argv), true);
  assert.equal(observed.options.timeoutMs > 0, true);
  assert.equal(observed.options.timeoutMs <= 123, true);
  assert.equal(observed.options.maxStdoutBytes, 456);
  assert.equal(observed.options.maxStderrBytes, 789);
  assert.equal(observed.options.signal, controller.signal);
  assert.equal(observed.options.cwd.href, 'file:///original/');
  assert.notEqual(observed.options.cwd, cwd);
  assert.deepEqual(observed.options.env, { CLAWFIX_TEST: 'original' });
  assert.equal(Object.isFrozen(observed.options.env), true);
  assert.equal(observed.options.windowsHide, false);
  assert.equal(observed.options.shell, false);
});

test('invoke rejects invalid options and env synchronously without filesystem discovery', () => {
  let fsCalls = 0;
  let processCalls = 0;
  const fs = {
    async access() { fsCalls += 1; },
    async stat() { fsCalls += 1; return { isFile: () => true }; },
  };
  const processAdapter = { async run() { processCalls += 1; } };
  const adapter = createOpenClawAdapter({
    env: { PATH: '/tools' },
    fs,
    platform: 'linux',
    processAdapter,
  });
  const invalidCalls = [
    () => adapter.invoke([], null),
    () => adapter.invoke([], { env: null }),
    () => adapter.invoke([], { env: [] }),
  ];

  for (const invoke of invalidCalls) assert.throws(invoke, TypeError);
  assert.equal(fsCalls, 0);
  assert.equal(processCalls, 0);
});

test('invoke rejects invalid executable and argv synchronously without filesystem discovery', () => {
  let fsCalls = 0;
  let processCalls = 0;
  const fs = {
    async access() { fsCalls += 1; },
    async stat() { fsCalls += 1; return { isFile: () => true }; },
  };
  const processAdapter = { async run() { processCalls += 1; } };
  const adapter = createOpenClawAdapter({
    env: { PATH: '/tools' },
    fs,
    platform: 'linux',
    processAdapter,
  });
  const invalidCalls = [
    () => adapter.invoke([], { executable: '' }),
    () => adapter.invoke([], { executable: 'open\0claw' }),
    () => adapter.invoke('not-an-array'),
    () => adapter.invoke(['gateway\0status']),
  ];

  for (const invoke of invalidCalls) assert.throws(invoke, TypeError);
  assert.equal(fsCalls, 0);
  assert.equal(processCalls, 0);
});

test('OpenClaw invocation validates per-call env at its synchronous boundary', () => {
  const fs = {
    async access() {},
    async stat() { return { isFile: () => true }; },
  };
  const adapter = createOpenClawAdapter({ env: { PATH: '' }, fs, platform: 'linux' });

  assert.throws(
    () => adapter.version({ executable: process.execPath, env: null }),
    TypeError,
  );
});

test('OpenClaw calls return a normalized immutable not-found result without spawning', async () => {
  let calls = 0;
  const processAdapter = { async run() { calls += 1; } };
  const fs = {
    async access() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    async stat() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  };
  const adapter = createOpenClawAdapter({ env: { PATH: '' }, fs, platform: 'linux', processAdapter });

  const result = await adapter.version();

  assert.equal(calls, 0);
  assert.deepEqual(result, {
    status: null,
    signal: null,
    stdout: '',
    stderr: '',
    errorSummary: 'OpenClaw executable not found',
    errorCode: 'ENOENT',
    timedOut: false,
    aborted: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    outputLimitExceeded: false,
  });
  assert.equal(Object.isFrozen(result), true);
});

test('already-aborted invocation returns an immutable aborted result without I/O', async () => {
  let fsCalls = 0;
  let processCalls = 0;
  const controller = new AbortController();
  controller.abort();
  const adapter = createOpenClawAdapter({
    env: { PATH: '/tools' },
    fs: {
      async access() { fsCalls += 1; },
      async stat() { fsCalls += 1; return { isFile: () => true }; },
    },
    processAdapter: { async run() { processCalls += 1; } },
  });

  const result = await adapter.invoke([], { signal: controller.signal });

  assert.deepEqual(result, ABORTED_RESULT);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(fsCalls, 0);
  assert.equal(processCalls, 0);
});

for (const blockedOperation of ['access', 'stat']) {
  test(`abort during blocked fs.${blockedOperation} settles without waiting for filesystem completion`, async () => {
    const gate = deferred();
    const started = deferred();
    let processCalls = 0;
    const controller = new AbortController();
    const fs = {
      async access() {
        if (blockedOperation === 'access') {
          started.resolve();
          return gate.promise;
        }
      },
      async stat() {
        if (blockedOperation === 'stat') {
          started.resolve();
          return gate.promise;
        }
        return { isFile: () => true };
      },
    };
    const adapter = createOpenClawAdapter({
      env: { PATH: '/tools' },
      fs,
      processAdapter: { async run() { processCalls += 1; } },
    });
    const pending = adapter.invoke([], { signal: controller.signal, timeoutMs: 1_000 });

    await started.promise;
    controller.abort();
    const result = await pending;

    assert.deepEqual(result, ABORTED_RESULT);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(processCalls, 0);
    gate.reject(new Error('late filesystem rejection'));
    await new Promise((resolve) => setImmediate(resolve));
  });
}

test('timeout bounds blocked executable discovery and returns a distinct immutable result', async () => {
  const gate = deferred();
  let processCalls = 0;
  const adapter = createOpenClawAdapter({
    env: { PATH: '/tools' },
    fs: {
      async access() { return gate.promise; },
      async stat() { return { isFile: () => true }; },
    },
    processAdapter: { async run() { processCalls += 1; } },
  });

  const result = await adapter.invoke([], { timeoutMs: 10 });

  assert.deepEqual(result, DISCOVERY_TIMEOUT_RESULT);
  assert.equal(Object.isFrozen(result), true);
  assert.notDeepEqual(result, ABORTED_RESULT);
  assert.equal(processCalls, 0);
  gate.reject(new Error('late filesystem rejection'));
  await new Promise((resolve) => setImmediate(resolve));
});

test('abort is checked between PATH and fallback probes', async () => {
  const checked = [];
  const controller = new AbortController();
  const adapter = createOpenClawAdapter({
    env: { PATH: '/missing' },
    fs: {
      async access(path) {
        checked.push(path);
        controller.abort();
        throw new Error('missing');
      },
      async stat() { throw new Error('unexpected stat'); },
    },
    processAdapter: { async run() { assert.fail('must not spawn'); } },
  });

  assert.deepEqual(
    await adapter.invoke([], { signal: controller.signal, timeoutMs: 1_000 }),
    ABORTED_RESULT,
  );
  assert.deepEqual(checked, ['/missing/openclaw']);
});

test('discovery time is deducted from the timeout passed to the process adapter', async () => {
  const gate = deferred();
  let processTimeout;
  const adapter = createOpenClawAdapter({
    env: { PATH: '/tools' },
    fs: {
      async access() { return gate.promise; },
      async stat() { return { isFile: () => true }; },
    },
    processAdapter: {
      async run(_executable, _argv, options) {
        processTimeout = options.timeoutMs;
        return Object.freeze({ status: 0 });
      },
    },
  });
  const pending = adapter.invoke([], { timeoutMs: 1_000 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  gate.resolve();

  await pending;

  assert.equal(Number.isSafeInteger(processTimeout), true);
  assert.equal(processTimeout > 0, true);
  assert.equal(processTimeout < 1_000, true);
});

test('invoke rejects a zero timeout synchronously without I/O', () => {
  let fsCalls = 0;
  let processCalls = 0;
  const adapter = createOpenClawAdapter({
    fs: {
      async access() { fsCalls += 1; },
      async stat() { fsCalls += 1; return { isFile: () => true }; },
    },
    processAdapter: { async run() { processCalls += 1; } },
  });

  assert.throws(() => adapter.invoke([], { timeoutMs: 0 }), TypeError);
  assert.equal(fsCalls, 0);
  assert.equal(processCalls, 0);
});
