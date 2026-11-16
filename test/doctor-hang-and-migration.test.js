import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createProcessAdapter } from '../cli/adapters/process.js';
import {
  DOCTOR_INVOCATION_TIMEOUT_MS,
  DOCTOR_KILL_GRACE_MS,
  DOCTOR_KILL_SIGNALS,
  STALE_DOCTOR_ELAPSED_SECONDS,
  classifyPostUpgradeMigration,
  classifyStalledDoctor,
  describePostUpgradeMigration,
  describeStalledDoctor,
  projectDoctorProcesses,
  retainDiagnosticLogLine,
} from '../cli/bin/security.js';
import { DOCTOR_LINT_TIMEOUT_MS } from '../cli/bin/native-diagnostics.js';
import { deriveIssues } from '../cli/core/diagnostics.js';
import { repairCatalog } from '../cli/core/repair-catalog.js';
import { detectIssues } from '../src/known-issues.js';
import { DIAGNOSTIC_SCRIPT } from '../src/routes/script.js';

async function fixture(name) {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

function hostedDiagnostic(text, openclaw = {}) {
  return {
    openclaw: {
      gatewayStatus: 'Connectivity check: ok\nListening: 127.0.0.1:18789',
      portListening: true,
      processExists: true,
      ...openclaw,
    },
    logs: { errors: text, stderr: '', gatewayLog: '' },
  };
}

function collected(text, extra = {}) {
  return {
    config: {},
    system: { runtimeCompatible: true },
    gateway: {
      gatewayStatus: 'Connectivity check: ok\nListening: 127.0.0.1:18789',
      gatewayPort: 18789,
      gatewayPid: '4242',
      ...extra.gateway,
    },
    logs: { errorLogs: text, stderrLogs: '', gatewayLogTail: '', errLogSizeMB: 0 },
    serviceHealth: { runs: 0, uptimeSeconds: 0, uptimeStr: '', nRestarts: 0 },
    workspace: { workspaceDir: '', hasSoul: true, memoryFiles: 1 },
    ports: { gateway: { listening: true, pid: 4242 } },
    nativeDoctor: { available: false, findings: [] },
    nativeConfig: { available: false, valid: null, warnings: [], errors: [] },
    nativeStatus: { available: false },
    nativeSecurity: { available: false, findings: [] },
  };
}

test('migration crash-loop shapes come from the reported startup lines and a restart does not clear them', async () => {
  const cases = [
    ['openclaw-migration-crash-loop/workspace-setup.txt', 'workspace-setup'],
    ['openclaw-migration-crash-loop/session-index.txt', 'session-index'],
    ['openclaw-migration-crash-loop/legacy-sessions.txt', 'legacy-sessions'],
  ];
  for (const [name, shape] of cases) {
    const text = await fixture(name);
    const match = classifyPostUpgradeMigration(text);
    assert.equal(match.restartWillNotFix, true, name);
    assert.ok(match.shapes.includes(shape), name);
    const description = describePostUpgradeMigration(match);
    assert.match(description, /gateway restart will not migrate/i);
    assert.match(description, /unbounded doctor --fix/i);

    const hosted = detectIssues(hostedDiagnostic(text));
    const issue = hosted.find(item => item.id === 'post-upgrade-migration-crash-loop');
    assert.ok(issue, name);
    assert.equal(issue.severity, 'critical');
    assert.match(issue.description, /gateway restart will not migrate/i);
    assert.equal(hosted.some(item => item.id === 'state-dir-migration'), false);

    const local = deriveIssues(collected(text)).find(item => item.knownIssueId === 'post-upgrade-migration-crash-loop');
    assert.ok(local, name);
    assert.equal(local.text, 'Post-upgrade migration is crash-looping');
  }
});

test('the old state-dir skip and a sessions.json mention without the startup gate do not match', async () => {
  const skipped = await fixture('openclaw-migration-crash-loop/harmless-skip.txt');
  assert.equal(classifyPostUpgradeMigration(skipped), null);
  assert.equal(classifyStalledDoctor({ text: skipped, gatewayDown: true }), null);
  const hosted = detectIssues(hostedDiagnostic(skipped, {
    gatewayStatus: 'State dir migration skipped: target already exists',
  }));
  assert.equal(hosted.some(item => item.id === 'post-upgrade-migration-crash-loop'), false);
  assert.ok(hosted.some(item => item.id === 'state-dir-migration'));
  assert.equal(classifyPostUpgradeMigration('Legacy session store requires migration'), null);
  assert.equal(classifyPostUpgradeMigration('agents/main/sessions/sessions.json'), null);
  assert.equal(retainDiagnosticLogLine('listening on pid 4'), false);
  assert.equal(retainDiagnosticLogLine('missing or drifted index idx_agent_session_nodes_active'), true);
});

test('stalled doctor matches the census, snapshot loop, and content-version respawn pastes', async () => {
  const census = await fixture('openclaw-doctor-stall/census-stall.txt');
  const censusMatch = classifyStalledDoctor({ text: census, gatewayDown: false });
  assert.ok(censusMatch.shapes.includes('census-stall'));
  assert.equal(censusMatch.gatewayLeftStopped, false);
  assert.match(describeStalledDoctor(censusMatch), /79 minutes/);
  assert.match(describeStalledDoctor(censusMatch), /Do not run doctor --fix again/);

  const down = classifyStalledDoctor({
    text: 'Stopped the managed Gateway for Doctor repair.\nOpenClaw state at ~/.openclaw/state/openclaw.sqlite is undergoing offline maintenance; retry when it finishes.',
    gatewayDown: true,
  });
  assert.ok(down.shapes.includes('gateway-left-stopped'));
  assert.equal(down.gatewayLeftStopped, true);
  assert.match(describeStalledDoctor(down), /SIGKILL/);

  const snapshots = await fixture('openclaw-doctor-stall/snapshot-loop.txt');
  const loop = classifyStalledDoctor({ text: snapshots, gatewayDown: false });
  assert.deepEqual(loop.shapes, ['snapshot-loop']);
  assert.match(describeStalledDoctor(loop), /SIGTERM/);
  assert.equal(classifyStalledDoctor({
    text: snapshots.split('\n')[0],
    gatewayDown: true,
  }), null);

  const workers = await fixture('openclaw-doctor-stall/content-version-respawn.txt');
  const respawn = classifyStalledDoctor({ text: workers, gatewayDown: true });
  assert.ok(respawn.shapes.includes('content-version-respawn'));
  assert.ok(respawn.shapes.includes('sigterm-cleanup-failed'));
  assert.equal(respawn.gatewayLeftStopped, true);

  for (const [name, text] of [['census', census], ['snapshots', snapshots], ['workers', workers]]) {
    assert.ok(detectIssues(hostedDiagnostic(text)).some(item => item.id === 'doctor-fix-stalled'), name);
    assert.ok(deriveIssues(collected(text)).some(item => item.knownIssueId === 'doctor-fix-stalled'), name);
  }
});

test('a doctor run that restarts the gateway is not a stall, and a short doctor process is not stale', async () => {
  const completed = await fixture('openclaw-doctor-stall/completed-doctor.txt');
  assert.equal(classifyStalledDoctor({ text: completed, gatewayDown: false }), null);
  assert.equal(classifyStalledDoctor({ text: completed, gatewayDown: true }), null);
  assert.equal(detectIssues(hostedDiagnostic(completed)).some(item => item.id === 'doctor-fix-stalled'), false);
  assert.equal(deriveIssues(collected(completed)).some(item => item.knownIssueId === 'doctor-fix-stalled'), false);

  assert.equal(classifyStalledDoctor({
    doctorProcesses: [{ elapsedSeconds: STALE_DOCTOR_ELAPSED_SECONDS - 1, fix: true }],
    gatewayDown: true,
  }), null);
  const stale = classifyStalledDoctor({
    doctorProcesses: [{ elapsedSeconds: STALE_DOCTOR_ELAPSED_SECONDS, fix: true }],
    gatewayDown: true,
  });
  assert.ok(stale.shapes.includes('stale-process'));
  assert.equal(stale.gatewayLeftStopped, true);
  const hosted = detectIssues(hostedDiagnostic('', {
    gatewayStatus: 'Connectivity check: failed',
    portListening: false,
    processExists: false,
    doctorProcesses: [{ elapsedSeconds: 79 * 60, fix: true, command: 'drop-me' }],
  }));
  const issue = hosted.find(item => item.id === 'doctor-fix-stalled');
  assert.ok(issue);
  assert.equal(JSON.stringify(issue).includes('drop-me'), false);
});

test('doctor process projection keeps elapsed time and drops command text', () => {
  const listing = [
    '11 20 openclaw gateway run',
    '22 4740 openclaw doctor --fix',
    '33 10 node clawfix doctor --lint',
    `44 30 openclaw doctor --lint ${process.env.HOME || '/tmp'}/.openclaw`,
  ].join('\n');
  assert.deepEqual(projectDoctorProcesses(listing, { selfPid: '33' }), [
    { elapsedSeconds: 4740, fix: true },
    { elapsedSeconds: 30, fix: false },
  ]);
  assert.equal(JSON.stringify(projectDoctorProcesses(listing)).includes('.openclaw'), false);
});

test('migration and stalled doctor stay out of the repair catalog', () => {
  assert.equal(repairCatalog['post-upgrade-migration-crash-loop'], undefined);
  assert.equal(repairCatalog['doctor-fix-stalled'], undefined);
  assert.equal(DOCTOR_LINT_TIMEOUT_MS, DOCTOR_INVOCATION_TIMEOUT_MS);
  assert.equal(DOCTOR_LINT_TIMEOUT_MS, 120_000);
  assert.equal(DOCTOR_KILL_GRACE_MS, 5_000);
  assert.deepEqual(DOCTOR_KILL_SIGNALS, ['SIGTERM', 'SIGKILL']);
});

test('token generation doctor is time-boxed, escalates signals, and restarts a gateway it stopped', async () => {
  const entry = repairCatalog['gateway-loopback-no-auth'];
  const calls = [];
  let listening = true;
  const ctx = {
    gatewayPort: 18789,
    openclaw: {
      async configGet(key) {
        return { ok: true, value: key === 'gateway.auth.mode' ? 'none' : '', status: 0 };
      },
      async configHasValue() {
        return { ok: true, present: false, status: 0 };
      },
      async configSet(key, value) {
        calls.push(['set', key, value]);
        return { status: 0 };
      },
      async gatewayListening() {
        calls.push(['listen', listening]);
        return listening;
      },
      async invoke(argv, options) {
        calls.push(['invoke', argv.join(' '), options?.timeoutMs, options?.killSignals, options?.killGraceMs, options?.killProcessGroup]);
        if (argv[0] === 'doctor') {
          listening = false;
          return { status: 0, signal: null, timedOut: false };
        }
        if (argv.join(' ') === 'gateway restart') {
          listening = true;
          return { status: 0 };
        }
        return { status: 1 };
      },
    },
  };
  const applied = await entry.apply(ctx);
  assert.equal(applied.status, 0);
  assert.equal(applied.gatewayRestored, true);
  const doctor = calls.find(call => call[1] === 'doctor --fix --generate-gateway-token');
  assert.equal(doctor[2], 120_000);
  assert.deepEqual(doctor[3], ['SIGTERM', 'SIGKILL']);
  assert.equal(doctor[4], 5_000);
  assert.equal(doctor[5], true);
  assert.equal(calls.filter(call => call[1] === 'doctor --fix --generate-gateway-token').length, 1);
  assert.equal(calls.filter(call => call[1] === 'gateway restart').length, 1);
});

test('a doctor timeout sends SIGTERM and then SIGKILL when SIGTERM is ignored', async () => {
  const child = new (await import('node:events')).EventEmitter();
  child.stdout = new (await import('node:events')).EventEmitter();
  child.stderr = new (await import('node:events')).EventEmitter();
  child.stdout.destroy = () => {};
  child.stderr.destroy = () => {};
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === 'SIGKILL') child.emit('close', null, 'SIGKILL');
    return true;
  };
  const adapter = createProcessAdapter({
    spawn: () => child,
    spawnSync() {},
    killGraceMs: 15,
  });
  const keepAlive = setInterval(() => {}, 1000);
  let result;
  try {
    result = await adapter.run('openclaw', ['doctor', '--fix'], {
      timeoutMs: 20,
      killSignals: ['SIGTERM', 'SIGKILL'],
      killGraceMs: 15,
    });
  } finally {
    clearInterval(keepAlive);
  }
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL');
});

test('the hosted doctor collector is time-boxed and does not invoke doctor --fix', () => {
  const start = DIAGNOSTIC_SCRIPT.indexOf('DOCTOR_JSON=null');
  const end = DIAGNOSTIC_SCRIPT.indexOf('# --- Build Diagnostic Payload ---');
  const snippet = DIAGNOSTIC_SCRIPT.slice(start, end);
  assert.match(snippet, /const DOCTOR_TIMEOUT_MS = 120000;/);
  assert.match(snippet, /const DOCTOR_KILL_GRACE_MS = 5000;/);
  assert.match(snippet, /timeout: DOCTOR_TIMEOUT_MS/);
  assert.match(snippet, /signalChild\('SIGTERM'\)/);
  assert.match(snippet, /signalChild\('SIGKILL'\)/);
  assert.match(snippet, /detached: true/);
  assert.match(snippet, /'doctor',\n {2}'--lint',\n {2}'--json'/);
  assert.match(snippet, /\['gateway', 'restart'\]/);
  assert.doesNotMatch(snippet, /'doctor',\s*\n\s*'--fix'/);
  assert.match(snippet, /DOCTOR_PROCESSES_JSON/);
  assert.match(DIAGNOSTIC_SCRIPT, /"doctorProcesses":/);
  assert.match(DIAGNOSTIC_SCRIPT, /missing or drifted index idx_agent_session_nodes_active/);
  assert.match(DIAGNOSTIC_SCRIPT, /Legacy workspace setup state requires migration/);
  assert.match(DIAGNOSTIC_SCRIPT, /Legacy session store requires migration/);
});
