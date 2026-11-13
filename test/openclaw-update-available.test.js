import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { collectOpenClawUpdateStatus } from '../cli/bin/native-diagnostics.js';
import {
  describeOpenClawUpdateAvailable as describeFromSecurity,
  openclawUpdateAvailable as availableFromSecurity,
  projectOpenClawUpdateStatus as projectFromSecurity,
} from '../cli/bin/security.js';
import { repairCatalog } from '../cli/core/repair-catalog.js';
import {
  createDiagnosticsCore,
  deriveIssues,
  describeOpenClawUpdateAvailable as describeFromCore,
  narrowUploadedUpdate,
  openclawUpdateAvailable as availableFromCore,
  projectOpenClawUpdateStatus as projectFromCore,
} from '../cli/core/diagnostics.js';
import { redactOutbound } from '../cli/bin/security.js';
import { detectIssues, KNOWN_ISSUES } from '../src/known-issues.js';
import { validateRepairScript } from '../src/repair-validator.js';
import { DIAGNOSTIC_SCRIPT } from '../src/routes/script.js';

const FIXTURES = new URL('./fixtures/openclaw-update-status/', import.meta.url);
const PRINTED_OLD = 'OpenClaw 2026.6.11 (e085fa1)';
const PRINTED_CURRENT = 'OpenClaw 2026.11.3 (847611d)';

async function fixture(name) {
  return readFile(new URL(name, FIXTURES), 'utf8');
}

async function envelope(name) {
  return JSON.parse(await fixture(name));
}

function spawnResult(stdout, { status = 0, stderr = '', timedOut = false } = {}) {
  return {
    status: timedOut ? null : status,
    signal: null,
    stdout,
    stderr,
    error: timedOut ? Object.assign(new Error('Process timed out after 30000ms'), { code: 'ETIMEDOUT' }) : null,
    errorCode: timedOut ? 'ETIMEDOUT' : null,
    timedOut,
  };
}

test('the server and CLI update projectors stay identical', async () => {
  assert.equal(projectFromSecurity.toString(), projectFromCore.toString());
  assert.equal(availableFromSecurity.toString(), availableFromCore.toString());
  assert.equal(describeFromSecurity.toString(), describeFromCore.toString());
  const available = await envelope('update-available.json');
  const samples = [
    [available, PRINTED_OLD],
    [await envelope('up-to-date.json'), PRINTED_CURRENT],
    [await envelope('beta-channel.json'), '2026.6.11'],
    [await envelope('offline.json'), '2026.6.11'],
    [await envelope('dev-channel.json'), '2026.6.11'],
    [null, '2026.6.11'],
    [{ update: { installKind: 'git' } }, '2026.6.11'],
  ];
  for (const [parsed, version] of samples) {
    const projected = projectFromSecurity(parsed, version);
    assert.deepEqual(projectFromCore(parsed, version), projected);
    assert.deepEqual(availableFromCore(projected), availableFromSecurity(projected));
    assert.equal(describeFromCore(availableFromSecurity(projected)), describeFromSecurity(availableFromSecurity(projected)));
  }
});

test('a package update on the configured stable channel is advisory and low', async () => {
  const parsed = await envelope('update-available.json');
  const projected = projectFromSecurity(parsed, PRINTED_OLD);
  assert.deepEqual(projected, {
    currentVersion: '2026.6.11',
    availableVersion: '2026.11.3',
    channel: 'stable',
    updateAvailable: true,
  });
  assert.equal(JSON.stringify(projected).includes('/opt/openclaw'), false);
  const issue = detectIssues({ openclaw: { updateAvailability: projected } })
    .find(item => item.id === 'openclaw-update-available');
  assert.ok(issue);
  assert.equal(issue.severity, 'low');
  assert.match(issue.description, /2026\.6\.11/);
  assert.match(issue.description, /2026\.11\.3/);
  assert.match(issue.description, /stable/);
  assert.match(issue.description, /openclaw update/);
  assert.equal(issue.description.includes('/opt/openclaw'), false);
  const local = deriveIssues({
    config: { gateway: { port: 18789 } },
    system: { runtimeCompatible: true, nodeVersion: 'v22.0.0', ocVersion: PRINTED_OLD },
    gateway: { gatewayStatus: 'runtime: ok\nrunning, pid 4242', gatewayPort: 18789, gatewayPid: '4242' },
    logs: { errorLogs: '', stderrLogs: '', gatewayLogTail: '', errLogSizeMB: 0 },
    serviceHealth: { runs: 0, uptimeSeconds: 0, uptimeStr: '', nRestarts: 0 },
    workspace: { workspaceDir: '', hasSoul: true, memoryFiles: 1, codexHome: { matchesExpected: true } },
    ports: { gateway: { valid: true, available: true, listening: false, process: null, pid: null, collector: 'ss' } },
    nativeDoctor: { available: false, findings: [] },
    nativeConfig: { available: false, valid: null, warnings: [], errors: [] },
    nativeStatus: { available: false },
    nativeSecurity: { available: false, findings: [] },
    updateAvailability: projected,
  }).find(item => item.knownIssueId === 'openclaw-update-available');
  assert.ok(local);
  assert.equal(local.severity, 'low');
  assert.match(local.description, /openclaw update/);
});

test('an up-to-date package, a beta channel, and a dev channel stay on that channel', async () => {
  const current = projectFromSecurity(await envelope('up-to-date.json'), PRINTED_CURRENT);
  assert.deepEqual(current, {
    currentVersion: '2026.11.3',
    availableVersion: '2026.11.3',
    channel: 'stable',
    updateAvailable: false,
  });
  assert.equal(detectIssues({ openclaw: { updateAvailability: current } })
    .some(item => item.id === 'openclaw-update-available'), false);

  const beta = projectFromSecurity(await envelope('beta-channel.json'), '2026.6.11');
  assert.equal(beta.channel, 'beta');
  assert.equal(beta.availableVersion, '2026.11.5-beta.2');
  assert.equal(beta.updateAvailable, true);
  assert.notEqual(beta.availableVersion, '2026.11.3');
  const betaIssue = detectIssues({ openclaw: { updateAvailability: beta } })
    .find(item => item.id === 'openclaw-update-available');
  assert.match(betaIssue.description, /beta/);
  assert.equal(betaIssue.description.includes('2026.11.3'), false);

  assert.equal(projectFromSecurity(await envelope('dev-channel.json'), '2026.6.11'), null);
  const devAvailable = structuredClone(await envelope('beta-channel.json'));
  devAvailable.channel = { value: 'dev', source: 'config', label: 'dev (config)', config: 'dev' };
  devAvailable.update.registry.tag = 'dev';
  assert.equal(projectFromSecurity(devAvailable, '2026.6.11'), null);
});

test('offline, registry errors, source installs, malformed JSON, and unknown commands are silent', async () => {
  assert.equal(projectFromSecurity(await envelope('offline.json'), '2026.6.11'), null);

  const failed = structuredClone(await envelope('update-available.json'));
  failed.update.registry = {
    latestVersion: null,
    tag: 'latest',
    error: 'HTTP 503',
    reason: 'selector_query_failed',
  };
  failed.availability = {
    available: false,
    hasGitUpdate: false,
    hasRegistryUpdate: false,
    latestVersion: null,
    gitBehind: null,
  };
  assert.equal(projectFromSecurity(failed, PRINTED_OLD), null);

  failed.update.error = { status: 'failed', message: 'registry unavailable' };
  failed.availability.available = true;
  failed.availability.hasRegistryUpdate = true;
  failed.availability.latestVersion = '2026.11.3';
  assert.equal(projectFromSecurity(failed, PRINTED_OLD), null);

  const source = structuredClone(await envelope('update-available.json'));
  source.update.installKind = 'git';
  source.update.git = { behind: 4, branch: 'main', root: '/opt/openclaw' };
  source.availability = {
    available: true,
    hasGitUpdate: true,
    hasRegistryUpdate: false,
    latestVersion: null,
    gitBehind: 4,
  };
  assert.equal(projectFromSecurity(source, PRINTED_OLD), null);

  const crossed = structuredClone(await envelope('update-available.json'));
  crossed.update.registry.tag = 'beta';
  crossed.update.registry.latestVersion = '2026.11.5-beta.2';
  crossed.availability.latestVersion = '2026.11.5-beta.2';
  assert.equal(projectFromSecurity(crossed, PRINTED_OLD), null);
  assert.equal(detectIssues({
    openclaw: {
      updateAvailability: {
        currentVersion: '2026.6.11',
        availableVersion: '2026.11.5-beta.2',
        channel: 'stable',
        updateAvailable: true,
      },
    },
  }).some(item => item.id === 'openclaw-update-available'), false);

  const malformed = await fixture('malformed.txt');
  assert.equal(collectOpenClawUpdateStatus('/usr/local/bin/openclaw', PRINTED_OLD, () => (
    spawnResult(malformed)
  )), null);
  const unknown = await fixture('unknown-command.txt');
  assert.equal(collectOpenClawUpdateStatus('/usr/local/bin/openclaw', PRINTED_OLD, () => (
    spawnResult('', { status: 1, stderr: unknown })
  )), null);
  assert.match(unknown, /Unknown command/);
});

test('the collector keeps the OpenClaw command bounded and drops a timed-out process', async () => {
  let argv;
  let options;
  const result = collectOpenClawUpdateStatus('/usr/local/bin/openclaw', PRINTED_OLD, (_bin, received, receivedOptions) => {
    argv = received;
    options = receivedOptions;
    return spawnResult('', { timedOut: true });
  });
  assert.equal(result, null);
  assert.deepEqual(argv, ['update', 'status', '--json', '--timeout', '10']);
  assert.equal(options.timeout, 30_000);
  assert.equal(options.maxStdoutBytes > 0, true);
});

test('an older status envelope without a registry tag still reports stable, and only stable', async () => {
  const parsed = await envelope('update-available.json');
  delete parsed.update.registry.tag;
  assert.deepEqual(projectFromSecurity(parsed, PRINTED_OLD), {
    currentVersion: '2026.6.11',
    availableVersion: '2026.11.3',
    channel: 'stable',
    updateAvailable: true,
  });
  const beta = await envelope('beta-channel.json');
  delete beta.update.registry.tag;
  assert.equal(projectFromSecurity(beta, '2026.6.11'), null);
});

test('beta follows the stable version only when upstream selected the latest tag', async () => {
  const parsed = await envelope('beta-channel.json');
  parsed.update.registry = { latestVersion: '2026.11.3', tag: 'latest' };
  parsed.availability.latestVersion = '2026.11.3';
  const projected = projectFromSecurity(parsed, '2026.11.2');
  assert.deepEqual(projected, {
    currentVersion: '2026.11.2',
    availableVersion: '2026.11.3',
    channel: 'beta',
    updateAvailable: true,
  });
  parsed.update.registry.latestVersion = '2026.11.5-beta.2';
  parsed.availability.latestVersion = '2026.11.5-beta.2';
  assert.equal(projectFromSecurity(parsed, '2026.11.2'), null);
});

test('extended-stable stays on its own tag', () => {
  const parsed = {
    update: {
      installKind: 'package',
      registry: { latestVersion: '2026.10.33', tag: 'extended-stable' },
    },
    channel: { value: 'extended-stable', source: 'config', label: 'extended-stable (config)', config: 'extended-stable' },
    availability: {
      available: true,
      hasGitUpdate: false,
      hasRegistryUpdate: true,
      latestVersion: '2026.10.33',
      gitBehind: null,
    },
  };
  assert.equal(projectFromSecurity(parsed, '2026.10.10')?.updateAvailable, true);
  parsed.channel.value = 'stable';
  parsed.channel.config = 'stable';
  parsed.update.registry.tag = 'latest';
  assert.equal(projectFromSecurity(parsed, '2026.10.10'), null);
});

test('runDiagnostics uploads only the version pair, channel, and boolean', async () => {
  const stdout = await fixture('update-available.json');
  const deps = {
    version: '0.12.0',
    redact: redactOutbound,
    fs: {
      async exists() { return false; },
      async readJson() { return null; },
      async stat() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      async readdir() { return []; },
      async countMarkdownFiles() { return 0; },
    },
    openclaw: {
      async findExecutable() { return '/usr/local/bin/openclaw'; },
      async npmVersion() { return '10.9.2'; },
      async version() { return { status: 0, stdout: `${PRINTED_OLD}\n`, stderr: '' }; },
      async gatewayStatusText() { return 'runtime: ok\nrunning, pid 4242'; },
      async gatewayProcesses() { return '4242'; },
      async readFileTail() { return { text: '' }; },
      async serviceManagerState() { return {}; },
    },
    os: {
      homedir: () => '/home/fake-user',
      platform: () => 'linux',
      release: () => 'test',
      arch: () => 'x64',
      hostname: () => 'unit-test-marker-host',
      nodeVersion: () => 'v22.14.0',
    },
    env: {},
    clock: { now: () => new Date('2026-11-13T00:00:00.000Z') },
    createHash,
    timers: { setTimeout, clearTimeout },
    nativeCollectors: {
      collectOpenClawVersion() {
        return {
          version: PRINTED_OLD,
          runtimeCompatible: true,
          runtimeRequired: null,
          runtimeCurrent: null,
          error: '',
        };
      },
      collectListeningPort() {
        return { valid: true, available: true, listening: false, process: null, pid: null, collector: 'ss' };
      },
      collectNativeDoctor() { return { available: false, findings: [] }; },
      collectNativeConfigValidation() { return { available: false, valid: null, warnings: [], errors: [] }; },
      collectNativeStatus() { return { available: false }; },
      collectNativeSecurityAudit() { return { available: false, findings: [] }; },
      collectOpenClawUpdateStatus(bin, version, runSync) {
        return collectOpenClawUpdateStatus(bin, version, () => spawnResult(stdout));
      },
    },
  };
  const events = [];
  const result = await createDiagnosticsCore(deps).runDiagnostics({
    revision: 'rev-update-available',
    emit: (event) => events.push(event),
  });
  assert.deepEqual(result.diagnostic.openclaw.updateAvailability, {
    currentVersion: '2026.6.11',
    availableVersion: '2026.11.3',
    channel: 'stable',
    updateAvailable: true,
  });
  const serialized = JSON.stringify(result.diagnostic);
  assert.equal(serialized.includes('/opt/openclaw'), false);
  assert.equal(serialized.includes('lockfilePath'), false);
  assert.equal(serialized.includes('runtimeFindings'), false);
  assert.equal(serialized.includes('node:sqlite'), false);
  const step = events.find(event => event.phase === 'native');
  assert.deepEqual(step.data.update, { channel: 'stable', updateAvailable: true });
  assert.equal(JSON.stringify(step).includes('/opt/openclaw'), false);
  const issue = result.issues.find(item => item.knownIssueId === 'openclaw-update-available');
  assert.ok(issue);
  assert.equal(narrowUploadedUpdate({ ...result.diagnostic.openclaw.updateAvailability, root: '/opt/openclaw' }), null);
});

test('the hosted collector matches the CLI projector and does not keep the raw envelope', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'clawfix-update-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const start = DIAGNOSTIC_SCRIPT.indexOf('UPDATE_JSON=null');
  const end = DIAGNOSTIC_SCRIPT.indexOf('# --- Sanitize Config');
  assert.ok(start > 0 && end > start);
  const snippet = DIAGNOSTIC_SCRIPT.slice(start, end);
  assert.match(snippet, /timeout: 30000/);
  assert.match(snippet, /update', 'status', '--json', '--timeout', '10'/);

  const cases = [
    ['update-available.json', PRINTED_OLD],
    ['up-to-date.json', PRINTED_CURRENT],
    ['beta-channel.json', '2026.6.11'],
    ['offline.json', '2026.6.11'],
    ['dev-channel.json', '2026.6.11'],
    ['malformed.txt', '2026.6.11'],
    ['unknown-command.txt', '2026.6.11'],
  ];
  for (const [name, version] of cases) {
    const body = await fixture(name);
    const out = join(home, name);
    await writeFile(out, name.endsWith('.json') ? body : 'not-json\n');
    const bin = join(home, `openclaw-${name}`);
    const command = name === 'unknown-command.txt'
      ? 'echo unknown-command >&2\nexit 1\n'
      : `cat ${JSON.stringify(out)}\n`;
    await writeFile(bin, `#!/bin/sh\n${command}`);
    await chmod(bin, 0o755);
    const printed = spawnSync('bash', ['-c', `${snippet}\nprintf '%s' "$UPDATE_JSON"`], {
      env: { ...process.env, HOME: home, OPENCLAW_BIN: bin, OC_VERSION: version },
      encoding: 'utf8',
    });
    assert.equal(printed.status, 0, printed.stderr);
    const hosted = printed.stdout === 'null' ? null : JSON.parse(printed.stdout);
    const expected = name.endsWith('.json')
      ? projectFromSecurity(JSON.parse(body), version)
      : null;
    assert.deepEqual(hosted, expected, name);
    assert.equal(printed.stdout.includes('/opt/openclaw'), false, name);
    assert.equal(printed.stdout.includes('runtimeFindings'), false, name);
  }
});

test('the advisory stays out of the repair catalog', () => {
  const issue = KNOWN_ISSUES.find(item => item.id === 'openclaw-update-available');
  assert.ok(issue);
  assert.equal(issue.severity, 'low');
  assert.equal(repairCatalog['openclaw-update-available'], undefined);
  const validation = validateRepairScript(issue.fix);
  assert.equal(validation.ok, true, JSON.stringify(validation.blockers));
  assert.match(issue.fix, /openclaw update/);
  assert.equal(issue.fix.includes('openclaw update --yes'), false);
});
