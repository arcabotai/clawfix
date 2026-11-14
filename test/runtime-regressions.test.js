import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DOCTOR_LINT_TIMEOUT_MS,
  collectListeningPort,
  collectNativeConfigValidation,
  collectNativeDoctor,
  collectNativeSecurityAudit,
  collectNativeStatus,
} from '../cli/bin/native-diagnostics.js';
import { detectIssues, matchLocalKnownIssues } from '../src/known-issues.js';
import { DIAGNOSTIC_SCRIPT } from '../src/routes/script.js';
import { validateRepairScript } from '../src/repair-validator.js';
import { createServerStarter } from '../src/server-start.js';

const successfulSpawn = (stdout = '') => ({ status: 0, signal: null, stdout, stderr: '' });

test('native doctor runs the broad lint set and skips only workspace-heavy readiness checks', () => {
  let args;
  let timeout;
  const result = collectNativeDoctor('/usr/local/bin/openclaw', (_command, received, options) => {
    args = received;
    timeout = options.timeout;
    if (received.includes('--include')) {
      return { status: 2, stdout: '', stderr: 'error: unknown option --include' };
    }
    return successfulSpawn(JSON.stringify({ ok: true, checksRun: 2, checksSkipped: 0, findings: [] }));
  });

  assert.equal(args.includes('--include'), false);
  assert.equal(args.includes('--only'), false);
  assert.deepEqual(args.slice(args.indexOf('--skip'), args.indexOf('--skip') + 2), [
    '--skip',
    'core/doctor/skills-readiness',
  ]);
  assert.equal(timeout, DOCTOR_LINT_TIMEOUT_MS);
  assert.equal(timeout, 120_000);
  assert.equal(result.available, true);
  assert.equal(result.timedOut, false);
});

test('native config validation parses the OpenClaw 2026.6.11 issues shape', () => {
  const result = collectNativeConfigValidation('/usr/local/bin/openclaw', () => ({
    status: 1,
    stdout: JSON.stringify({
      valid: false,
      configPath: `${process.env.HOME}/.openclaw/openclaw.json`,
      issues: [
        { path: 'gateway.port', message: 'Expected number, received string' },
        { path: ['plugins', 'entries', 'codex'], message: 'Invalid plugin configuration' },
      ],
    }),
    stderr: '',
  }));

  assert.equal(result.available, true);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map(error => error.path), [
    'gateway.port',
    'plugins.entries.codex',
  ]);
  assert.equal(result.errors[0].kind, 'schema');
});

test('native config validation keeps compatible string and object errors', () => {
  const result = collectNativeConfigValidation('/usr/local/bin/openclaw', () => ({
    status: 1,
    stdout: JSON.stringify({
      ok: false,
      errors: ['Malformed JSON5', { code: 'invalid_type', ref: 'gateway.mode', error: 'Required' }],
    }),
    stderr: '',
  }));

  assert.equal(result.valid, false);
  assert.equal(result.errors[0].message, 'Malformed JSON5');
  assert.deepEqual(result.errors[1], {
    kind: 'invalid_type',
    path: 'gateway.mode',
    message: 'Required',
  });
});

test('native config validation parses the complete adapter-bounded JSON envelope before projecting fields', () => {
  const message = `config warning ${'x'.repeat(600_000)} api_key=${`sk-${'a'.repeat(40)}`}`;
  const stdout = JSON.stringify({ valid: true, warnings: [{ message }], issues: [] });
  assert.ok(Buffer.byteLength(stdout) > 500_000);
  assert.ok(Buffer.byteLength(stdout) < 2_000_000);

  const result = collectNativeConfigValidation('/usr/local/bin/openclaw', () => successfulSpawn(stdout));

  assert.equal(result.available, true);
  assert.equal(result.valid, true);
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0].length <= 2_000);
  assert.doesNotMatch(result.warnings[0], /sk-testsecret/);
});

test('native Doctor parses the complete adapter-bounded JSON envelope before projecting fields', () => {
  const message = `doctor warning ${'y'.repeat(300_000)} token=${`ghp_${'b'.repeat(36)}`}`;
  const stdout = JSON.stringify({
    ok: false,
    checksRun: 1,
    checksSkipped: 0,
    findings: [{ checkId: 'large/finding', severity: 'warning', message }],
  });
  assert.ok(Buffer.byteLength(stdout) > 250_000);
  assert.ok(Buffer.byteLength(stdout) < 1_000_000);

  const result = collectNativeDoctor('/usr/local/bin/openclaw', () => successfulSpawn(stdout));

  assert.equal(result.available, true);
  assert.equal(result.findings.length, 1);
  assert.ok(result.findings[0].message.length <= 2_000);
  assert.doesNotMatch(result.findings[0].message, /ghp_testsecret/);
});

test('native collectors reject partial JSON from timed-out subprocesses', () => {
  const timedOut = {
    status: null,
    signal: 'SIGTERM',
    stdout: JSON.stringify({
      valid: true,
      ok: false,
      checksRun: 1,
      checksSkipped: 0,
      findings: [{ checkId: 'core/doctor/gateway-config', severity: 'error', message: 'timeout' }],
    }),
    stderr: '',
    error: { code: 'ETIMEDOUT', message: 'timed out' },
  };
  const config = collectNativeConfigValidation('/usr/local/bin/openclaw', () => timedOut);
  const doctor = collectNativeDoctor('/usr/local/bin/openclaw', () => timedOut);
  assert.equal(config.available, false);
  assert.equal(config.valid, null);
  assert.equal(doctor.available, false);
  assert.equal(doctor.timedOut, true);
  assert.equal(doctor.state, 'timed out');
  assert.equal(doctor.error, 'OpenClaw Doctor timed out');
  assert.deepEqual(doctor.findings, []);
});

test('a completed doctor lint finding is kept and a timeout with the same text is not', () => {
  const envelope = {
    ok: false,
    checksRun: 1,
    checksSkipped: 0,
    findings: [{
      checkId: 'core/doctor/gateway-config',
      severity: 'warning',
      message: 'gateway.mode is unset',
      path: 'gateway.mode',
      fixHint: 'Set gateway.mode local',
    }],
  };
  const completed = collectNativeDoctor('/usr/local/bin/openclaw', () => ({
    status: 1,
    signal: null,
    stdout: JSON.stringify(envelope),
    stderr: '',
  }));
  assert.equal(completed.available, true);
  assert.equal(completed.timedOut, false);
  assert.equal(completed.findings[0].message, 'gateway.mode is unset');
  assert.equal(completed.findings[0].checkId, 'core/doctor/gateway-config');

  const killed = collectNativeDoctor('/usr/local/bin/openclaw', () => ({
    status: null,
    signal: 'SIGTERM',
    stdout: JSON.stringify(envelope),
    stderr: 'timeout',
    error: { code: 'ETIMEDOUT', message: 'timeout' },
  }));
  assert.equal(killed.state, 'timed out');
  assert.deepEqual(killed.findings, []);
  assert.equal(JSON.stringify(killed).includes('gateway.mode is unset'), false);
});

test('native collectors reject valid JSON with the wrong top-level contract', () => {
  const wrongShape = () => successfulSpawn('{}');
  const doctor = collectNativeDoctor('/usr/local/bin/openclaw', wrongShape);
  const config = collectNativeConfigValidation('/usr/local/bin/openclaw', wrongShape);
  const status = collectNativeStatus('/usr/local/bin/openclaw', wrongShape);
  const security = collectNativeSecurityAudit('/usr/local/bin/openclaw', wrongShape);

  assert.equal(doctor.available, false);
  assert.equal(config.available, false);
  assert.equal(config.valid, null);
  assert.equal(status.available, false);
  assert.equal(security.available, false);
});

test('native status and security reject plausible but incomplete sibling envelopes', () => {
  const incompleteStatus = collectNativeStatus('/usr/local/bin/openclaw', () => successfulSpawn(JSON.stringify({ gateway: {} })));
  const incompleteSecurity = collectNativeSecurityAudit('/usr/local/bin/openclaw', () => successfulSpawn(JSON.stringify({ summary: {}, findings: [] })));
  const siblingStatus = collectNativeStatus('/usr/local/bin/openclaw', () => successfulSpawn(JSON.stringify({ summary: { critical: 0, warn: 0, info: 0 }, findings: [] })));
  const siblingSecurity = collectNativeSecurityAudit('/usr/local/bin/openclaw', () => successfulSpawn(JSON.stringify({ runtimeVersion: '2026.6.11', gateway: { reachable: true } })));

  for (const result of [incompleteStatus, incompleteSecurity, siblingStatus, siblingSecurity]) {
    assert.equal(result.available, false);
  }
});

test('native collectors reject runtime exit code 2 even with plausible JSON', () => {
  const failed = stdout => () => ({
    status: 2,
    signal: null,
    stdout: JSON.stringify(stdout),
    stderr: 'runtime failure',
  });
  assert.equal(collectNativeDoctor('/usr/local/bin/openclaw', failed({ ok: false, checksRun: 1, checksSkipped: 0, findings: [] })).available, false);
  assert.equal(collectNativeConfigValidation('/usr/local/bin/openclaw', failed({ valid: false, issues: [] })).available, false);
  assert.equal(collectNativeStatus('/usr/local/bin/openclaw', failed({ runtimeVersion: '2026.6.11' })).available, false);
  assert.equal(collectNativeSecurityAudit('/usr/local/bin/openclaw', failed({ summary: {}, findings: [] })).available, false);
});

test('listening-port collection returns schema evidence for invalid configured ports', () => {
  for (const port of ['18789', 'not-a-port', 0, 65536, null]) {
    let spawned = false;
    const result = collectListeningPort(port, () => {
      spawned = true;
      return successfulSpawn();
    });

    assert.equal(spawned, false);
    assert.equal(result.available, false);
    assert.equal(result.listening, false);
    assert.equal(result.valid, false);
    assert.equal(result.finding.checkId, 'config/gateway-port-invalid');
    assert.equal(result.finding.path, 'gateway.port');
  }
});

test('ShellCheck invocation failures fail repair validation closed', () => {
  const failures = [
    { status: null, signal: null, stdout: '', stderr: '', error: { code: 'ETIMEDOUT', message: 'timed out' } },
    { status: null, signal: 'SIGKILL', stdout: '', stderr: '' },
    { status: 0, signal: null, stdout: 'not json', stderr: '' },
    { status: 0, signal: null, stdout: '{}', stderr: '' },
    { status: 2, signal: null, stdout: '[]', stderr: 'internal error' },
  ];

  for (const shellcheckResult of failures) {
    const result = validateRepairScript('echo ok', {
      spawn(command) {
        return command === 'bash' ? successfulSpawn() : shellcheckResult;
      },
    });
    assert.equal(result.ok, false, JSON.stringify(shellcheckResult));
    assert.equal(result.shellcheck.available, false, JSON.stringify(shellcheckResult));
    assert.equal(result.blockers.some(blocker => blocker.source === 'shellcheck'), true);
  }
});

test('missing ShellCheck remains an optional runtime dependency', () => {
  const result = validateRepairScript('echo ok', {
    spawn(command) {
      return command === 'bash'
        ? successfulSpawn()
        : { status: null, signal: null, stdout: '', stderr: '', error: { code: 'ENOENT' } };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.shellcheck.available, false);
  assert.equal(result.blockers.length, 0);
});

test('port conflict requires evidence that the listener is a competing owner', () => {
  const sameOwner = detectIssues({
    openclaw: { processExists: true, portListening: true, gatewayPid: '4242', gatewayStatus: 'running pid 4242' },
    ports: { gateway: { listening: true, process: 'node', pid: 4242 } },
    nativeStatus: { gateway: { reachable: false, authWarning: 'unauthorized' } },
    logs: { errors: 'EADDRINUSE from an old log entry' },
  });
  assert.equal(sameOwner.some(issue => issue.id === 'port-conflict'), false);
  assert.equal(sameOwner.some(issue => issue.id === 'gateway-not-running'), false);

  const competingOwner = detectIssues({
    openclaw: { processExists: true, portListening: true, gatewayPid: '9001', gatewayStatus: 'failed to start' },
    ports: { gateway: { listening: true, process: 'python', pid: 4242 } },
    nativeStatus: { gateway: { reachable: false } },
  });
  assert.equal(competingOwner.some(issue => issue.id === 'port-conflict'), true);
  assert.equal(competingOwner.some(issue => issue.id === 'gateway-not-running'), false);
});

test('a connectivity check decides gateway liveness ahead of a diagnostic-only stopped line', () => {
  const up = detectIssues({
    openclaw: {
      processExists: true,
      portListening: true,
      gatewayPid: '4242',
      gatewayStatus: [
        'Runtime: stopped (diagnostic only, not the check target)',
        'Connectivity check: ok',
        'Listening: 127.0.0.1:18789',
      ].join('\n'),
    },
    ports: { gateway: { listening: true, process: 'openclaw', pid: 4242 } },
  });
  assert.equal(up.some(issue => issue.id === 'gateway-not-running'), false);

  const down = detectIssues({
    openclaw: {
      processExists: false,
      portListening: false,
      gatewayStatus: [
        'Runtime: stopped (diagnostic only, not the check target)',
        'Connectivity check: failed',
      ].join('\n'),
    },
    ports: { gateway: { listening: false, process: null, pid: null } },
  });
  assert.equal(down.some(issue => issue.id === 'gateway-not-running'), true);
});

test('an unowned or invalid listener does not hide gateway-not-running', () => {
  for (const gateway of [
    { listening: true, process: null, pid: null },
    { valid: false, listening: false, pid: null },
  ]) {
    const issues = detectIssues({
      openclaw: { processExists: false, portListening: gateway.listening, gatewayStatus: 'not running' },
      ports: { gateway },
      nativeStatus: { gateway: { reachable: false } },
    });
    assert.equal(issues.some(issue => issue.id === 'port-conflict'), false);
    assert.equal(issues.some(issue => issue.id === 'gateway-not-running'), true);
  }
});

test('the hosted script uses the connectivity check instead of a diagnostic-only stopped line', () => {
  const start = DIAGNOSTIC_SCRIPT.indexOf('GATEWAY_PROBE=');
  const end = DIAGNOSTIC_SCRIPT.indexOf('if echo "$GATEWAY_LOG"');
  assert.ok(start > 0 && end > start);
  const snippet = DIAGNOSTIC_SCRIPT.slice(start, end);
  const run = (status) => {
    const printed = spawnSync('bash', ['-c', `${snippet}\nprintf '%s' "$ISSUES"`], {
      env: { ...process.env, GATEWAY_STATUS: status, ISSUES: '0', ISSUE_LIST: '' },
      encoding: 'utf8',
    });
    assert.equal(printed.status, 0, printed.stderr);
    return printed.stdout;
  };
  const up = [
    'Runtime: stopped (diagnostic only, not the check target)',
    'Connectivity check: ok',
    'Listening: 127.0.0.1:18789',
  ].join('\n');
  const down = [
    'Runtime: stopped (diagnostic only, not the check target)',
    'Connectivity check: failed',
  ].join('\n');
  assert.equal(run(up), '0');
  assert.equal(run(down), '1');
  assert.equal(run('runtime: ok\nrunning, pid 4242'), '0');
  assert.equal(run('not running'), '1');
});

test('local issue matching is exact or explicit and preserves local classification', () => {
  const [matched] = matchLocalKnownIssues([{
    text: 'PI-backed openai-codex route active instead of native Codex harness',
    severity: 'medium',
    kind: 'warning',
  }]);
  assert.equal(matched.id, 'pi-backed-openai-codex-route');
  assert.equal(matched.severity, 'medium');
  assert.equal(matched.kind, 'warning');
  assert.match(matched.fix, /native Codex harness/);

  const [explicit] = matchLocalKnownIssues([{
    knownIssueId: 'native-codex-timeout-boundary',
    text: 'runtime-specific detail',
    severity: 'critical',
    kind: 'failure',
  }]);
  assert.equal(explicit.id, 'native-codex-timeout-boundary');
  assert.equal(explicit.severity, 'critical');
});

test('unknown Codex text does not acquire an unrelated migration repair', () => {
  const matched = matchLocalKnownIssues([{
    text: 'Codex emitted an unfamiliar response while listing models',
    severity: 'medium',
    kind: 'warning',
  }]);
  assert.deepEqual(matched, []);
});

test('server startup consumes runtime bind errors from the server error event', async () => {
  let initialized = false;
  const server = new EventEmitter();
  server.close = () => {};
  const bindError = Object.assign(new Error('address already in use'), { code: 'EADDRINUSE' });
  const startServer = createServerStarter({
    defaultPort: 3001,
    defaultListen: (_port, callback) => {
      queueMicrotask(() => server.emit('error', bindError));
      server.listeningCallback = callback;
      return server;
    },
    defaultInitialize: async () => {
      initialized = true;
    },
    onListening: () => {},
  });

  await assert.rejects(startServer(), error => error === bindError);
  assert.equal(initialized, false);
});

function doctorSnippet() {
  const start = DIAGNOSTIC_SCRIPT.indexOf('DOCTOR_JSON=null');
  const end = DIAGNOSTIC_SCRIPT.indexOf('# --- Build Diagnostic Payload ---');
  assert.ok(start > 0 && end > start);
  return DIAGNOSTIC_SCRIPT.slice(start, end);
}

test('the hosted doctor collector matches the CLI lint budget and keeps a real finding', async (t) => {
  const snippet = doctorSnippet();
  assert.match(snippet, /const DOCTOR_TIMEOUT_MS = 120000;/);
  assert.match(snippet, /timeout: DOCTOR_TIMEOUT_MS/);
  assert.match(snippet, /'doctor',\n {2}'--lint',\n {2}'--json'/);
  assert.match(snippet, /core\/doctor\/skills-readiness/);
  assert.match(snippet, /state: 'timed out'/);
  assert.equal(snippet.includes('cli/core/'), false);

  const home = await mkdtemp(join(tmpdir(), 'clawfix-doctor-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, 'openclaw');
  const token = `ghp_${'c'.repeat(36)}`;
  await writeFile(bin, `#!/bin/sh
printf '%s\\n' '{"ok":false,"checksRun":1,"checksSkipped":0,"findings":[{"checkId":"core/doctor/gateway-config","severity":"warning","message":"gateway.mode is unset token=${token}","path":"'"$HOME"'/secret","fixHint":"set it"}]}'
`);
  await chmod(bin, 0o755);
  const printed = spawnSync('bash', ['-c', `${snippet}\nprintf '%s' "$DOCTOR_JSON"`], {
    env: { ...process.env, HOME: home, OPENCLAW_BIN: bin },
    encoding: 'utf8',
  });
  assert.equal(printed.status, 0, printed.stderr);
  const doctor = JSON.parse(printed.stdout);
  assert.equal(doctor.available, true);
  assert.equal(doctor.timedOut, false);
  assert.equal(doctor.findings.length, 1);
  assert.equal(doctor.findings[0].checkId, 'core/doctor/gateway-config');
  assert.match(doctor.findings[0].message, /gateway\.mode is unset/);
  assert.equal(printed.stdout.includes(token), false);
  assert.equal(printed.stdout.includes(home), false);
  assert.match(doctor.findings[0].path, /^~\/secret$/);
});

test('the hosted doctor collector reports a timeout instead of a partial finding', async (t) => {
  const snippet = doctorSnippet().replace(
    'const DOCTOR_TIMEOUT_MS = 120000;',
    'const DOCTOR_TIMEOUT_MS = 200;',
  );
  assert.match(doctorSnippet(), /const DOCTOR_TIMEOUT_MS = 120000;/);
  const home = await mkdtemp(join(tmpdir(), 'clawfix-doctor-timeout-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, 'openclaw');
  await writeFile(bin, `#!/bin/sh
printf '%s\\n' '{"ok":false,"checksRun":1,"checksSkipped":0,"findings":[{"checkId":"core/doctor/gateway-config","severity":"error","message":"timeout"}]}'
sleep 30
`);
  await chmod(bin, 0o755);
  const printed = spawnSync('bash', ['-c', `${snippet}\nprintf '%s' "$DOCTOR_JSON"`], {
    env: { ...process.env, HOME: home, OPENCLAW_BIN: bin },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(printed.status, 0, printed.stderr);
  const doctor = JSON.parse(printed.stdout);
  assert.deepEqual(doctor, {
    available: false,
    timedOut: true,
    state: 'timed out',
    checksRun: 0,
    checksSkipped: 0,
    findings: [],
  });
  assert.equal(printed.stdout.includes('gateway-config'), false);
});
