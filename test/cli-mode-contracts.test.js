import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const cli = new URL('../cli/bin/clawfix.js', import.meta.url);
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const HOST_ABSOLUTE_OPENCLAW_FALLBACKS = [
  '/opt/homebrew/bin/openclaw',
  '/usr/local/bin/openclaw',
];

function stripAnsi(value) {
  return value.replace(ANSI, '');
}

async function findUnsafeHostAbsoluteOpenClawFallbacks(lstatPath = lstat) {
  const unsafe = [];
  for (const path of HOST_ABSOLUTE_OPENCLAW_FALLBACKS) {
    try {
      await lstatPath(path);
      unsafe.push(path);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        unsafe.push(`${path} (absence check failed: ${error?.code || 'unknown error'})`);
      }
    }
  }
  return unsafe;
}

async function createCliSandbox({ withOpenClaw = true, healthy = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'clawfix-cli-contract-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const workspace = join(home, 'workspace');
  const calls = join(root, 'openclaw-calls.log');
  await mkdir(bin, { recursive: true });

  const writeExecutable = async (name, contents) => {
    const path = join(bin, name);
    await writeFile(path, `#!/bin/sh\n${contents}\n`);
    await chmod(path, 0o755);
  };

  await writeExecutable('which', `
if [ "$1" = "openclaw" ] && [ -n "$CLAWFIX_TEST_OPENCLAW" ] && [ -x "$CLAWFIX_TEST_OPENCLAW" ]; then
  printf '%s\\n' "$CLAWFIX_TEST_OPENCLAW"
  exit 0
fi
exit 1`);
  await writeExecutable('npm', `printf '%s\\n' '10.0.0'`);
  for (const command of ['id', 'launchctl', 'lsof', 'pgrep', 'ps', 'ss', 'systemctl', 'tail']) {
    await writeExecutable(command, 'exit 1');
  }

  let openclaw = join(bin, 'openclaw');
  if (withOpenClaw) {
    await mkdir(join(home, '.openclaw', 'logs'), { recursive: true });
    await mkdir(join(workspace, 'memory'), { recursive: true });
    await writeFile(join(home, '.openclaw', 'openclaw.json'), `${JSON.stringify({
      gateway: { port: 65431 },
      agents: { defaults: { workspace } },
      plugins: { entries: {} },
    }, null, 2)}\n`);
    await writeFile(join(workspace, 'SOUL.md'), '# Test soul\n');
    await writeFile(join(workspace, 'AGENTS.md'), '# Test instructions\n');
    await writeFile(join(workspace, 'MEMORY.md'), '# Test memory\n');

    const reachable = healthy ? 'true' : 'false';
    const runtime = healthy ? 'Runtime: running (pid 4242)' : 'Runtime: stopped';
    await writeFile(openclaw, `#!/bin/sh
printf '%s\\n' "$*" >> "$CLAWFIX_TEST_CALLS"
case "$*" in
  "--version") echo '2026.7.1' ;;
  "gateway status"*) echo '${runtime}' ;;
  "doctor "*) echo '{"ok":true,"checksRun":1,"checksSkipped":0,"findings":[]}' ;;
  "config validate --json") echo '{"valid":true,"issues":[],"warnings":[]}' ;;
  "status --json") echo '{"runtimeVersion":"2026.7.1","gateway":{"reachable":${reachable}}}' ;;
  "security audit --json") echo '{"summary":{"critical":0,"warn":0,"info":0},"findings":[]}' ;;
  *) exit 0 ;;
esac
`);
    await chmod(openclaw, 0o755);
  } else {
    openclaw = null;
  }

  return {
    root,
    home,
    bin,
    workspace,
    calls,
    openclaw,
    env(extra = {}) {
      const allowedOverrides = new Set(['CLAWFIX_API', 'CLAWFIX_AUTO']);
      const unsupported = Object.keys(extra).filter(key => !allowedOverrides.has(key));
      if (unsupported.length > 0) {
        throw new Error(`Unsupported sandbox environment override: ${unsupported.join(', ')}`);
      }
      return {
        HOME: home,
        PATH: bin,
        CLAWFIX_TEST_CALLS: calls,
        CLAWFIX_TEST_OPENCLAW: openclaw || '',
        CLAWFIX_API: 'http://127.0.0.1:9',
        ...extra,
      };
    },
    async callLog() {
      try {
        return await readFile(calls, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return '';
        throw error;
      }
    },
    cleanup() {
      return rm(root, { recursive: true, force: true });
    },
  };
}

function runCli(sandbox, args, { env = {}, input = '', timeout = 8_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli.pathname, ...args], {
      env: sandbox.env(env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, timedOut });
    });
    child.stdin.end(input);
  });
}

async function withServer(handler, fn) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, body });
      handler(request, response);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({ url, requests });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('output matching starts at the supplied cursor', () => {
  const firstOutput = 'clawfix> ';
  const firstCursor = findOutputMatchAfterCursor(firstOutput, /clawfix>\s*$/, 0);
  assert.equal(firstCursor, firstOutput.length);
  assert.equal(findOutputMatchAfterCursor(firstOutput, /clawfix>\s*$/, firstCursor), null);

  const secondOutput = `${firstOutput}Rescanning\nclawfix> `;
  const rescanCursor = findOutputMatchAfterCursor(secondOutput, /Rescanning/, firstCursor);
  assert.equal(rescanCursor, firstOutput.length + 'Rescanning'.length);
  assert.equal(findOutputMatchAfterCursor(secondOutput, /clawfix>\s*$/, rescanCursor), secondOutput.length);
});

function findOutputMatchAfterCursor(output, pattern, cursor) {
  const searchable = stripAnsi(output).slice(cursor);
  const matcher = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
  const match = matcher.exec(searchable);
  return match ? cursor + match.index + match[0].length : null;
}

function waitForOutput(child, getOutput, pattern, cursor, timeout = 8_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${pattern}; output: ${stripAnsi(getOutput())}`));
    }, timeout);
    const inspect = () => {
      const nextCursor = findOutputMatchAfterCursor(getOutput(), pattern, cursor);
      if (nextCursor === null) return;
      cleanup();
      resolve(nextCursor);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', inspect);
      child.stderr.off('data', inspect);
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    inspect();
  });
}

async function runInteractiveScript(sandbox, steps, { apiUrl, timeout = 8_000 } = {}) {
  const child = spawn(process.execPath, [cli.pathname], {
    env: sandbox.env(apiUrl ? { CLAWFIX_API: apiUrl } : {}),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let output = '';
  let timer;
  let outputCursor = 0;
  child.stdout.on('data', chunk => {
    stdout += chunk;
    output += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
    output += chunk;
  });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
  });

  try {
    for (const { waitFor, send } of steps) {
      outputCursor = await waitForOutput(child, () => output, waitFor, outputCursor);
      if (send !== undefined) child.stdin.write(send);
    }
    child.stdin.end();
    return await Promise.race([
      completion,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Interactive CLI timed out; output: ${stripAnsi(output)}`));
        }, timeout);
      }),
    ]);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    try { await completion; } catch {}
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

test('host absolute fallback safety reports only paths that may be present', async () => {
  const calls = [];
  const fakeLstat = async path => {
    calls.push(path);
    if (path === '/opt/homebrew/bin/openclaw') return { isFile: () => true };
    const error = new Error('not found');
    error.code = 'ENOENT';
    throw error;
  };

  assert.deepEqual(await findUnsafeHostAbsoluteOpenClawFallbacks(fakeLstat), [
    '/opt/homebrew/bin/openclaw',
  ]);
  assert.deepEqual(calls, [
    '/opt/homebrew/bin/openclaw',
    '/usr/local/bin/openclaw',
  ]);
});

test('CLI harness creates an isolated HOME with a fake openclaw executable', async () => {
  const sandbox = await createCliSandbox();
  try {
    assert.notEqual(sandbox.home, process.env.HOME);
    assert.match(sandbox.openclaw, /openclaw$/);
    const childEnv = sandbox.env();
    assert.equal(childEnv.PATH, sandbox.bin);
    assert.equal(childEnv.CLAWFIX_AUTO, undefined);
    assert.equal(childEnv.CLAWFIX_API_TOKEN, undefined);
    assert.equal(childEnv.NODE_OPTIONS, undefined);
    const result = await runCli(sandbox, ['--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(await sandbox.callLog(), /^--version$/m);
  } finally {
    await sandbox.cleanup();
  }
});

test('help and version aliases exit before scanning or sending', async () => {
  const sandbox = await createCliSandbox();
  try {
    for (const [flag, expected] of [
      ['--help', /Usage: npx clawfix \[options\]/],
      ['-h', /Usage: npx clawfix \[options\]/],
      ['--version', /^clawfix v0\.11\.1\n$/],
      ['-v', /^clawfix v0\.11\.1\n$/],
      ['-V', /^clawfix v0\.11\.1\n$/],
    ]) {
      const result = await runCli(sandbox, [flag]);
      assert.equal(result.status, 0, `${flag}: ${result.stderr}`);
      assert.match(result.stdout, expected, flag);
      assert.equal(result.stderr, '', flag);
    }
    assert.equal(await sandbox.callLog(), '');
  } finally {
    await sandbox.cleanup();
  }
});

test('JSON mode keeps stdout parseable and makes no request even when combined with --yes', async () => {
  const sandbox = await createCliSandbox();
  try {
    await withServer((request, response) => response.end('{}'), async ({ url, requests }) => {
      const result = await runCli(sandbox, ['--json', '--yes', '--server', url]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.timedOut, false);
      assert.equal(result.stderr, '');
      const output = JSON.parse(result.stdout);
      assert.equal(output.ok, true);
      assert.equal(output.diagnostic.openclaw.binary, sandbox.openclaw);
      assert.ok(Array.isArray(output.issues));
      assert.equal(requests.length, 0);
    });
  } finally {
    await sandbox.cleanup();
  }
});

test('JSON soft-miss when OpenClaw is absent from isolated HOME and PATH', async t => {
  const unsafeHostFallbacks = await findUnsafeHostAbsoluteOpenClawFallbacks();
  if (unsafeHostFallbacks.length > 0) {
    const reason = `host absolute OpenClaw fallback is present or could not be proven absent: ${unsafeHostFallbacks.join(', ')}`;
    if (process.env.CI) assert.fail(`CI isolation requirement failed: ${reason}`);
    t.skip(reason);
    return;
  }

  const sandbox = await createCliSandbox({ withOpenClaw: false });
  try {
    const result = await runCli(sandbox, ['--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.timedOut, false);
    // The sandboxed fake `which` fails quietly instead of falling through to
    // a host shell implementation.
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      openclawFound: false,
      code: 'OPENCLAW_NOT_FOUND',
      error: 'OpenClaw not found on this system.',
    });
  } finally {
    await sandbox.cleanup();
  }
});

test('dry-run soft-miss exits 0 when OpenClaw is absent', async t => {
  const unsafeHostFallbacks = await findUnsafeHostAbsoluteOpenClawFallbacks();
  if (unsafeHostFallbacks.length > 0) {
    const reason = `host absolute OpenClaw fallback is present or could not be proven absent: ${unsafeHostFallbacks.join(', ')}`;
    if (process.env.CI) assert.fail(`CI isolation requirement failed: ${reason}`);
    t.skip(reason);
    return;
  }

  const sandbox = await createCliSandbox({ withOpenClaw: false });
  try {
    const result = await runCli(sandbox, ['--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(stripAnsi(result.stdout), /LOCAL-ONLY MODE — nothing will be sent/);
    assert.match(stripAnsi(result.stdout), /OpenClaw not found on this system/);
    assert.match(stripAnsi(result.stdout), /Local scan complete — nothing was sent/);
  } finally {
    await sandbox.cleanup();
  }
});

test('local-only flags and dry-run short alias scan without outbound requests', async () => {
  for (const flag of ['--dry-run', '-n', '--no-send', '--local-only']) {
    const sandbox = await createCliSandbox();
    try {
      await withServer((request, response) => response.end('{}'), async ({ url, requests }) => {
        const result = await runCli(sandbox, [flag, '--server', url]);
        assert.equal(result.status, 0, `${flag}: ${result.stderr}`);
        assert.equal(result.timedOut, false, flag);
        assert.match(stripAnsi(result.stdout), /LOCAL-ONLY MODE — nothing will be sent/, flag);
        assert.match(stripAnsi(result.stdout), /Local scan complete — nothing was sent/, flag);
        assert.equal(requests.length, 0, flag);
      });
    } finally {
      await sandbox.cleanup();
    }
  }
});

test('--show-data and -d select one-shot mode and print the diagnostic payload', async () => {
  for (const flag of ['--show-data', '-d']) {
    const sandbox = await createCliSandbox({ healthy: true });
    try {
      const result = await runCli(sandbox, [flag]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.timedOut, false);
      const output = stripAnsi(result.stdout);
      assert.match(output, /Data that would be sent:/);
      assert.match(output, /"openclaw":\s*\{/);
      assert.ok(output.includes(sandbox.openclaw), `missing sandbox OpenClaw binary ${sandbox.openclaw}`);
    } finally {
      await sandbox.cleanup();
    }
  }
});

test('--scan and --no-interactive finish on closed non-TTY stdin instead of waiting for consent', async () => {
  for (const flag of ['--scan', '--no-interactive']) {
    const sandbox = await createCliSandbox();
    try {
      const result = await runCli(sandbox, [flag]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.timedOut, false, flag);
      assert.match(stripAnsi(result.stdout), /Send diagnostic for AI analysis\? \[y\/N\]/, flag);
      // Closing stdin answers neither yes nor no: the current CLI exits cleanly
      // at the prompt without printing the explicit-decline follow-up.
      assert.doesNotMatch(stripAnsi(result.stdout), /No problem! Review data first with:/, flag);
    } finally {
      await sandbox.cleanup();
    }
  }
});

test('--yes, -y, and CLAWFIX_AUTO=1 each auto-send in one-shot mode', async () => {
  const cases = [
    { args: ['--scan', '--yes'], env: {} },
    { args: ['--scan', '-y'], env: {} },
    { args: ['--scan'], env: { CLAWFIX_AUTO: '1' } },
  ];
  for (const item of cases) {
    const sandbox = await createCliSandbox();
    try {
      await withServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ fixId: 'test-fix', issuesFound: 0, knownIssues: [] }));
      }, async ({ url, requests }) => {
        const result = await runCli(sandbox, item.args, { env: { ...item.env, CLAWFIX_API: url } });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.timedOut, false);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].method, 'POST');
        assert.equal(requests[0].url, '/api/diagnose');
      });
    } finally {
      await sandbox.cleanup();
    }
  }
});

test('--server URL and --server=URL both select the custom server', async () => {
  for (const form of ['separate', 'inline']) {
    const sandbox = await createCliSandbox();
    try {
      await withServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ fixId: form, issuesFound: 0, knownIssues: [] }));
      }, async ({ url, requests }) => {
        const serverArgs = form === 'separate' ? ['--server', url] : [`--server=${url}`];
        const result = await runCli(sandbox, ['--scan', '--yes', ...serverArgs]);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, '/api/diagnose');
      });
    } finally {
      await sandbox.cleanup();
    }
  }
});

test('upload failure is reported on stdout and currently exits zero', async () => {
  const sandbox = await createCliSandbox();
  try {
    await withServer((request, response) => {
      response.statusCode = 503;
      response.end('maintenance');
    }, async ({ url, requests }) => {
      const result = await runCli(sandbox, ['--scan', '--yes', `--server=${url}`]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(requests.length, 1);
      assert.match(stripAnsi(result.stdout), /Error: API returned 503: maintenance/);
      assert.equal(result.stderr, '');
    });
  } finally {
    await sandbox.cleanup();
  }
});

test('unknown flags are ignored when a recognized noninteractive mode is present', async () => {
  const sandbox = await createCliSandbox();
  try {
    const baseline = await runCli(sandbox, ['--json']);
    const unknown = await runCli(sandbox, ['--definitely-unknown', '--json']);
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(unknown.status, 0, unknown.stderr);
    assert.equal(unknown.timedOut, false);
    const baselineDocument = JSON.parse(baseline.stdout);
    const unknownDocument = JSON.parse(unknown.stdout);
    delete baselineDocument.diagnostic.timestamp;
    delete unknownDocument.diagnostic.timestamp;
    assert.deepEqual(unknownDocument, baselineDocument);
    assert.equal(unknown.stderr, '');

    const unknownOnly = await runCli(sandbox, ['--definitely-unknown']);
    assert.equal(unknownOnly.status, 0, unknownOnly.stderr);
    assert.equal(unknownOnly.timedOut, false);
    assert.match(stripAnsi(unknownOnly.stdout), /Send redacted diagnostic for AI analysis\? \[y\/N\]/);
    assert.doesNotMatch(unknownOnly.stderr, /unknown|invalid/i);
  } finally {
    await sandbox.cleanup();
  }
});

test('conflicting flags preserve current precedence', async () => {
  const sandbox = await createCliSandbox();
  try {
    const versionBeforeHelp = await runCli(sandbox, ['--help', '--version']);
    assert.equal(versionBeforeHelp.status, 0);
    assert.equal(versionBeforeHelp.stdout, 'clawfix v0.11.1\n');

    await withServer((request, response) => response.end('{}'), async ({ url, requests }) => {
      const localBeforeAutoSend = await runCli(sandbox, ['--dry-run', '--yes', '--server', url]);
      assert.equal(localBeforeAutoSend.status, 0, localBeforeAutoSend.stderr);
      assert.match(stripAnsi(localBeforeAutoSend.stdout), /Local scan complete — nothing was sent/);
      assert.equal(requests.length, 0);
    });
  } finally {
    await sandbox.cleanup();
  }
});

test('missing and invalid server values fail before scanning', async () => {
  const sandbox = await createCliSandbox();
  try {
    const missing = await runCli(sandbox, ['--server']);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /Missing value for --server/);

    const invalid = await runCli(sandbox, ['--server=file:///tmp']);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /Invalid ClawFix API URL/);
    assert.equal(await sandbox.callLog(), '');
  } finally {
    await sandbox.cleanup();
  }
});

test('interactive startup supports explicit decline, deterministic offline help, and clean exit', async () => {
  const sandbox = await createCliSandbox();
  try {
    await withServer((request, response) => response.end('{}'), async ({ url, requests }) => {
      const result = await runInteractiveScript(sandbox, [
        { waitFor: /Send redacted diagnostic for AI analysis\? \[y\/N\]/, send: 'n\n' },
        { waitFor: /clawfix>\s*$/, send: 'why is it broken?\n' },
        { waitFor: /Unknown local command\. Type help/, send: 'exit\n' },
      ], { apiUrl: url });
      assert.equal(result.status, 0, result.stderr);
      const output = stripAnsi(result.stdout);
      assert.match(output, /Scanning your OpenClaw installation/);
      assert.match(output, /Unknown local command\. Type help/);
      assert.match(output, /ClawFix — made by Arca/);
      assert.equal(requests.length, 0);
    });
  } finally {
    await sandbox.cleanup();
  }
});

test('interactive rescan re-runs diagnostics after declining upload', async () => {
  const sandbox = await createCliSandbox();
  try {
    const result = await runInteractiveScript(sandbox, [
      { waitFor: /Send redacted diagnostic for AI analysis\? \[y\/N\]/, send: 'n\n' },
      { waitFor: /clawfix>\s*$/, send: 'rescan\n' },
      { waitFor: /Rescanning/ },
      { waitFor: /clawfix>\s*$/, send: 'exit\n' },
    ]);
    assert.equal(result.status, 0, result.stderr);
    const versionCalls = (await sandbox.callLog()).split('\n').filter(line => line === '--version');
    assert.equal(versionCalls.length, 2);
  } finally {
    await sandbox.cleanup();
  }
});

test('entrypoint is thin mode dispatch and plain interface owns session event text rendering', async () => {
  const [entry, plainSource] = await Promise.all([
    readFile(new URL('../cli/bin/clawfix.js', import.meta.url), 'utf8'),
    readFile(new URL('../cli/interfaces/plain.js', import.meta.url), 'utf8'),
  ]);
  assert.match(entry, /import \{ runPlainInterface \} from '\.\.\/interfaces\/plain\.js'/);
  assert.match(entry, /CLI_MODE\.kind === 'one-shot'/);
  assert.match(entry, /CLI_MODE\.kind === 'interactive'/);
  assert.match(entry, /runPlainInterface\(\{/);
  assert.doesNotMatch(entry, /BUILTIN_FIXES|deriveIssues|collectDiagnosticsLegacy|createDiagnosticsCore/);
  assert.match(plainSource, /export async function runPlainInterface/);
  assert.match(plainSource, /export function formatSessionEvent/);
  assert.match(plainSource, /export function renderSessionEvent/);
  assert.match(plainSource, /createDiagnosticsCore|createSessionController|createRepairEngine/);

  const { formatSessionEvent, renderSessionEvent } = await import('../cli/interfaces/plain.js');
  assert.equal(
    formatSessionEvent({ type: 'scan.step', phase: 'discover', label: 'Looking for OpenClaw', revision: 'r1' }),
    'scan step [discover] Looking for OpenClaw',
  );
  assert.equal(
    formatSessionEvent({ type: 'session.scan.committed', revision: 'r2', findingsCount: 3, error: null }),
    'session scan committed revision=r2 findings=3',
  );
  assert.equal(
    formatSessionEvent({
      type: 'session.scan.committed',
      revision: 'r3',
      findingsCount: 0,
      error: { message: 'OpenClaw not found on this system.' },
    }),
    'session scan failed revision=r3: OpenClaw not found on this system.',
  );
  const lines = [];
  renderSessionEvent({ type: 'session.message', role: 'assistant', text: 'hello' }, line => lines.push(line));
  assert.deepEqual(lines, ['assistant: hello']);
});
