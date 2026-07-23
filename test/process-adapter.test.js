import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  createProcessAdapter,
  runProcess,
  runProcessSync,
} from '../cli/adapters/process.js';

function createInjectedChild({ kill } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.destroyedByAdapter = false;
  child.stderr.destroyedByAdapter = false;
  child.stdout.destroy = () => { child.stdout.destroyedByAdapter = true; };
  child.stderr.destroy = () => { child.stderr.destroyedByAdapter = true; };
  child.killed = false;
  child.unrefCalled = false;
  child.unref = () => { child.unrefCalled = true; };
  child.kill = kill ?? (() => {
    child.killed = true;
    return true;
  });
  return child;
}

async function within(promise, milliseconds = 250) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`promise did not settle within ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('runProcess passes shell metacharacters and newlines as literal argv without side effects', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'clawfix-process-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sideEffect = join(directory, 'injected');
  const argv = Object.freeze([
    '-e',
    'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
    'contains spaces',
    '"quoted"',
    `semi;touch ${sideEffect}`,
    '$HOME',
    'line one\nline two',
  ]);

  const result = await runProcess(process.execPath, argv);

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), argv.slice(2));
  await assert.rejects(access(sideEffect));
  assert.equal(Object.isFrozen(result), true);
});

test('factory snapshots argv and env and forces shell off despite caller options', async () => {
  let observed;
  const adapter = createProcessAdapter({
    spawn(executable, argv, options) {
      observed = { executable, argv, options };
      return {
        stdout: null,
        stderr: null,
        killed: false,
        on(event, listener) {
          if (event === 'close') queueMicrotask(() => listener(0, null));
          return this;
        },
        removeListener() {},
        kill() {},
      };
    },
    spawnSync() {},
  });
  const argv = ['hello world'];
  const env = { CLAWFIX_TEST: 'original' };
  const cwd = pathToFileURL(tmpdir());

  const pending = adapter.run('program', argv, { shell: true, env, cwd });
  argv[0] = 'changed';
  env.CLAWFIX_TEST = 'changed';
  cwd.pathname = '/changed';
  await pending;

  assert.equal(observed.options.shell, false);
  assert.deepEqual(observed.argv, ['hello world']);
  assert.equal(Object.isFrozen(observed.argv), true);
  assert.deepEqual(observed.options.env, { CLAWFIX_TEST: 'original' });
  assert.equal(Object.isFrozen(observed.options.env), true);
  assert.equal(observed.options.cwd.href, pathToFileURL(tmpdir()).href);
  assert.notEqual(observed.options.cwd, cwd);
});

test('async execution bounds stdout and stderr separately with truncation flags', async () => {
  const result = await runProcess(process.execPath, Object.freeze([
    '-e',
    "process.stdout.write('abcdef'); process.stderr.write('uvwxyz')",
  ]), { maxStdoutBytes: 3, maxStderrBytes: 4 });

  assert.equal(result.stdout, 'abc');
  assert.equal(result.stderr, 'uvwx');
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
  assert.equal(result.outputLimitExceeded, false);
});

test('real async multibyte truncation drops an incomplete trailing UTF-8 code point', async () => {
  const result = await runProcess(process.execPath, [
    '-e',
    "process.stdout.write('A€B')",
  ], { maxStdoutBytes: 3 });

  assert.equal(result.stdout, 'A');
  assert.equal(result.stdout.includes('\uFFFD'), false);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.outputLimitExceeded, false);
});

test('real async collector decodes a multibyte code point split across writes', async () => {
  const result = await runProcess(process.execPath, [
    '-e',
    [
      'process.stdout.write(Buffer.from([0x41, 0xe2]));',
      'setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac, 0x42])), 10);',
    ].join(' '),
  ], { maxStdoutBytes: 4 });

  assert.equal(result.stdout, 'A€');
  assert.equal(result.stdout.includes('\uFFFD'), false);
  assert.equal(result.stdoutTruncated, true);
});

test('async collector copies retained prefixes instead of retaining source backing buffers', async () => {
  const child = createInjectedChild();
  const source = Buffer.alloc(1024 * 1024, 0x78);
  source.set(Buffer.from('abc'));
  const adapter = createProcessAdapter({
    spawn() {
      queueMicrotask(() => {
        child.stdout.emit('data', source);
        source.fill(0x7a, 0, 3);
        child.emit('close', 0, null);
      });
      return child;
    },
    spawnSync() {},
  });

  const result = await adapter.run('program', [], { maxStdoutBytes: 3 });

  assert.equal(result.stdout, 'abc');
  assert.equal(result.stdoutTruncated, true);
});

test('async execution normalizes nonzero and missing executable outcomes', async () => {
  const nonzero = await runProcess(process.execPath, Object.freeze(['-e', 'process.exit(7)']));
  const missing = await runProcess(`missing-clawfix-${process.pid}`, Object.freeze([]));

  assert.equal(nonzero.status, 7);
  assert.equal(nonzero.errorCode, null);
  assert.equal(missing.status, null);
  assert.equal(missing.errorCode, 'ENOENT');
  assert.match(missing.errorSummary, /ENOENT/);
});

test('async timeout kills and reaps the direct child without throwing', async () => {
  const started = Date.now();
  const result = await runProcess(process.execPath, Object.freeze([
    '-e',
    'setInterval(() => {}, 1000)',
  ]), { timeoutMs: 30 });

  assert.equal(result.status, null);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
  assert.equal(result.errorCode, 'ETIMEDOUT');
  assert.ok(Date.now() - started < 2_000);
});

for (const [description, kill] of [
  ['returns false', () => false],
  ['throws', () => { throw new Error('injected kill failure'); }],
]) {
  test(`async timeout settles with ETIMEDOUT when kill ${description} and close never arrives`, async () => {
    const child = createInjectedChild({ kill });
    const adapter = createProcessAdapter({
      spawn: () => child,
      spawnSync() {},
      killGraceMs: 15,
    });

    let settlements = 0;
    const result = await within(adapter.run('program', [], { timeoutMs: 5 }).then((value) => {
      settlements += 1;
      return value;
    }));
    const settledResult = { ...result };

    assert.equal(result.timedOut, true);
    assert.equal(result.errorCode, 'ETIMEDOUT');
    assert.match(result.errorSummary, /termination unconfirmed after 15ms/);
    assert.equal(child.stdout.destroyedByAdapter, true);
    assert.equal(child.stderr.destroyedByAdapter, true);
    assert.equal(child.unrefCalled, true);
    assert.equal(child.stdout.listenerCount('data'), 0);
    assert.equal(child.stderr.listenerCount('data'), 0);
    assert.equal(child.listenerCount('close'), 1);
    assert.equal(child.listenerCount('error'), 1);

    assert.doesNotThrow(() => child.emit('error', new Error('late child error')));
    assert.deepEqual(result, settledResult);
    assert.equal(settlements, 1);
    assert.equal(child.listenerCount('close'), 1);
    assert.equal(child.listenerCount('error'), 1);

    child.emit('close', null, 'SIGKILL');
    assert.deepEqual(result, settledResult);
    assert.equal(settlements, 1);
    assert.equal(child.listenerCount('close'), 0);
    assert.equal(child.listenerCount('error'), 0);
  });
}

test('async timeout lets close before kill grace win and ignores a later close', async () => {
  const child = createInjectedChild({
    kill() {
      setTimeout(() => child.emit('close', null, 'SIGKILL'), 10);
      return true;
    },
  });
  const adapter = createProcessAdapter({
    spawn: () => child,
    spawnSync() {},
    killGraceMs: 50,
  });
  let settlements = 0;

  const result = await within(adapter.run('program', [], { timeoutMs: 5 }).then((value) => {
    settlements += 1;
    return value;
  }));
  child.emit('close', 1, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.errorCode, 'ETIMEDOUT');
  assert.doesNotMatch(result.errorSummary, /termination unconfirmed/);
  assert.equal(settlements, 1);
  assert.equal(child.stdout.destroyedByAdapter, false);
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
  assert.equal(child.listenerCount('close'), 0);
  assert.equal(child.listenerCount('error'), 0);
});

test('AbortSignal is normalized when already aborted and while child is running', async () => {
  const already = new AbortController();
  already.abort();
  const beforeSpawn = await runProcess(process.execPath, Object.freeze(['--version']), {
    signal: already.signal,
  });

  const running = new AbortController();
  const pending = runProcess(process.execPath, Object.freeze([
    '-e',
    'setInterval(() => {}, 1000)',
  ]), { signal: running.signal, timeoutMs: 2_000 });
  setTimeout(() => running.abort(), 20);
  const midFlight = await pending;

  for (const result of [beforeSpawn, midFlight]) {
    assert.equal(result.aborted, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.errorCode, 'ABORT_ERR');
    assert.equal(result.outputLimitExceeded, false);
  }
  assert.equal(midFlight.signal, 'SIGKILL');
});

test('async abort preserves ABORT_ERR when termination cannot be confirmed', async () => {
  const child = createInjectedChild({ kill: () => false });
  const controller = new AbortController();
  const adapter = createProcessAdapter({
    spawn: () => child,
    spawnSync() {},
    killGraceMs: 15,
  });

  const pending = adapter.run('program', [], { signal: controller.signal, timeoutMs: 1_000 });
  controller.abort();
  const result = await within(pending);

  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.errorCode, 'ABORT_ERR');
  assert.match(result.errorSummary, /termination unconfirmed after 15ms/);
});

test('repeated timeout and abort races settle once without late unhandled errors', async () => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const results = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
      const controller = new AbortController();
      const pending = runProcess(process.execPath, Object.freeze([
        '-e',
        'setInterval(() => {}, 1000)',
      ]), { signal: controller.signal, timeoutMs: 15 + (index % 2) });
      setTimeout(() => controller.abort(), 15);
      return pending;
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(unhandled, []);
    for (const result of results) {
      assert.equal(Number(result.timedOut) + Number(result.aborted), 1);
    }
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('runProcessSync normalizes success, nonzero, missing executable, timeout, and truncation', () => {
  const success = runProcessSync(process.execPath, Object.freeze([
    '-e',
    "process.stdout.write('abcdef'); process.stderr.write('uvwxyz')",
  ]));
  const nonzero = runProcessSync(process.execPath, Object.freeze(['-e', 'process.exit(9)']));
  const missing = runProcessSync(`missing-clawfix-${process.pid}`, Object.freeze([]));
  const timeout = runProcessSync(process.execPath, Object.freeze([
    '-e',
    'setInterval(() => {}, 1000)',
  ]), { timeoutMs: 30 });

  assert.deepEqual({
    status: success.status,
    stdout: success.stdout,
    stderr: success.stderr,
    stdoutTruncated: success.stdoutTruncated,
    stderrTruncated: success.stderrTruncated,
  }, {
    status: 0,
    stdout: 'abcdef',
    stderr: 'uvwxyz',
    stdoutTruncated: false,
    stderrTruncated: false,
  });
  assert.equal(nonzero.status, 9);
  assert.equal(nonzero.errorCode, null);
  assert.equal(missing.errorCode, 'ENOENT');
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.errorCode, 'ETIMEDOUT');
  assert.equal(timeout.outputLimitExceeded, false);
  assert.equal(Object.isFrozen(timeout), true);
});

for (const stream of ['stdout', 'stderr']) {
  test(`sync real-child ${stream} ENOBUFS is a terminal output-limit outcome with bounded output`, () => {
    const result = runProcessSync(process.execPath, [
      '-e',
      `process.${stream}.write(Buffer.alloc(65536, 0x61))`,
    ], { maxStdoutBytes: 4, maxStderrBytes: 4 });

    assert.equal(result.status, null);
    assert.equal(result.errorCode, 'ENOBUFS');
    assert.equal(result.outputLimitExceeded, true);
    assert.equal(result[stream], 'aaaa');
    assert.equal(result[`${stream}Truncated`], true);
    assert.ok(Buffer.byteLength(result.stdout) <= 4);
    assert.ok(Buffer.byteLength(result.stderr) <= 4);
    assert.equal(Object.isFrozen(result), true);
  });
}

test('real sync multibyte ENOBUFS output drops an incomplete trailing UTF-8 code point', () => {
  const result = runProcessSync(process.execPath, [
    '-e',
    "process.stdout.write('A€B')",
  ], { maxStdoutBytes: 3, maxStderrBytes: 3 });

  assert.equal(result.errorCode, 'ENOBUFS');
  assert.equal(result.outputLimitExceeded, true);
  assert.equal(result.stdout, 'A');
  assert.equal(result.stdout.includes('\uFFFD'), false);
  assert.equal(result.stdoutTruncated, true);
});

test('sync factory forces shell off and normalizes injected ETIMEDOUT and signal', () => {
  let observed;
  const timeoutError = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
  const adapter = createProcessAdapter({
    spawn() {},
    spawnSync(executable, argv, options) {
      observed = { executable, argv, options };
      return {
        status: null,
        signal: 'SIGTERM',
        stdout: 'output',
        stderr: 'errors',
        error: timeoutError,
      };
    },
  });

  const result = adapter.runSync('openclaw', Object.freeze(['gateway', 'status']), {
    shell: true,
    maxStdoutBytes: 3,
    maxStderrBytes: 4,
  });

  assert.equal(observed.options.shell, false);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.timedOut, true);
  assert.equal(result.errorCode, 'ETIMEDOUT');
  assert.equal(result.outputLimitExceeded, false);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'erro');
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
});

test('programmer misuse fails fast while metacharacters remain valid', async () => {
  await assert.rejects(() => runProcess('', Object.freeze([])), TypeError);
  await assert.rejects(() => runProcess('ok', Object.freeze([3])), TypeError);
  await assert.rejects(() => runProcess('ok', Object.freeze([]), { env: null }), TypeError);
  await assert.rejects(() => runProcess('ok', Object.freeze([]), { env: [] }), TypeError);
  await assert.rejects(() => runProcess('ok', Object.freeze([]), { cwd: 42 }), TypeError);
  await assert.rejects(() => runProcess('ok', Object.freeze([]), { cwd: new URL('https://example.com') }), TypeError);
  await assert.rejects(
    () => runProcess('ok', Object.freeze([]), { timeoutMs: 0 }),
    /timeoutMs must be a positive safe integer/,
  );
  assert.throws(() => runProcessSync('ok', Object.freeze([]), { windowsHide: 'yes' }), TypeError);
  assert.throws(() => runProcessSync('ok', Object.freeze([]), { timeoutMs: -1 }), TypeError);
  assert.throws(
    () => runProcessSync('ok', Object.freeze([]), { timeoutMs: 0 }),
    /timeoutMs must be a positive safe integer/,
  );
});
