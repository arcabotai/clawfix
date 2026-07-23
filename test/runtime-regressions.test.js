import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  collectListeningPort,
  collectNativeConfigValidation,
  collectNativeDoctor,
  collectNativeSecurityAudit,
  collectNativeStatus,
} from '../cli/bin/native-diagnostics.js';
import { detectIssues, matchLocalKnownIssues } from '../src/known-issues.js';
import { validateRepairScript } from '../src/repair-validator.js';
import { createServerStarter } from '../src/server-start.js';

const successfulSpawn = (stdout = '') => ({ status: 0, signal: null, stdout, stderr: '' });

test('native doctor runs the broad lint set and skips only workspace-heavy readiness checks', () => {
  let args;
  const result = collectNativeDoctor('/usr/local/bin/openclaw', (_command, received) => {
    args = received;
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
  assert.equal(result.available, true);
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
    stdout: JSON.stringify({ valid: true, ok: true, findings: [] }),
    stderr: '',
    error: { code: 'ETIMEDOUT', message: 'timed out' },
  };
  const config = collectNativeConfigValidation('/usr/local/bin/openclaw', () => timedOut);
  const doctor = collectNativeDoctor('/usr/local/bin/openclaw', () => timedOut);
  assert.equal(config.available, false);
  assert.equal(config.valid, null);
  assert.equal(doctor.available, false);
  assert.equal(doctor.findings.length, 0);
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
