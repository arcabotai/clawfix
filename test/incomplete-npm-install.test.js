import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat, mkdir, readFile, readlink, realpath, rm, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';

import {
  describeIncompleteNpmInstall as describeFromSecurity,
  incompleteNpmInstall as incompleteFromSecurity,
} from '../cli/bin/security.js';
import { createDiagnosticsCore } from '../cli/core/diagnostics.js';
import {
  describeIncompleteNpmInstall as describeFromCore,
  deriveIssues,
  incompleteNpmInstall as incompleteFromCore,
  inspectOpenClawInstall,
} from '../cli/core/diagnostics.js';
import { normalizeFindings } from '../cli/core/findings.js';
import { redactOutbound } from '../cli/bin/security.js';
import { detectIssues, KNOWN_ISSUES } from '../src/known-issues.js';
import { validateRepairScript } from '../src/repair-validator.js';
import { DIAGNOSTIC_SCRIPT } from '../src/routes/script.js';

const SECRET = 'sk-live-install-secret-value';
const fsApi = { lstat, readlink, realpath, readFile };

function finding(install) {
  return detectIssues({ openclaw: { install } }).find(issue => issue.id === 'incomplete-npm-install');
}

function localFinding(install) {
  return deriveIssues(collected(install)).find(issue => issue.knownIssueId === 'incomplete-npm-install');
}

function collected(install) {
  return {
    config: {
      gateway: { port: 18789 },
      agents: {
        defaults: {
          contextPruning: { mode: 'cache-ttl' },
          compaction: { memoryFlush: { enabled: true } },
        },
      },
    },
    system: { runtimeCompatible: true, nodeVersion: 'v22.0.0', ocVersion: 'OpenClaw 2026.11.3' },
    gateway: { gatewayStatus: 'runtime: ok\nrunning, pid 4242', gatewayPort: 18789, gatewayPid: '4242' },
    logs: { errorLogs: '', stderrLogs: '', gatewayLogTail: '', errLogSizeMB: 0 },
    serviceHealth: { runs: 0, uptimeSeconds: 0, uptimeStr: '', nRestarts: 0 },
    workspace: { workspaceDir: '', hasSoul: true, memoryFiles: 1, codexHome: { matchesExpected: true } },
    ports: { gateway: { valid: true, available: true, listening: false, process: null, pid: null, collector: 'ss' } },
    nativeDoctor: { available: false, findings: [] },
    nativeConfig: { available: false, valid: null, warnings: [], errors: [] },
    nativeStatus: { available: false },
    nativeSecurity: { available: false, findings: [] },
    install,
  };
}

async function makeTemp() {
  const root = join(tmpdir(), `clawfix-npm-install-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}

async function writeNpmPackage(pkg, {
  packageJson = true,
  binFile = true,
  distEntry = true,
  entryName = 'entry.js',
  name = 'openclaw',
  version = '2026.11.3',
  extra = {},
  workspace = false,
  lifecycleMarker = false,
  source = false,
} = {}) {
  await mkdir(join(pkg, 'dist'), { recursive: true });
  if (packageJson) {
    await writeFile(join(pkg, 'package.json'), JSON.stringify({
      name,
      version,
      bin: { openclaw: 'openclaw.mjs' },
      note: SECRET,
      ...extra,
    }));
  }
  if (binFile) await writeFile(join(pkg, 'openclaw.mjs'), '#!/usr/bin/env node\n');
  if (distEntry) await writeFile(join(pkg, 'dist', entryName), 'export {}\n');
  if (workspace) await writeFile(join(pkg, 'pnpm-workspace.yaml'), 'packages:\n');
  if (lifecycleMarker) await writeFile(join(pkg, '.openclaw-lifecycle-pending'), 'pending\n');
  if (source) {
    await mkdir(join(pkg, 'src'), { recursive: true });
    await writeFile(join(pkg, 'src', 'entry.ts'), 'export {}\n');
    await writeFile(join(pkg, '.git'), 'gitdir: /nowhere\n');
    await writeFile(join(pkg, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  }
}

async function linkBin(binDir, target) {
  await mkdir(binDir, { recursive: true });
  const bin = join(binDir, 'openclaw');
  await symlink(relative(binDir, target), bin);
  return bin;
}

async function inspectLayout({ home, binDir, versionText = '' }) {
  return inspectOpenClawInstall({
    pathEnv: binDir,
    fs: fsApi,
    home,
    platform: 'linux',
    versionText,
  });
}

test('the server and CLI classifiers stay identical', () => {
  assert.equal(incompleteFromSecurity.toString(), incompleteFromCore.toString());
  assert.equal(describeFromSecurity.toString(), describeFromCore.toString());
  const samples = [
    null,
    { manager: 'npm', packageJson: true, binTarget: true, distEntry: true, pluginPathMissing: false, lifecycleIncomplete: false },
    { manager: 'npm', packageJson: false, binTarget: true, distEntry: true, packageRoot: '/home/alice/.npm/lib/node_modules/openclaw', version: '2026.11.3' },
    { manager: 'pnpm', packageJson: false },
    { manager: 'source', distEntry: false },
    { manager: 'unknown', packageJson: false },
    { manager: 'npm', packageJson: 'false' },
    { manager: 'npm; rm', packageJson: false },
  ];
  for (const sample of samples) {
    assert.deepEqual(incompleteFromSecurity(sample), incompleteFromCore(sample));
    const detail = incompleteFromSecurity(sample);
    assert.equal(describeFromSecurity(detail), describeFromCore(detail));
  }
});

test('a healthy global npm install does not fire, including published pnpm-workspace.yaml', async (t) => {
  const home = await makeTemp();
  t.after(() => rm(home, { recursive: true, force: true }));
  const pkg = join(home, 'prefix', 'lib', 'node_modules', 'openclaw');
  await writeNpmPackage(pkg, { workspace: true, lifecycleMarker: true });
  const binDir = join(home, 'prefix', 'bin');
  await linkBin(binDir, join(pkg, 'openclaw.mjs'));

  const record = await inspectLayout({ home, binDir });
  assert.equal(record.manager, 'npm');
  assert.equal(record.packageJson, true);
  assert.equal(record.binTarget, true);
  assert.equal(record.distEntry, true);
  assert.equal(record.pluginPathMissing, false);
  assert.equal(record.lifecycleIncomplete, false);
  assert.equal(record.version, '2026.11.3');
  assert.equal(record.packageRoot, '~/prefix/lib/node_modules/openclaw');
  assert.equal(JSON.stringify(record).includes(SECRET), false);
  assert.equal(finding(record), undefined);
  assert.equal(localFinding(record), undefined);
});

test('a missing bin target, package.json, or dist entry fires only for an npm global install', async (t) => {
  const home = await makeTemp();
  t.after(() => rm(home, { recursive: true, force: true }));

  const cases = [
    {
      name: 'missing bin target',
      options: { binFile: false },
      versionText: '',
      missing: ['bin target'],
    },
    {
      name: 'missing package.json',
      options: { packageJson: false },
      versionText: '',
      missing: ['package.json'],
    },
    {
      name: 'truncated package.json',
      options: { packageJson: false },
      rawPackage: '{ "name": "openclaw", "note": "' + SECRET,
      versionText: '',
      missing: ['package.json'],
    },
    {
      name: 'missing dist entry',
      options: { distEntry: false },
      versionText: 'openclaw: missing dist/entry.(m)js (build output).',
      missing: ['dist entry'],
    },
  ];

  for (const [index, item] of cases.entries()) {
    const prefix = join(home, `case-${index}`);
    const pkg = join(prefix, 'lib', 'node_modules', 'openclaw');
    await writeNpmPackage(pkg, item.options);
    if (item.rawPackage) await writeFile(join(pkg, 'package.json'), item.rawPackage);
    const binDir = join(prefix, 'bin');
    await linkBin(binDir, join(pkg, 'openclaw.mjs'));
    const record = await inspectLayout({ home, binDir, versionText: item.versionText });
    const issue = finding(record);
    assert.ok(issue, item.name);
    assert.equal(issue.severity, 'high');
    for (const label of item.missing) assert.match(issue.description, new RegExp(label.replace(/[.]/g, '\\.')));
    assert.match(issue.description, /npm install -g openclaw@2026\.11\.3|npm install -g openclaw@<installed version>/);
    assert.match(issue.description, /openclaw update/);
    assert.match(issue.description, /Config and state are left unchanged/);
    assert.equal(issue.description.includes(SECRET), false);
    assert.equal(issue.description.includes(home), false);
    assert.equal(localFinding(record)?.description, issue.description, item.name);
  }
});

test('dist/entry.mjs alone satisfies the launcher and does not fire', async (t) => {
  const home = await makeTemp();
  t.after(() => rm(home, { recursive: true, force: true }));
  const pkg = join(home, 'prefix', 'lib', 'node_modules', 'openclaw');
  await writeNpmPackage(pkg, { entryName: 'entry.mjs' });
  const binDir = join(home, 'prefix', 'bin');
  await linkBin(binDir, join(pkg, 'openclaw.mjs'));
  const record = await inspectLayout({ home, binDir });
  assert.equal(record.distEntry, true);
  assert.equal(finding(record), undefined);
});

test('pnpm, source checkouts, npm links, and unknown layouts do not fire', async (t) => {
  const home = await makeTemp();
  t.after(() => rm(home, { recursive: true, force: true }));

  const pnpmPkg = join(home, '.local', 'share', 'pnpm', 'global', '5', 'node_modules', '.pnpm', 'openclaw@2026.11.3', 'node_modules', 'openclaw');
  await writeNpmPackage(pnpmPkg, { distEntry: false, packageJson: false });
  const pnpmBin = join(home, '.local', 'share', 'pnpm', 'bin');
  await linkBin(pnpmBin, join(pnpmPkg, 'openclaw.mjs'));
  const pnpmRecord = await inspectLayout({ home, binDir: pnpmBin });
  assert.equal(pnpmRecord.manager, 'pnpm');
  assert.equal(finding(pnpmRecord), undefined);

  const source = join(home, 'src', 'openclaw');
  await writeNpmPackage(source, { distEntry: false, source: true });
  const sourceBin = join(home, 'src', 'bin');
  await linkBin(sourceBin, join(source, 'openclaw.mjs'));
  const sourceRecord = await inspectLayout({ home, binDir: sourceBin });
  assert.equal(sourceRecord.manager, 'source');
  assert.equal(finding(sourceRecord), undefined);

  const linked = join(home, 'linked');
  const linkPrefix = join(linked, 'prefix');
  const linkSource = join(linked, 'checkout');
  await writeNpmPackage(linkSource, { distEntry: false, source: true });
  await mkdir(join(linkPrefix, 'lib', 'node_modules'), { recursive: true });
  await symlink(linkSource, join(linkPrefix, 'lib', 'node_modules', 'openclaw'));
  const linkedBinDir = join(linkPrefix, 'bin');
  await linkBinTo(linkedBinDir, join(linkPrefix, 'lib', 'node_modules', 'openclaw', 'openclaw.mjs'));
  const linkRecord = await inspectLayout({ home, binDir: linkedBinDir });
  assert.equal(linkRecord.manager, 'source');
  assert.equal(finding(linkRecord), undefined);

  const unknownPkg = join(home, 'opt', 'tools', 'openclaw');
  await mkdir(unknownPkg, { recursive: true });
  await writeFile(join(unknownPkg, 'openclaw.mjs'), '#!/usr/bin/env node\n');
  const unknownBin = join(home, 'opt', 'tools', 'bin');
  await linkBin(unknownBin, join(unknownPkg, 'openclaw.mjs'));
  const unknownRecord = await inspectLayout({ home, binDir: unknownBin });
  assert.equal(unknownRecord.manager, 'unknown');
  assert.equal(finding(unknownRecord), undefined);
  assert.equal(localFinding(unknownRecord), undefined);
});

async function linkBinTo(binDir, target) {
  await mkdir(binDir, { recursive: true });
  await symlink(relative(binDir, target), join(binDir, 'openclaw'));
}

test('a bundled plugin path inside the package fires and an outside path does not', async (t) => {
  const home = await makeTemp();
  t.after(() => rm(home, { recursive: true, force: true }));
  const pkg = join(home, 'prefix', 'lib', 'node_modules', 'openclaw');
  await writeNpmPackage(pkg);
  const binDir = join(home, 'prefix', 'bin');
  await linkBin(binDir, join(pkg, 'openclaw.mjs'));
  const inside = `${pkg}/dist/extensions/browser`;
  const outside = `${home}/.openclaw/extensions/custom`;
  const insideRecord = await inspectLayout({
    home,
    binDir,
    versionText: `plugins.load.paths: plugin path not found: ${inside}`,
  });
  const insideIssue = finding(insideRecord);
  assert.ok(insideIssue);
  assert.match(insideIssue.description, /bundled plugin path/);
  assert.equal(insideIssue.description.includes(inside), false);
  assert.equal(insideIssue.description.includes(SECRET), false);

  const outsideRecord = await inspectLayout({
    home,
    binDir,
    versionText: `plugins.load.paths: plugin path not found: ${outside}`,
  });
  assert.equal(outsideRecord.pluginPathMissing, false);
  assert.equal(finding(outsideRecord), undefined);
});

test('the upstream lifecycle failure is advisory and a pending marker alone is not', async (t) => {
  const home = await makeTemp();
  t.after(() => rm(home, { recursive: true, force: true }));
  const pkg = join(home, 'prefix', 'lib', 'node_modules', 'openclaw');
  await writeNpmPackage(pkg, { lifecycleMarker: true });
  const binDir = join(home, 'prefix', 'bin');
  await linkBin(binDir, join(pkg, 'openclaw.mjs'));
  const quiet = await inspectLayout({ home, binDir });
  assert.equal(finding(quiet), undefined);

  const broken = await inspectLayout({
    home,
    binDir,
    versionText: 'openclaw: package lifecycle is incomplete. Reinstall with package scripts enabled, then retry.',
  });
  const issue = finding(broken);
  assert.ok(issue);
  assert.match(issue.description, /package lifecycle/);
  assert.match(issue.fix, /npm install -g openclaw@<installed version>/);
  assert.match(issue.fix, /openclaw update/);
  assert.match(issue.fix, /No config or state was changed/);
  assert.equal(issue.fix.includes('config set'), false);
  assert.equal(issue.fix.includes('openclaw.json'), false);
  assert.equal(issue.fix.includes('rm '), false);
  const validation = validateRepairScript(issue.fix);
  assert.equal(validation.ok, true, JSON.stringify(validation.blockers));
  const normalized = normalizeFindings({
    localIssues: [localFinding(broken)],
    knownRepairIds: ['gateway-not-running'],
  });
  assert.equal(normalized[0].repairable, false);
});

test('hostile install fields cannot inject a path, a version, or another package manager', () => {
  const homePath = incompleteFromSecurity({
    manager: 'npm',
    packageJson: false,
    binTarget: true,
    distEntry: true,
    pluginPathMissing: false,
    lifecycleIncomplete: false,
    packageRoot: '/home/alice/.nvm/versions/node/v22.14.0/lib/node_modules/openclaw',
    version: '2026.11.3; rm -rf /',
  });
  const described = describeFromSecurity(homePath);
  assert.match(described, /~\/\.nvm\/versions\/node\/v22\.14\.0\/lib\/node_modules\/openclaw/);
  assert.equal(described.includes('alice'), false);
  assert.equal(described.includes('rm'), false);
  assert.match(described, /openclaw@<installed version>/);

  const injected = describeFromSecurity(incompleteFromSecurity({
    manager: 'npm',
    packageJson: false,
    packageRoot: '$(rm -rf ~)/lib/node_modules/openclaw',
    version: '$(rm)',
  }));
  assert.equal(injected.includes('rm'), false);
  assert.equal(injected.includes('$'), false);

  assert.equal(finding({ manager: 'pnpm', packageJson: false, binTarget: false, distEntry: false }), undefined);
  assert.equal(finding({ manager: 'yarn', packageJson: false }), undefined);
  assert.equal(finding({ manager: 'bun', packageJson: false }), undefined);
  assert.equal(finding({ manager: 'source', distEntry: false }), undefined);
  assert.equal(finding({ manager: 'unknown', packageJson: false }), undefined);
  assert.equal(finding({ manager: 'npm', packageJson: 'false', binTarget: true, distEntry: true }), undefined);
  assert.equal(localFinding(undefined), undefined);
});

test('the hosted collector matches the CLI inspector and redacts home', async (t) => {
  const home = await makeTemp();
  t.after(() => rm(home, { recursive: true, force: true }));
  const setups = [];

  const healthyPkg = join(home, 'healthy', 'lib', 'node_modules', 'openclaw');
  await writeNpmPackage(healthyPkg, { workspace: true });
  const healthyBin = join(home, 'healthy', 'bin');
  await linkBin(healthyBin, join(healthyPkg, 'openclaw.mjs'));
  setups.push({ binDir: healthyBin, versionErr: '' });

  const brokenPkg = join(home, 'broken', 'lib', 'node_modules', 'openclaw');
  await writeNpmPackage(brokenPkg, { binFile: false });
  const brokenBin = join(home, 'broken', 'bin');
  await linkBin(brokenBin, join(brokenPkg, 'openclaw.mjs'));
  setups.push({
    binDir: brokenBin,
    versionErr: 'openclaw: package lifecycle is incomplete. Reinstall with package scripts enabled.',
  });

  const source = join(home, 'checkout');
  await writeNpmPackage(source, { distEntry: false, source: true });
  const sourceBin = join(home, 'checkout-bin');
  await linkBin(sourceBin, join(source, 'openclaw.mjs'));
  setups.push({ binDir: sourceBin, versionErr: '' });

  const start = DIAGNOSTIC_SCRIPT.indexOf('INSTALL_JSON=null');
  const end = DIAGNOSTIC_SCRIPT.indexOf('# --- Sanitize Config');
  assert.ok(start > 0 && end > start);
  const snippet = DIAGNOSTIC_SCRIPT.slice(start, end);

  for (const setup of setups) {
    const printed = spawnSync('bash', ['-c', `${snippet}\nprintf '%s' "$INSTALL_JSON"`], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${setup.binDir}:${process.env.PATH}`,
        OC_VERSION_LINE: 'OpenClaw 2026.11.3 (abc123def)',
        OC_VERSION_STDERR: setup.versionErr,
        OPENCLAW_BIN: join(setup.binDir, 'openclaw'),
      },
      encoding: 'utf8',
    });
    assert.equal(printed.status, 0, printed.stderr);
    const hosted = JSON.parse(printed.stdout);
    const cli = await inspectLayout({ home, binDir: setup.binDir, versionText: setup.versionErr });
    assert.deepEqual(hosted, cli);
    assert.equal(JSON.stringify(hosted).includes(SECRET), false);
    assert.equal(JSON.stringify(hosted).includes(home), false);
    if (hosted?.packageRoot) assert.match(hosted.packageRoot, /^~\//);
  }
});

test('runDiagnostics uploads the redacted install record and not package notes', async (t) => {
  const home = await makeTemp();
  t.after(() => rm(home, { recursive: true, force: true }));
  const pkg = join(home, 'prefix', 'lib', 'node_modules', 'openclaw');
  await writeNpmPackage(pkg, { binFile: false });
  await writeFile(join(pkg, 'secret.txt'), SECRET);
  const binDir = join(home, 'prefix', 'bin');
  const bin = await linkBin(binDir, join(pkg, 'openclaw.mjs'));
  const deps = {
    version: '0.12.0',
    redact: redactOutbound,
    fs: {
      async exists() { return false; },
      async readJson() { return null; },
      async stat() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      async readdir() { return []; },
      async countMarkdownFiles() { return 0; },
      lstat,
      readlink,
      realpath,
      readFile,
    },
    openclaw: {
      async findExecutable() { return bin; },
      async npmVersion() { return '10.9.2'; },
      async version() { return { status: 1, stdout: '', stderr: 'openclaw: package lifecycle is incomplete. Reinstall with package scripts enabled.\n' }; },
      async gatewayStatusText() { return 'not running'; },
      async gatewayProcesses() { return ''; },
      async readFileTail() { return { text: '' }; },
      async serviceManagerState() { return {}; },
    },
    os: {
      homedir: () => home,
      platform: () => 'linux',
      release: () => 'test',
      arch: () => 'x64',
      hostname: () => 'unit-test-marker-host',
      nodeVersion: () => 'v22.14.0',
    },
    env: { PATH: binDir, HOME: home },
    clock: { now: () => new Date('2026-11-13T00:00:00.000Z') },
    createHash,
    timers: { setTimeout, clearTimeout },
    nativeCollectors: {
      collectOpenClawVersion(_bin, runSync) {
        const result = runSync('openclaw', ['--version'], {});
        return {
          version: '',
          runtimeCompatible: false,
          runtimeRequired: null,
          runtimeCurrent: null,
          error: String(result.stderr || ''),
        };
      },
      collectListeningPort() {
        return { valid: true, available: true, listening: false, process: null, pid: null, collector: 'ss' };
      },
      collectNativeDoctor() {
        return {
          available: true,
          findings: [{
            message: 'plugins.load.paths: plugin path not found: /opt/custom-plugin',
          }],
        };
      },
      collectNativeConfigValidation() {
        return { available: false, valid: null, warnings: [], errors: [] };
      },
      collectNativeStatus() { return { available: false }; },
      collectNativeSecurityAudit() { return { available: false, findings: [] }; },
    },
  };
  const result = await createDiagnosticsCore(deps).runDiagnostics({ revision: 'rev-incomplete-npm' });
  const serialized = JSON.stringify(result.diagnostic);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(result.diagnostic.openclaw.install.manager, 'npm');
  assert.equal(result.diagnostic.openclaw.install.binTarget, false);
  assert.equal(result.diagnostic.openclaw.install.packageRoot, '~/prefix/lib/node_modules/openclaw');
  assert.equal(result.diagnostic.openclaw.install.packageRoot.includes(home), false);
  assert.equal(result.diagnostic.openclaw.install.pluginPathMissing, false);
  const issue = result.issues.find(item => item.knownIssueId === 'incomplete-npm-install');
  assert.ok(issue);
  assert.match(issue.description, /bin target/);
  assert.equal(issue.description.includes(SECRET), false);
});

test('server modules do not import cli/core and the advisory stays out of the repair catalog', async () => {
  const issue = KNOWN_ISSUES.find(item => item.id === 'incomplete-npm-install');
  assert.ok(issue);
  assert.equal(issue.severity, 'high');
  const validation = validateRepairScript(issue.fix);
  assert.equal(validation.ok, true, JSON.stringify(validation.blockers));
  const serverFiles = await import('node:fs/promises').then(fs => fs.readdir(new URL('../src', import.meta.url), { recursive: true }));
  for (const relativeName of serverFiles) {
    if (!String(relativeName).endsWith('.js')) continue;
    const source = await readFile(join(new URL('../src', import.meta.url).pathname, relativeName), 'utf8');
    assert.equal(source.includes('cli/core/'), false, `${relativeName} imports cli/core`);
  }
});
