import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assessLockHolder,
  classifyStateLockDeadlock,
  describeStateLockDeadlock,
  retainDiagnosticLogLine,
} from '../cli/bin/security.js';
import { deriveIssues } from '../cli/core/diagnostics.js';
import { normalizeFindings } from '../cli/core/findings.js';
import { repairCatalog } from '../cli/core/repair-catalog.js';
import { detectIssues } from '../src/known-issues.js';
import { DIAGNOSTIC_SCRIPT } from '../src/routes/script.js';

async function fixture(name) {
  return readFile(new URL(`./fixtures/openclaw-state-lock/${name}`, import.meta.url), 'utf8');
}

function findingFor(text, extra = {}) {
  return detectIssues({
    openclaw: extra.openclaw || {},
    nativeDoctor: extra.nativeDoctor,
    logs: { errors: text },
    config: {},
  }).find(issue => issue.id === 'state-lock-deadlock');
}

function collected(text, lockHolders) {
  return {
    config: {},
    system: { runtimeCompatible: true, runtimeRequired: null, runtimeCurrent: null },
    gateway: { gatewayStatus: 'not running', gatewayPort: 18789, gatewayPid: '' },
    logs: { errorLogs: text, stderrLogs: '', gatewayLogTail: '', errLogSizeMB: 0 },
    serviceHealth: { runs: 0, uptimeSeconds: 0, uptimeStr: '', nRestarts: 0 },
    workspace: { workspaceDir: '/w', hasSoul: true, memoryFiles: 1 },
    ports: { gateway: { listening: false, pid: null } },
    nativeDoctor: { available: true, findings: [], ...lockHolders?.nativeDoctor },
    nativeConfig: { available: true, valid: true, errors: [] },
    nativeStatus: { available: true, gateway: { reachable: false } },
    nativeSecurity: { available: true, findings: [] },
    ...(lockHolders?.holders ? { lockHolders: lockHolders.holders } : {}),
  };
}

test('state ownership, lifecycle, GatewayLockError, and a lease abort are detected', async () => {
  const directory = findingFor(await fixture('owns-state-directory.txt'));
  assert.ok(directory);
  assert.equal(directory.severity, 'critical');
  assert.match(directory.description, /owns this state directory/);
  assert.match(directory.description, /detect-only|proven dead/);
  assert.match(directory.fix, /gateway recover-lock/);
  assert.match(directory.fix, /does not delete the state directory or SQLite files/);
  assert.match(directory.fix, /Do not kill a process/);
  assert.doesNotMatch(directory.fix, /kill -9|rm -rf|unlink /i);

  const lifecycle = findingFor(await fixture('state-lifecycle.txt'));
  assert.match(lifecycle.description, /state-lifecycle/);

  const lock = findingFor(await fixture('gateway-lock-error.txt'));
  assert.equal(retainDiagnosticLogLine('GatewayLockError: cannot verify Gateway ownership'), true);
  assert.match(lock.description, /pid 42856/);
  assert.match(lock.description, /not proven/);
  assert.match(lock.description, /age \d+h/);

  const lease = findingFor('', {
    nativeDoctor: {
      available: true,
      warnings: [{
        checkId: 'core/doctor/database-engine',
        severity: 'info',
        errorCode: 'OPENCLAW_STATE_LEASE_ABORTED',
        message: 'state lease aborted before the check ran',
      }],
    },
  });
  assert.equal(lease.severity, 'medium');
  assert.match(lease.description, /OPENCLAW_STATE_LEASE_ABORTED/);
  assert.match(DIAGNOSTIC_SCRIPT, /OPENCLAW_STATE_LEASE_ABORTED/);
  assert.match(DIAGNOSTIC_SCRIPT, /warnings/);
});

test('an unrelated lock message is not a state-lock deadlock', async () => {
  assert.equal(findingFor(await fixture('unrelated-lock.txt')), undefined);
  assert.equal(classifyStateLockDeadlock({ text: 'file lock acquired for the npm cache' }), null);
});

test('a live holder is described and is not repairable', async () => {
  const text = await fixture('live-owner.txt');
  const detail = classifyStateLockDeadlock({
    text,
    holders: [{ pid: 43152, status: 'alive', command: 'openclaw gateway run', ageSeconds: 8 * 3600 }],
  });
  assert.equal(detail.repairable, false);
  const described = describeStateLockDeadlock(detail);
  assert.match(described, /pid 43152/);
  assert.match(described, /openclaw gateway run/);
  assert.match(described, /is alive/);
  assert.match(described, /not repairable/);
  assert.match(described, /Do not kill it/);
  const local = deriveIssues(collected(text, {
    holders: [{ pid: 43152, status: 'alive', command: 'openclaw gateway run', ageSeconds: 8 * 3600 }],
  })).find(issue => issue.knownIssueId === 'state-lock-deadlock');
  assert.equal(local.repairable, false);
  const finding = normalizeFindings({
    localIssues: [local],
    knownRepairIds: Object.keys(repairCatalog),
  })[0];
  assert.equal(finding.repairable, false);
  assert.equal(finding.repairId, undefined);
});

test('a missing pid is dead and a reused pid is not OpenClaw', () => {
  assert.equal(assessLockHolder({ pid: 42856, signalCode: 'ESRCH' }).status, 'dead');
  assert.equal(assessLockHolder({ pid: 42856, signalCode: 'ESRCH' }).provenDead, true);
  const reused = assessLockHolder({ pid: 100, signalCode: 'OK', command: '/usr/bin/python3 -m http.server' });
  assert.equal(reused.status, 'reused');
  assert.equal(reused.provenDead, true);
  const alive = assessLockHolder({ pid: 50, signalCode: 'OK', command: 'openclaw gateway run' });
  assert.equal(alive.status, 'alive');
  assert.equal(alive.provenDead, false);
  assert.equal(assessLockHolder({ pid: 50, signalCode: 'EPERM', command: null }).provenDead, false);
  assert.equal(assessLockHolder({ pid: 50, signalCode: 'OK', command: '' }).status, 'unknown');
});

test('a proven-dead holder can be recovered only through gateway recover-lock', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clawfix-state-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockDir = join(root, 'tmp', 'openclaw-1000');
  await mkdir(lockDir, { recursive: true });
  const lockPath = join(lockDir, 'state.abc123.lock');
  const sqlitePath = join(root, 'state', 'openclaw.sqlite');
  await mkdir(join(root, 'state'), { recursive: true });
  await writeFile(lockPath, `${JSON.stringify({ pid: 42856, role: 'gateway' })}\n`);
  await writeFile(sqlitePath, 'not-a-database');
  const calls = [];
  const ctx = {
    stateDir: root,
    probeLockPid(pid) {
      assert.equal(pid, 42856);
      return { signalCode: 'ESRCH', command: null };
    },
    openclaw: {
      async invoke(argv) {
        calls.push(argv);
        if (argv.includes('--confirm')) {
          await rm(lockPath, { force: true });
          return { status: 0, stdout: JSON.stringify({ recovered: true }), stderr: '' };
        }
        return {
          status: 0,
          stdout: JSON.stringify({
            present: true,
            confirmation: 'a'.repeat(64),
            holders: ['state lock'],
          }),
          stderr: '',
        };
      },
    },
  };
  const entry = repairCatalog['state-lock-deadlock'];
  assert.equal((await entry.preflight(ctx)).ok, true);
  const preview = await entry.preview(ctx);
  assert.match(preview.steps.join(' '), /recover-lock/);
  assert.doesNotMatch(preview.steps.join(' '), /kill|sqlite/i);
  const applied = await entry.apply(ctx);
  assert.equal(applied.status, 0);
  assert.deepEqual(calls[0], ['gateway', 'recover-lock', '--json']);
  assert.deepEqual(calls[1], ['gateway', 'recover-lock', '--confirm', 'a'.repeat(64), '--json']);
  assert.equal(await readFile(sqlitePath, 'utf8'), 'not-a-database');
  const backup = await readFile(`${lockPath}.clawfix-bak`, 'utf8');
  assert.match(backup, /42856/);
  const verified = await entry.verify({
    ...ctx,
    openclaw: {
      async invoke() {
        return { status: 0, stdout: JSON.stringify({ present: false }), stderr: '' };
      },
    },
  });
  assert.equal(verified.ok, true);

  const live = {
    ...ctx,
    probeLockPid() {
      return { signalCode: 'OK', command: 'openclaw gateway run' };
    },
  };
  await writeFile(lockPath, `${JSON.stringify({ pid: 42856, role: 'gateway' })}\n`);
  const refused = await entry.preflight(live);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'live_holder');
  const blocked = await entry.apply(live);
  assert.notEqual(blocked.status, 0);
  assert.equal(calls.length, 2);
});

test('confirmation failure restores the lock file and does not touch SQLite', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clawfix-state-lock-rollback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockDir = join(root, 'tmp', 'openclaw-1000');
  await mkdir(lockDir, { recursive: true });
  const lockPath = join(lockDir, 'gateway.state.lock');
  const original = `${JSON.stringify({ pid: 100, role: 'gateway' })}\n`;
  await writeFile(lockPath, original);
  const ctx = {
    stateDir: root,
    probeLockPid() {
      return { signalCode: 'OK', command: '/usr/bin/python3 -m http.server' };
    },
    openclaw: {
      async invoke(argv) {
        if (argv.includes('--confirm')) return { status: 1, stdout: '', stderr: 'refused' };
        return { status: 0, stdout: JSON.stringify({ present: true, confirmation: 'b'.repeat(64) }), stderr: '' };
      },
    },
  };
  const entry = repairCatalog['state-lock-deadlock'];
  const applied = await entry.apply(ctx);
  assert.equal(applied.status, 1);
  await writeFile(lockPath, 'replaced-by-recovery');
  const rollback = await entry.rollback(ctx, { applyResult: applied });
  assert.equal(rollback.rolledBack, true);
  assert.equal(await readFile(lockPath, 'utf8'), original);
});
