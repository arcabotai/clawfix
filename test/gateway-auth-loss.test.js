import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { retainDiagnosticLogLine } from '../cli/bin/security.js';
import { deriveIssues } from '../cli/core/diagnostics.js';
import { repairCatalog } from '../cli/core/repair-catalog.js';
import { detectIssues } from '../src/known-issues.js';
import { DIAGNOSTIC_SCRIPT } from '../src/routes/script.js';

const MISSING_GATEWAY_TOKEN_FIX_HINT = 'Run `openclaw doctor --fix --generate-gateway-token` to generate a token, then restart the Gateway.';

async function fixture(name) {
  return readFile(new URL(`./fixtures/openclaw-gateway-auth/${name}`, import.meta.url), 'utf8');
}

function collected(text, extra = {}) {
  return {
    config: extra.config === undefined ? { gateway: { mode: 'local' } } : extra.config,
    system: { runtimeCompatible: true, runtimeRequired: null, runtimeCurrent: null },
    gateway: { gatewayStatus: 'running', gatewayPort: 18789, gatewayPid: '9' },
    logs: { errorLogs: text, stderrLogs: '', gatewayLogTail: '', errLogSizeMB: 0 },
    serviceHealth: { runs: 1, uptimeSeconds: 30, uptimeStr: '30s', nRestarts: 0 },
    workspace: { workspaceDir: '/w', hasSoul: true, memoryFiles: 1 },
    ports: { gateway: { listening: true, pid: 9 } },
    nativeDoctor: extra.nativeDoctor || { available: true, findings: [] },
    nativeConfig: { available: true, valid: true, errors: [] },
    nativeStatus: { available: true, gateway: { reachable: true } },
    nativeSecurity: extra.nativeSecurity || { available: true, findings: [] },
    gatewayAuth: extra.gatewayAuth,
  };
}

test('a backup or the removal log shows gateway.auth was lost, without printing a token', async () => {
  const text = await fixture('auth-removed.txt');
  assert.equal(retainDiagnosticLogLine('gateway.auth REMOVED'), true);
  const issue = detectIssues({
    logs: { errors: text },
    openclaw: {
      gatewayAuth: {
        current: { read: true, present: false, mode: null },
        backups: [{ name: 'openclaw.json.bak', present: true, mode: 'token' }],
      },
    },
    config: { gateway: { mode: 'local' } },
  }).find(entry => entry.id === 'gateway-auth-removed');
  assert.ok(issue);
  assert.equal(issue.severity, 'critical');
  assert.match(issue.description, /openclaw\.json\.bak/);
  assert.match(issue.description, /mode token/);
  assert.match(issue.description, /143131/);
  assert.match(issue.description, /does not restore the block or print the token/);
  assert.equal(issue.description.includes('abcdef'), false);
  assert.equal(repairCatalog['gateway-auth-removed'], undefined);

  const fromLog = deriveIssues(collected(text, {
    gatewayAuth: { current: { read: true, present: false, mode: null }, backups: [] },
  })).find(entry => entry.knownIssueId === 'gateway-auth-removed');
  assert.ok(fromLog);
  assert.match(fromLog.description, /gateway\.auth REMOVED/);
});

test('missing gateway.auth without a backup or removal line is not a loss', async () => {
  assert.equal(detectIssues({
    logs: { errors: await fixture('negatives.txt') },
    openclaw: {
      gatewayAuth: {
        current: { read: true, present: false, mode: null },
        backups: [{ name: 'openclaw.json.bak', present: true, mode: 'none' }],
      },
    },
    config: { gateway: { mode: 'local' } },
  }).some(entry => entry.id === 'gateway-auth-removed'), false);

  assert.equal(detectIssues({
    logs: { errors: await fixture('auth-removed.txt') },
    openclaw: {
      gatewayAuth: {
        current: { read: true, present: true, mode: 'token' },
        backups: [{ name: 'openclaw.json.bak', present: true, mode: 'token' }],
      },
    },
    config: { gateway: { mode: 'local', auth: { mode: 'token' } } },
  }).some(entry => entry.id === 'gateway-auth-removed'), false);
});

test('auth-loss replaces the generic missing-token gateway findings', async () => {
  const issues = deriveIssues(collected(await fixture('auth-removed.txt'), {
    gatewayAuth: {
      current: { read: true, present: false, mode: null },
      backups: [{ name: 'openclaw.json.bak', present: true, mode: 'password' }],
    },
    nativeSecurity: {
      available: true,
      findings: [{
        checkId: 'gateway.loopback_no_auth',
        severity: 'critical',
        title: 'Loopback gateway has no auth',
        message: 'gateway.bind is loopback but no gateway auth secret is configured.',
      }],
    },
    nativeDoctor: {
      available: true,
      findings: [{
        checkId: 'core/doctor/gateway-auth',
        severity: 'warning',
        path: 'gateway.auth.token',
        message: 'Gateway auth is off or missing a token.',
        fixHint: MISSING_GATEWAY_TOKEN_FIX_HINT,
      }],
    },
  }));
  assert.equal(issues.filter(issue => issue.knownIssueId === 'gateway-auth-removed').length, 1);
  assert.equal(issues.some(issue => issue.nativeCheckId === 'gateway.loopback_no_auth'), false);
  assert.equal(issues.some(issue => issue.nativeCheckId === 'core/doctor/gateway-auth'), false);
});

test('AUTH_PROFILE_MIGRATION_REQUIRED is one finding and does not repeat the doctor line', async () => {
  const text = await fixture('auth-profile.txt');
  const issues = deriveIssues(collected(text, {
    nativeDoctor: {
      available: true,
      findings: [{
        checkId: 'core/doctor/runtime-tool-schemas',
        severity: 'error',
        message: 'health check threw: Auth profile store ~/.openclaw/agents/main/agent/openclaw-agent.sqlite requires legacy credential migration; run openclaw doctor --fix.',
      }],
    },
  }));
  const matches = issues.filter(issue => (
    issue.knownIssueId === 'auth-profile-migration-required'
    || /AUTH_PROFILE_MIGRATION_REQUIRED|legacy credential migration/.test(issue.text || '')
  ));
  assert.equal(matches.length, 1);
  assert.equal(matches[0].knownIssueId, 'auth-profile-migration-required');
  assert.match(matches[0].description, /134608/);
  assert.match(matches[0].description, /does not run doctor --fix/);
  assert.equal(repairCatalog['auth-profile-migration-required'], undefined);
});

test('withheld-cross-device and the mismatch line are one stale-token finding', async () => {
  const text = await fixture('stale-device.txt');
  const issues = deriveIssues(collected(text, {
    nativeDoctor: {
      available: true,
      findings: [{
        checkId: 'core/doctor/device-pairing',
        severity: 'warning',
        message: 'Local cached operator device token for cli (0eab85f6…) predates the gateway rotation. This is a stale device-token pattern and can fail with device token mismatch.',
      }],
    },
  }));
  const matches = issues.filter(issue => (
    issue.knownIssueId === 'stale-device-token'
    || /withheld-cross-device|device token mismatch|stale device-token/.test(`${issue.text} ${issue.description}`)
  ));
  assert.equal(matches.length, 1);
  assert.equal(matches[0].severity, 'medium');
  assert.match(matches[0].description, /withheld-cross-device/);
  assert.match(matches[0].description, /devices rotate --device <id> --role operator/);
  assert.match(matches[0].description, /189206/);
  assert.equal(matches[0].description.includes('0eab85f6'), false);
  assert.equal(repairCatalog['stale-device-token'], undefined);
  assert.equal(deriveIssues(collected(await fixture('negatives.txt')))
    .some(issue => issue.knownIssueId === 'stale-device-token'
      || issue.knownIssueId === 'auth-profile-migration-required'), false);
});

test('the hosted script records auth presence and mode, not the token', async (t) => {
  const start = DIAGNOSTIC_SCRIPT.indexOf('GATEWAY_AUTH_JSON=null');
  const end = DIAGNOSTIC_SCRIPT.indexOf('# --- Build Diagnostic Payload ---');
  assert.ok(start > 0 && end > start);
  const snippet = DIAGNOSTIC_SCRIPT.slice(start, end);
  assert.match(DIAGNOSTIC_SCRIPT, /"gatewayAuth": \$GATEWAY_AUTH_JSON/);
  assert.equal(snippet.includes('cli/core/'), false);
  const root = await mkdtemp(join(tmpdir(), 'clawfix-gateway-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = 'a'.repeat(48);
  const configPath = join(root, 'openclaw.json');
  await writeFile(configPath, `${JSON.stringify({ gateway: { mode: 'local', tailscale: { mode: 'off' } } })}\n`);
  await writeFile(join(root, 'openclaw.json.bak'), `${JSON.stringify({
    gateway: { mode: 'local', auth: { mode: 'token', token } },
  })}\n`);
  const printed = spawnSync('bash', ['-c', `${snippet}\nprintf '%s' "$GATEWAY_AUTH_JSON"`], {
    env: { ...process.env, OPENCLAW_CONFIG: configPath },
    encoding: 'utf8',
  });
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout.includes(token), false);
  const facts = JSON.parse(printed.stdout);
  assert.deepEqual(facts.current, { read: true, present: false, mode: null });
  assert.deepEqual(facts.backups, [{ name: 'openclaw.json.bak', present: true, mode: 'token' }]);
  const issue = detectIssues({
    logs: { errors: '' },
    openclaw: { gatewayAuth: facts },
    config: { gateway: { mode: 'local' } },
  }).find(entry => entry.id === 'gateway-auth-removed');
  assert.ok(issue);
  assert.equal(issue.description.includes(token), false);
});
