import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { retainDiagnosticLogLine } from '../cli/bin/security.js';
import { deriveIssues } from '../cli/core/diagnostics.js';
import { repairCatalog } from '../cli/core/repair-catalog.js';
import { detectIssues } from '../src/known-issues.js';
import { DIAGNOSTIC_SCRIPT } from '../src/routes/script.js';

const IDS = [
  'windows-task-readiness-timeout',
  'antivirus-gateway-blocked',
  'systemd-service-stuck',
];

async function fixture(name) {
  return readFile(new URL(`./fixtures/openclaw-service-start/${name}`, import.meta.url), 'utf8');
}

function hosted(text, extra = {}) {
  return detectIssues({
    logs: { errors: text, stderr: '' },
    openclaw: { gatewayStatus: extra.status || 'not running', processExists: false },
    service: extra.service,
    serviceStart: extra.serviceStart,
    config: {},
  });
}

function collected(text, extra = {}) {
  return {
    config: { gateway: { mode: 'local' } },
    system: { runtimeCompatible: true },
    gateway: { gatewayStatus: extra.status || 'not running', gatewayPort: 18789, gatewayPid: '' },
    logs: { errorLogs: text, stderrLogs: '', gatewayLogTail: extra.journal || '', errLogSizeMB: 0 },
    serviceHealth: extra.serviceHealth || { runs: 1, uptimeSeconds: 30, uptimeStr: '30s', nRestarts: 0 },
    workspace: { workspaceDir: '/w', hasSoul: true, memoryFiles: 1 },
    ports: { gateway: { listening: false } },
    nativeDoctor: extra.nativeDoctor || { available: true, findings: [] },
    nativeConfig: { available: true, valid: true, errors: [] },
    nativeStatus: { available: true, gateway: { reachable: false } },
    nativeSecurity: { available: true, findings: [] },
  };
}

test('a Windows readiness timeout is one finding, and a successful task is not', async () => {
  const text = await fixture('windows-timeout.txt');
  assert.equal(retainDiagnosticLogLine('Gateway start timed out after 90s waiting for /healthz and /readyz.'), true);
  const issues = hosted(text, {
    serviceStart: { scheduledTask: { name: 'OpenClaw Gateway', status: 'Ready', lastResult: 1 } },
  });
  const issue = issues.find(entry => entry.id === 'windows-task-readiness-timeout');
  assert.ok(issue);
  assert.equal(issue.severity, 'high');
  assert.match(issue.description, /last result 1/);
  assert.match(issue.description, /status --deep/);
  assert.match(issue.description, /does not edit the task/);
  assert.match(issue.description, /166004/);
  assert.equal(issue.fix.includes('schtasks'), false);
  assert.equal(issues.some(entry => entry.id === 'gateway-not-running'), false);
  assert.equal(issues.some(entry => entry.id === 'launchd-corrupted-state'), false);
  assert.equal(repairCatalog['windows-task-readiness-timeout'], undefined);

  const quiet = hosted(await fixture('windows-negative.txt'), {
    serviceStart: { scheduledTask: { status: 'Ready', lastResult: 0 } },
    status: 'Runtime: running pid 9\nconnectivity check: ok',
  });
  assert.equal(quiet.some(entry => IDS.includes(entry.id)), false);

  const running = hosted('', {
    serviceStart: { scheduledTask: { status: 'Running', lastResult: 267009 } },
    status: 'Runtime: running pid 9\nconnectivity check: ok',
  });
  assert.equal(running.some(entry => IDS.includes(entry.id)), false);
});

test('an antivirus signature replaces the readiness finding and does not touch protection settings', async () => {
  const text = `${await fixture('antivirus.txt')}\n${await fixture('windows-timeout.txt')}`;
  const issues = hosted(text);
  assert.equal(issues.filter(entry => entry.id === 'antivirus-gateway-blocked').length, 1);
  assert.equal(issues.some(entry => entry.id === 'windows-task-readiness-timeout'), false);
  const issue = issues.find(entry => entry.id === 'antivirus-gateway-blocked');
  assert.match(issue.description, /IDP\.HELU\.PSE90/);
  assert.match(issue.description, /does not change antivirus settings/);
  assert.match(issue.description, /139468/);
  assert.equal(/schtasks|systemctl/.test(issue.fix), false);
  assert.match(issue.fix, /does not change antivirus settings/);
  assert.equal(repairCatalog['antivirus-gateway-blocked'], undefined);

  const up = hosted(await fixture('antivirus.txt'), {
    status: 'Runtime: running pid 9\nconnectivity check: ok',
  }).find(entry => entry.id === 'antivirus-gateway-blocked');
  assert.equal(up.severity, 'medium');
  assert.match(up.description, /still answered/);

  assert.equal(hosted(await fixture('antivirus-negative.txt'), {
    status: 'Runtime: running pid 9\nconnectivity check: ok',
  }).some(entry => IDS.includes(entry.id)), false);
});

test('a stuck or failed systemd unit is reported once, and an active unit is not', async () => {
  const text = await fixture('systemd-stuck.txt');
  const issues = hosted(text, {
    service: { manager: 'systemd', state: 'deactivating', subState: 'stop-sigterm', result: 'success' },
  });
  const issue = issues.find(entry => entry.id === 'systemd-service-stuck');
  assert.ok(issue);
  assert.match(issue.description, /deactivating \/ stop-sigterm/);
  assert.match(issue.description, /result success/);
  assert.match(issue.description, /gateway stop, then openclaw gateway start/);
  assert.match(issue.description, /does not edit the unit/);
  assert.match(issue.description, /140821/);
  assert.equal(issue.description.includes('ada'), false);
  assert.match(issue.description, /~\/\.openclaw/);
  assert.equal(issue.fix.includes('systemctl'), false);
  assert.equal(issues.some(entry => entry.id === 'gateway-not-running'), false);
  assert.equal(issues.some(entry => entry.id === 'launchd-corrupted-state'), false);
  assert.equal(repairCatalog['systemd-service-stuck'], undefined);

  const failed = deriveIssues(collected('', {
    serviceHealth: {
      manager: 'systemd',
      state: 'failed',
      subState: 'failed',
      result: 'exit-code',
      nRestarts: 4,
      runs: 1,
      uptimeSeconds: 0,
    },
  }));
  assert.equal(failed.filter(entry => entry.knownIssueId === 'systemd-service-stuck').length, 1);
  assert.equal(failed.some(entry => entry.text === 'Gateway is not running'), false);
  assert.equal(failed.some(entry => /restarted 4 time/.test(entry.text)), false);

  const healthy = hosted(await fixture('systemd-healthy.txt'), {
    service: { manager: 'systemd', state: 'active', subState: 'running', result: 'success' },
    status: 'Runtime: running pid 9\nconnectivity check: ok',
  });
  assert.equal(healthy.some(entry => IDS.includes(entry.id)), false);
});

test('the LaunchAgent detector still matches a SIGTERM launchd service', () => {
  const issues = detectIssues({
    logs: { errors: 'launchctl: Load failed: 5: Input/output error', stderr: '', sigtermCount: 2 },
    openclaw: { processExists: false, gatewayStatus: 'not running', portListening: false },
    service: { manager: 'launchd', state: 'sigterm', exitCode: '-15' },
    config: {},
  });
  assert.equal(issues.some(entry => entry.id === 'launchd-corrupted-state'), true);
  assert.equal(issues.some(entry => IDS.includes(entry.id)), false);
});

test('a doctor line that only repeats the readiness timeout is not listed twice', () => {
  const issues = deriveIssues(collected('Gateway start timed out after 90s waiting for /healthz and /readyz.', {
    nativeDoctor: {
      available: true,
      findings: [
        { checkId: 'core/doctor/gateway-daemon', severity: 'warning', message: 'Gateway start timed out after 90s waiting for /healthz and /readyz.' },
        { checkId: 'core/doctor/gateway-daemon', severity: 'warning', message: 'Gateway service is not installed.' },
      ],
    },
    serviceHealth: { manager: 'schtasks', state: 'Ready', lastResult: 1, runs: 1, nRestarts: 0 },
  }));
  assert.equal(issues.filter(entry => entry.knownIssueId === 'windows-task-readiness-timeout').length, 1);
  assert.equal(issues.some(entry => entry.text === 'Gateway start timed out after 90s waiting for /healthz and /readyz.'), false);
  assert.equal(issues.some(entry => entry.text === 'Gateway service is not installed.'), true);
});

test('the hosted script reads task and systemd facts and does not edit them', () => {
  const start = DIAGNOSTIC_SCRIPT.indexOf('SERVICE_START_JSON=null');
  const end = DIAGNOSTIC_SCRIPT.indexOf('# --- Build Diagnostic Payload ---');
  assert.ok(start > 0 && end > start);
  const snippet = DIAGNOSTIC_SCRIPT.slice(start, end);
  assert.match(snippet, /schtasks/);
  assert.match(snippet, /journalctl/);
  assert.match(snippet, /openclaw-gateway\.service/);
  assert.equal(/schtasks[^\n]*\/Change/.test(snippet), false);
  assert.equal(/systemctl[^\n]*(edit|daemon-reload|restart)/.test(snippet), false);
  assert.equal(snippet.includes('cli/core/'), false);
  assert.match(DIAGNOSTIC_SCRIPT, /"serviceStart": \$SERVICE_START_JSON/);
  assert.match(DIAGNOSTIC_SCRIPT, /IDP\\.HELU\\.PSE/);
  assert.match(DIAGNOSTIC_SCRIPT, /Gateway start timed out/);

  const printed = spawnSync('bash', ['-c', `${snippet}\nprintf '%s' "$SERVICE_START_JSON"`], {
    encoding: 'utf8',
  });
  assert.equal(printed.status, 0, printed.stderr);
  const facts = JSON.parse(printed.stdout);
  assert.equal(Object.hasOwn(facts, 'scheduledTask'), true);
  assert.equal(Object.hasOwn(facts, 'systemd'), true);
  assert.equal(Object.hasOwn(facts, 'journal'), true);
});
