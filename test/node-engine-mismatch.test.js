import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { collectNodeRuntimes, collectOpenClawVersion } from '../cli/bin/native-diagnostics.js';
import {
  FALLBACK_NODE_ENGINE,
  classifyNodeEngineMismatch,
  describeNodeEngineMismatch,
  nodeSatisfiesEngine,
  retainDiagnosticLogLine,
} from '../cli/bin/security.js';
import { deriveIssues } from '../cli/core/diagnostics.js';
import { repairCatalog } from '../cli/core/repair-catalog.js';
import { detectIssues } from '../src/known-issues.js';
import { DIAGNOSTIC_SCRIPT } from '../src/routes/script.js';

async function fixture(name) {
  return readFile(new URL(`./fixtures/openclaw-node-engine/${name}`, import.meta.url), 'utf8');
}

function findingFor(text, extra = {}) {
  return detectIssues({
    openclaw: { versionError: text, ...extra },
    logs: { errors: text },
    config: {},
  }).find(issue => issue.id === 'openclaw-node-engine-mismatch');
}

test('engine comparison follows the documented Node range', () => {
  assert.equal(FALLBACK_NODE_ENGINE, '>=24.22.1 <25 || >=26.12.1');
  for (const version of ['24.22.1', '24.22.2', '26.12.1', '26.13.0']) {
    assert.equal(nodeSatisfiesEngine(version, FALLBACK_NODE_ENGINE), true, version);
  }
  for (const version of ['22.22.3', '23.11.0', '24.19.0', '24.22.0', '25.0.0', '25.1.0', '26.8.2', '26.12.0']) {
    assert.equal(nodeSatisfiesEngine(version, FALLBACK_NODE_ENGINE), false, version);
  }
});

test('Companion tools node 24.19.0 is named and is not installed over', async () => {
  const text = await fixture('companion-24.19.0.txt');
  const issue = findingFor(text);
  assert.ok(issue);
  assert.equal(issue.severity, 'critical');
  assert.equal(issue.kind, 'failure');
  assert.match(issue.description, /~\/\.openclaw\/tools\/node-v24\.19\.0\/bin\/node/);
  assert.match(issue.description, /24\.19\.0/);
  assert.match(issue.description, /outside the supported range/);
  assert.match(issue.description, />=24\.22\.1 <25 \|\| >=26\.12\.1/);
  assert.match(issue.description, /OpenClaw version check/);
  assert.match(issue.description, /Update Companion/);
  assert.match(issue.description, /ClawFix does not install or switch Node/);
  assert.match(issue.fix, /does not install or switch Node/i);
  assert.doesNotMatch(issue.fix, /nvm|brew install|apt install|choco/i);
  assert.equal(repairCatalog['openclaw-node-engine-mismatch'], undefined);
});

test('a Homebrew shell node outside the range is lower severity when the gateway node is inside it', async () => {
  const text = await fixture('homebrew-26.8.2-gateway-ok.txt');
  assert.equal(retainDiagnosticLogLine(text.split('\n')[1]), true);
  const issue = findingFor(text);
  assert.ok(issue);
  assert.equal(issue.severity, 'medium');
  assert.equal(issue.kind, 'warning');
  assert.match(issue.description, /\/opt\/homebrew\/Cellar\/node\/26\.8\.2\/bin\/node/);
  assert.match(issue.description, /Shell node 26\.8\.2/);
  assert.match(issue.description, /outside the supported range/);
  assert.match(issue.description, /Gateway service node 24\.22\.1/);
  assert.match(issue.description, /inside the supported range/);
  assert.match(issue.description, /lower severity/);
  assert.match(issue.description, /does not change PATH/);
  const local = deriveIssues({
    config: {},
    system: { runtimeCompatible: true, runtimeRequired: null, runtimeCurrent: null },
    gateway: { gatewayStatus: 'running', gatewayPort: 18789, gatewayPid: '9' },
    logs: { errorLogs: text, stderrLogs: '', gatewayLogTail: '', errLogSizeMB: 0 },
    serviceHealth: { runs: 1, uptimeSeconds: 10, uptimeStr: '10s', nRestarts: 0 },
    workspace: { workspaceDir: '/w', hasSoul: true, memoryFiles: 1 },
    ports: { gateway: { listening: true, pid: 9 } },
    nativeDoctor: { available: true, findings: [] },
    nativeConfig: { available: true, valid: true, errors: [] },
    nativeStatus: { available: true, gateway: { reachable: true } },
    nativeSecurity: { available: true, findings: [] },
  }).find(item => item.knownIssueId === 'openclaw-node-engine-mismatch');
  assert.equal(local.severity, 'medium');
  assert.match(local.description, /lower severity/);
});

test('Companion installer Node 22.22.3 stays unsupported against the current range', async () => {
  const issue = findingFor(await fixture('companion-22.22.3.txt'));
  assert.ok(issue);
  assert.equal(issue.severity, 'critical');
  assert.match(issue.description, /Companion/);
  assert.match(issue.description, /22\.22\.3/);
  assert.match(issue.description, /Node 22, 23, and 25 are outside the range/);
  assert.match(issue.description, /24\.22\.1\+ or 26\.12\.1\+/);
  assert.match(issue.description, /documented fallback/);
  assert.equal(issue.description.includes('24.16.0'), false);
});

test('supported shell and gateway nodes produce no finding', async () => {
  assert.equal(findingFor(await fixture('supported-24.22.1.txt')), undefined);
  assert.equal(findingFor(await fixture('supported-26.12.1.txt')), undefined);
  assert.equal(findingFor('node version check timed out'), undefined);
  assert.equal(findingFor(''), undefined);
});

test('a failing gateway node stays critical, and an unknown gateway does not lower severity', () => {
  const gatewayBad = classifyNodeEngineMismatch({
    text: [
      'detected: Node 24.22.1 at /opt/homebrew/Cellar/node/24.22.1/bin/node',
      'Active Gateway runtime: node=v22.22.3',
    ].join('\n'),
  });
  assert.equal(gatewayBad.severity, 'critical');
  assert.equal(gatewayBad.gatewayCompatible, false);
  assert.match(describeNodeEngineMismatch(gatewayBad), /Gateway service node 22\.22\.3/);
  assert.match(describeNodeEngineMismatch(gatewayBad), /Edit the LaunchAgent plist, systemd unit, or scheduled task/);
  assert.equal(describeNodeEngineMismatch(gatewayBad).includes('lower severity'), false);

  const unknownGateway = classifyNodeEngineMismatch({
    text: 'detected: Node 26.8.2 at /opt/homebrew/Cellar/node/26.8.2/bin/node',
  });
  assert.equal(unknownGateway.gatewayCompatible, null);
  assert.equal(unknownGateway.severity, 'critical');
});

test('installed package.json engines override the documented fallback', () => {
  const loose = classifyNodeEngineMismatch({
    engines: '>=24.16.0 <25 || >=26.1.0',
    runtimes: [{ source: 'companion', path: '~/.openclaw/tools/node-v24.19.0/bin/node', version: '24.19.0' }],
  });
  assert.equal(loose, null);
  const strict = classifyNodeEngineMismatch({
    engines: '>=24.22.1 <25 || >=26.12.1',
    runtimes: [{ source: 'companion', path: '~/.openclaw/tools/node-v24.19.0/bin/node', version: '24.19.0' }],
  });
  assert.equal(strict.enginesSource, 'package.json engines.node');
  assert.equal(strict.severity, 'critical');
  const olderPackage = classifyNodeEngineMismatch({
    engines: '>=20.0.0',
    runtimes: [{ source: 'shell', path: '/usr/local/bin/node', version: '22.22.3' }],
  });
  assert.equal(olderPackage, null);
});

test('home-directory usernames are redacted from node paths', async () => {
  const issue = findingFor(await fixture('home-username.txt'));
  assert.match(issue.description, /~\/\.openclaw\/tools\/node-v24\.19\.0\/bin\/node/);
  assert.equal(issue.description.includes('ada'), false);
  assert.equal(issue.description.includes('/home/'), false);
  const windows = classifyNodeEngineMismatch({
    text: 'detected Node 24.19.0\nexec: C:\\Users\\ada\\.openclaw\\tools\\node-v24.19.0\\bin\\node',
  });
  const described = describeNodeEngineMismatch(windows);
  assert.match(described, /~\\\.openclaw\\tools\\node-v24\.19\.0\\bin\\node/);
  assert.equal(described.includes('ada'), false);
  const users = classifyNodeEngineMismatch({
    text: 'detected Node 24.19.0\nexec: /Users/ada/.openclaw/tools/node-v24.19.0/bin/node',
  });
  assert.equal(describeNodeEngineMismatch(users).includes('ada'), false);
  assert.match(describeNodeEngineMismatch(users), /~\/\.openclaw\/tools\/node-v24\.19\.0\/bin\/node/);
});

test('openclaw --version errors keep the required range and the detected version', () => {
  const classic = collectOpenClawVersion('/usr/local/bin/openclaw', () => ({
    status: 1,
    stdout: '',
    stderr: 'openclaw: Node.js >=24.15.0 <25 is required (current: v24.11.1).',
  }));
  assert.equal(classic.runtimeRequired, '>=24.15.0 <25');
  assert.equal(classic.runtimeCurrent, 'v24.11.1');
  const released = collectOpenClawVersion('/usr/local/bin/openclaw', () => ({
    status: 1,
    stdout: '',
    stderr: 'this OpenClaw release requires Node >=24.22.1 <25 || >=26.12.1\ndetected Node 24.19.0\n',
  }));
  assert.equal(released.runtimeCompatible, false);
  assert.equal(released.runtimeRequired, '>=24.22.1 <25 || >=26.12.1');
  assert.equal(released.runtimeCurrent, '24.19.0');
  const unsupported = collectOpenClawVersion('/usr/local/bin/openclaw', () => ({
    status: 1,
    stdout: '',
    stderr: 'ERROR: Node 22.22.3 is unsupported; use Node 24.16.0+ or Node 26.1.0+.',
  }));
  assert.equal(unsupported.runtimeCurrent, '22.22.3');
  assert.equal(unsupported.runtimeRequired, null);
});

test('the collector reads the service definition, Companion tools node, and package engines', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clawfix-node-engine-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const packageRoot = join(root, 'lib', 'node_modules', 'openclaw');
  await mkdir(join(home, '.openclaw', 'tools', 'node-v24.19.0', 'bin'), { recursive: true });
  await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(home, '.openclaw', 'tools', 'node-v24.19.0', 'bin', 'node'), '');
  await writeFile(join(home, 'Library', 'LaunchAgents', 'ai.openclaw.gateway.plist'), `<?xml version="1.0"?>
<plist><dict><key>ProgramArguments</key><array>
<string>/opt/homebrew/Cellar/node/24.22.1/bin/node</string>
<string>/usr/local/lib/node_modules/openclaw/dist/index.js</string>
</array></dict></plist>
`);
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({
    name: 'openclaw',
    engines: { node: '>=24.22.1 <25 || >=26.12.1' },
  })}\n`);
  await writeFile(join(packageRoot, 'openclaw'), '#!/bin/sh\n');
  const calls = [];
  const facts = collectNodeRuntimes({
    home,
    openclawBin: join(packageRoot, 'openclaw'),
    runSync(executable, args) {
      calls.push([executable, args]);
      if (executable.endsWith('/node-v24.19.0/bin/node')) return { status: 0, stdout: 'v24.19.0\n', stderr: '' };
      if (executable === '/opt/homebrew/Cellar/node/24.22.1/bin/node') return { status: 0, stdout: 'v24.22.1\n', stderr: '' };
      return { status: 1, stdout: '', stderr: 'missing' };
    },
  });
  assert.equal(facts.engines, '>=24.22.1 <25 || >=26.12.1');
  const gateway = facts.runtimes.find(runtime => runtime.source === 'gateway');
  const companion = facts.runtimes.find(runtime => runtime.source === 'companion');
  const shell = facts.runtimes.find(runtime => runtime.source === 'shell');
  assert.equal(gateway.version, '24.22.1');
  assert.equal(gateway.path, '/opt/homebrew/Cellar/node/24.22.1/bin/node');
  assert.equal(companion.version, '24.19.0');
  assert.match(companion.path, /~\/\.openclaw\/tools\/node-v24\.19\.0\/bin\/node$/);
  assert.doesNotMatch(shell.path, /\/(?:home|Users)\/[^/]+/);
  assert.equal(calls.some(call => call[0] === 'ps'), false);

  const task = collectNodeRuntimes({
    home: join(root, 'empty-home'),
    platform: 'win32',
    runSync(executable) {
      if (executable === 'schtasks') {
        return {
          status: 0,
          stdout: '<Command>C:\\Users\\ada\\AppData\\Local\\node\\node.exe</Command>',
          stderr: '',
        };
      }
      if (executable === 'C:\\Users\\ada\\AppData\\Local\\node\\node.exe') {
        return { status: 0, stdout: 'v22.22.3\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    },
  });
  const taskNode = task.runtimes.find(runtime => runtime.source === 'gateway');
  assert.equal(taskNode.version, '22.22.3');
  assert.equal(taskNode.path.includes('ada'), false);
  assert.match(taskNode.path, /node\.exe$/);
});

test('the hosted script reports the same node facts and does not switch Node', async (t) => {
  const start = DIAGNOSTIC_SCRIPT.indexOf('NODE_RUNTIMES_JSON=null');
  const end = DIAGNOSTIC_SCRIPT.indexOf('# --- Build Diagnostic Payload ---');
  assert.ok(start > 0 && end > start);
  const snippet = DIAGNOSTIC_SCRIPT.slice(start, end);
  assert.match(snippet, /schtasks/);
  assert.match(snippet, /ai\.openclaw\.gateway\.plist/);
  assert.match(snippet, /openclaw-gateway\.service/);
  assert.match(snippet, /\.openclaw', 'tools'/);
  assert.equal(snippet.includes('cli/core/'), false);
  assert.equal(snippet.includes('nvm install'), false);
  assert.match(DIAGNOSTIC_SCRIPT, /"nodeRuntimes": \$NODE_RUNTIMES_JSON/);
  assert.match(DIAGNOSTIC_SCRIPT, /preflight-node-runtime/);

  const root = await mkdtemp(join(tmpdir(), 'clawfix-hosted-node-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const packageRoot = join(root, 'lib', 'node_modules', 'openclaw');
  const gatewayNode = join(root, 'gw', 'bin', 'node');
  await mkdir(join(home, '.openclaw', 'tools', 'node-v24.19.0', 'bin'), { recursive: true });
  await mkdir(join(home, '.config', 'systemd', 'user'), { recursive: true });
  await mkdir(join(root, 'gw', 'bin'), { recursive: true });
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(home, '.openclaw', 'tools', 'node-v24.19.0', 'bin', 'node'), '#!/bin/sh\nprintf \'v24.19.0\\n\'\n');
  await writeFile(gatewayNode, '#!/bin/sh\nprintf \'v24.22.1\\n\'\n');
  await writeFile(join(home, '.config', 'systemd', 'user', 'openclaw-gateway.service'), `[Service]\nExecStart=${gatewayNode} gateway\n`);
  await writeFile(join(packageRoot, 'package.json'), '{"name":"openclaw","engines":{"node":">=24.22.1 <25 || >=26.12.1"}}\n');
  await writeFile(join(packageRoot, 'openclaw'), '#!/bin/sh\n');
  const { chmod } = await import('node:fs/promises');
  await chmod(join(home, '.openclaw', 'tools', 'node-v24.19.0', 'bin', 'node'), 0o755);
  await chmod(gatewayNode, 0o755);
  const printed = spawnSync('bash', ['-c', `${snippet}\nprintf '%s' "$NODE_RUNTIMES_JSON"`], {
    env: {
      ...process.env,
      HOME: home,
      OPENCLAW_BIN: join(packageRoot, 'openclaw'),
      GATEWAY_PID: '',
      OC_VERSION_STDERR: 'detected Node 24.19.0 at /home/ada/.openclaw/tools/node-v24.19.0/bin/node',
    },
    encoding: 'utf8',
  });
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout.includes('ada'), false);
  const facts = JSON.parse(printed.stdout);
  assert.equal(facts.engines, '>=24.22.1 <25 || >=26.12.1');
  const issue = findingFor(facts.versionError, { nodeRuntimes: facts });
  assert.equal(issue.severity, 'medium');
  assert.match(issue.description, /24\.19\.0/);
  assert.match(issue.description, /Gateway service node 24\.22\.1/);
  assert.match(issue.description, /lower severity/);
  assert.equal(issue.description.includes('ada'), false);
});
