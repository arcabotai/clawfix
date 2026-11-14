import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  HEARTBEAT_SCRATCH_MAX_BYTES as coreLimit,
  classifyHeartbeatScratchFile as classifyFromCore,
  deriveIssues,
} from '../cli/core/diagnostics.js';
import {
  HEARTBEAT_SCRATCH_MAX_BYTES as securityLimit,
  classifyHeartbeatScratchFile as classifyFromSecurity,
} from '../cli/bin/security.js';
import { detectIssues } from '../src/known-issues.js';
import { DIAGNOSTIC_SCRIPT } from '../src/routes/script.js';

test('heartbeat scratch classification matches the server copy and the 262144 byte cap', () => {
  assert.equal(coreLimit, 256 * 1024);
  assert.equal(securityLimit, coreLimit);
  for (const sample of [
    { bytes: 262144, utf8: true },
    { bytes: 262145, utf8: true },
    { bytes: 15, utf8: false },
    { bytes: 15, utf8: null },
    { bytes: -1, utf8: false },
  ]) {
    assert.equal(classifyFromCore(sample), classifyFromSecurity(sample));
  }
  assert.equal(classifyFromCore({ bytes: 262144, utf8: true }), null);
  assert.equal(classifyFromCore({ bytes: 324000, utf8: true }), 'too-large');
  assert.equal(classifyFromCore({ bytes: 15, utf8: false }), 'invalid-utf8');
});

test('captured doctor lint names the scratch limit and invalid UTF-8', async () => {
  const oversized = JSON.parse(await readFile(new URL(
    './fixtures/openclaw-heartbeat-file/doctor-oversized.json',
    import.meta.url,
  ), 'utf8'));
  const utf8 = JSON.parse(await readFile(new URL(
    './fixtures/openclaw-heartbeat-file/doctor-invalid-utf8.json',
    import.meta.url,
  ), 'utf8'));
  assert.equal(oversized.findings[0].requirement, 'heartbeat-file-migration-blocked');
  assert.match(oversized.findings[0].message, /File exceeds 262144 bytes/);
  assert.match(utf8.findings[0].message, /HEARTBEAT\.md is not valid UTF-8/);
  assert.equal(oversized.findings[0].path.includes('/tmp/'), false);
});

function collected(heartbeatFile, doctorFinding) {
  return {
    config: { agents: { defaults: { workspace: '/w', contextPruning: { mode: 'cache-ttl' }, compaction: { memoryFlush: { enabled: true } } } } },
    system: { runtimeCompatible: true },
    gateway: { gatewayStatus: 'running, pid 1', gatewayPort: 18789, gatewayPid: '1' },
    logs: { errorLogs: '', stderrLogs: '', gatewayLogTail: '', errLogSizeMB: 0 },
    serviceHealth: { runs: 0, uptimeSeconds: 0, uptimeStr: '', nRestarts: 0 },
    workspace: {
      workspaceDir: '/w',
      hasSoul: true,
      memoryFiles: 1,
      heartbeatFile,
    },
    ports: { gateway: { listening: false, pid: null } },
    nativeDoctor: {
      available: true,
      findings: doctorFinding ? [doctorFinding] : [],
    },
    nativeConfig: { available: true, valid: true, errors: [] },
    nativeStatus: { available: true, gateway: { reachable: true } },
    nativeSecurity: { available: true, findings: [] },
  };
}

test('an oversized HEARTBEAT.md is advisory and replaces the doctor duplicate', () => {
  const issues = deriveIssues(collected(
    { bytes: 324000, utf8: null },
    {
      checkId: 'core/doctor/heartbeat-scratch-migration',
      severity: 'error',
      requirement: 'heartbeat-file-migration-blocked',
      message: 'Agent "main" HEARTBEAT.md cannot be migrated: File exceeds 262144 bytes: /w/HEARTBEAT.md',
      path: '/w/HEARTBEAT.md',
    },
  ));
  const matches = issues.filter(issue => issue.knownIssueId === 'heartbeat-file-blocks-scratch');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].text, 'HEARTBEAT.md exceeds the cron scratch limit');
  assert.equal(issues.some(issue => issue.nativeCheckId === 'core/doctor/heartbeat-scratch-migration'), false);
});

test('invalid UTF-8 is advisory and a file at the cap is not', () => {
  const bad = deriveIssues(collected({ bytes: 15, utf8: false }));
  assert.equal(bad.some(issue => issue.text === 'HEARTBEAT.md is not valid UTF-8'), true);
  const ok = deriveIssues(collected({ bytes: 262144, utf8: true }));
  assert.equal(ok.some(issue => issue.knownIssueId === 'heartbeat-file-blocks-scratch'), false);
});

test('the server flags the same heartbeat file facts and does not attach a repair id', () => {
  const found = detectIssues({
    workspace: { heartbeatFile: { bytes: 324000, utf8: null }, exists: true },
    config: {},
  });
  const issue = found.find(entry => entry.id === 'heartbeat-file-blocks-scratch');
  assert.ok(issue);
  assert.match(issue.description, /324000 bytes/);
  assert.match(issue.fix, /does not edit the file/);
  assert.equal(detectIssues({ workspace: { heartbeatFile: { bytes: 10, utf8: true } }, config: {} })
    .some(entry => entry.id === 'heartbeat-file-blocks-scratch'), false);
});

test('the hosted script records heartbeat file size without reading past the cap', async (t) => {
  const start = DIAGNOSTIC_SCRIPT.indexOf('HEARTBEAT_FILE_JSON=null');
  const end = DIAGNOSTIC_SCRIPT.indexOf('# --- Check Ports ---');
  assert.ok(start > 0 && end > start);
  const snippet = DIAGNOSTIC_SCRIPT.slice(start, end);
  assert.match(snippet, /MAX_BYTES = 262144/);
  assert.equal(snippet.includes('cli/core/'), false);

  const home = await mkdtemp(join(tmpdir(), 'clawfix-heartbeat-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const workspace = join(home, 'workspace');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(workspace);
  await writeFile(join(workspace, 'HEARTBEAT.md'), Buffer.from([0x68, 0x69, 0xff]));
  const printed = spawnSync('bash', ['-c', `${snippet}\nprintf '%s' "$HEARTBEAT_FILE_JSON"`], {
    env: { ...process.env, WORKSPACE_DIR: workspace },
    encoding: 'utf8',
  });
  assert.equal(printed.status, 0, printed.stderr);
  assert.deepEqual(JSON.parse(printed.stdout), { bytes: 3, utf8: false });
});
