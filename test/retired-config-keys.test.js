import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  classifyLegacyHeartbeat,
  classifyPluginsInstalls,
  describeLegacyHeartbeat,
  describePluginsInstalls,
} from '../cli/bin/security.js';
import { deriveIssues } from '../cli/core/diagnostics.js';
import { repairCatalog } from '../cli/core/repair-catalog.js';
import { detectIssues } from '../src/known-issues.js';

const heartbeatConfig = {
  agents: {
    defaults: {
      heartbeat: {
        every: '1h',
        activeHours: { start: '08:00', end: '22:00', timezone: 'local' },
        model: 'deepseek/deepseek-v4-flash',
        lightContext: true,
        isolatedSession: true,
      },
    },
  },
};

async function fixture(name) {
  return readFile(new URL(`./fixtures/openclaw-retired-config/${name}`, import.meta.url), 'utf8');
}

function hosted(config, text = '', nativeDoctor = null) {
  return {
    config,
    logs: { errors: text, stderr: '', gatewayLog: '' },
    openclaw: nativeDoctor ? { nativeDoctor } : {},
    ...(nativeDoctor ? { nativeDoctor } : {}),
  };
}

function collected(config, text = '', nativeDoctor = { available: false, timedOut: false, findings: [] }) {
  return {
    config,
    system: { runtimeCompatible: true },
    gateway: { gatewayStatus: 'Connectivity check: ok\nListening: 127.0.0.1:18789', gatewayPort: 18789, gatewayPid: '1' },
    logs: { errorLogs: text, stderrLogs: '', gatewayLogTail: '', errLogSizeMB: 0 },
    serviceHealth: { runs: 0, uptimeSeconds: 0, uptimeStr: '', nRestarts: 0 },
    workspace: { workspaceDir: '', hasSoul: true, memoryFiles: 1 },
    ports: { gateway: { listening: true, pid: 1 } },
    nativeDoctor,
    nativeConfig: { available: false, valid: null, warnings: [], errors: [] },
    nativeStatus: { available: false },
    nativeSecurity: { available: false, findings: [] },
  };
}

test('update admission invalid-config names agents.defaults.heartbeat and does not delete it', async () => {
  const text = await fixture('heartbeat-admission.txt');
  const detail = classifyLegacyHeartbeat({ config: heartbeatConfig, text });
  assert.equal(detail.showKeys, true);
  assert.equal(detail.admission, true);
  assert.ok(detail.paths.includes('agents.defaults.heartbeat'));
  const description = describeLegacyHeartbeat(detail);
  assert.match(description, /agents\.defaults\.heartbeat/);
  assert.match(description, /invalid-config/);
  assert.match(description, /Do not delete the key first/);

  const issue = detectIssues(hosted(heartbeatConfig, text)).find(item => item.id === 'heartbeat-no-model-override');
  assert.ok(issue);
  assert.match(issue.description, /agents\.defaults\.heartbeat/);
  assert.doesNotMatch(issue.fix, /\bjq\b/);
  assert.match(issue.fix, /openclaw doctor --fix/);

  const local = deriveIssues(collected(heartbeatConfig, text)).find(item => item.knownIssueId === 'heartbeat-no-model-override');
  assert.ok(local);
  assert.match(local.description, /agents\.defaults\.heartbeat/);
});

test('a redacted unrecognized key is not renamed to heartbeat, and another key stays separate', async () => {
  const redacted = await fixture('heartbeat-admission.txt');
  const unnamed = classifyLegacyHeartbeat({ config: {}, text: redacted });
  assert.equal(unnamed.redactedAdmission, true);
  assert.deepEqual(unnamed.paths, []);
  assert.match(describeLegacyHeartbeat(unnamed), /agents\.defaults: unrecognized key/);
  assert.doesNotMatch(describeLegacyHeartbeat(unnamed), /agents\.defaults\.heartbeat/);

  const other = await fixture('other-unrecognized-key.txt');
  assert.equal(classifyLegacyHeartbeat({ config: {}, text: other }), null);
  const schema = await fixture('heartbeat-schema.txt');
  const named = classifyLegacyHeartbeat({ config: {}, text: schema });
  assert.ok(named.paths.includes('agents.defaults.heartbeat'));
});

test('per-agent heartbeat and a HEARTBEAT.md escape name the agent path', async () => {
  const text = await fixture('heartbeat-file-escape.txt');
  const config = { agents: { entries: { ops: { heartbeat: { every: '30m', target: 'none' } } } } };
  const detail = classifyLegacyHeartbeat({ config, text });
  assert.ok(detail.paths.includes('agents.entries.ops.heartbeat'));
  assert.equal(detail.fileBlocked, true);
  assert.equal(detail.fileAgent, 'ops');
  assert.match(describeLegacyHeartbeat(detail), /Agent "ops"/);
  assert.match(describeLegacyHeartbeat(detail), /symlink target escapes the agent workspace/);
  assert.ok(detectIssues(hosted(config, text)).some(item => item.id === 'heartbeat-no-model-override'));
});

test('a successful doctor lint replaces the leftover heartbeat finding', async () => {
  const nativeDoctor = {
    available: true,
    timedOut: false,
    findings: [{
      checkId: 'core/doctor/heartbeat-cadence-migration',
      severity: 'warning',
      message: 'Legacy heartbeat state must become ordinary editable automations.',
      path: 'agents.defaults.heartbeat',
      fixHint: 'Run openclaw doctor --fix',
    }],
  };
  const hostedIssues = detectIssues(hosted(heartbeatConfig, '', nativeDoctor));
  const card = hostedIssues.find(item => item.id === 'heartbeat-no-model-override');
  assert.ok(card);
  assert.match(card.description, /Doctor lint already reported the heartbeat migration/);
  assert.match(card.description, /agents\.defaults\.heartbeat/);
  assert.equal(hostedIssues.filter(item => item.id === 'heartbeat-no-model-override').length, 1);

  const local = deriveIssues(collected(heartbeatConfig, '', nativeDoctor));
  assert.equal(local.some(item => item.knownIssueId === 'heartbeat-no-model-override'), false);
  assert.ok(local.some(item => item.nativeCheckId === 'core/doctor/heartbeat-cadence-migration'));

  const timedOut = {
    available: false,
    timedOut: true,
    findings: nativeDoctor.findings,
  };
  assert.ok(deriveIssues(collected(heartbeatConfig, '', timedOut)).some(item => item.knownIssueId === 'heartbeat-no-model-override'));
});

test('plugins.installs names the key, and only an empty object is repairable', async () => {
  const text = await fixture('plugins-installs.txt');
  const fromLog = classifyPluginsInstalls({ text });
  assert.equal(fromLog.path, 'plugins.installs');
  assert.equal(fromLog.empty, false);
  assert.match(describePluginsInstalls(fromLog), /Unrecognized key: "installs"/);
  assert.match(describePluginsInstalls(fromLog), /do not delete it by hand/);

  const empty = classifyPluginsInstalls({ config: { plugins: { installs: {} } } });
  assert.equal(empty.empty, true);
  assert.match(describePluginsInstalls(empty), /empty retired key/);
  const populated = classifyPluginsInstalls({ config: { plugins: { installs: { discord: { spec: 'plugin' } } } } });
  assert.equal(populated.populated, true);
  assert.match(describePluginsInstalls(populated), /does not delete them/);
  assert.equal(classifyPluginsInstalls({ config: { plugins: { entries: {} } } }), null);

  const issue = detectIssues(hosted({ plugins: { installs: {} } }, text)).find(item => item.id === 'plugins-installs-unrecognized');
  assert.ok(issue);
  assert.match(issue.fix, /plugins\.installs == \{\}/);
  assert.match(issue.fix, /config validate/);
  assert.match(issue.description, /plugins\.installs/);
});

test('empty plugins.installs repair backs up, unsets, validates, and restores', async () => {
  const entry = repairCatalog['plugins-installs-unrecognized'];
  const directory = await mkdtemp(join(tmpdir(), 'clawfix-installs-'));
  const configPath = join(directory, 'openclaw.json');
  const backupPath = join(directory, 'openclaw.json.bak');
  await writeFile(configPath, '{"plugins":{"installs":{}}}\n');
  let installs = '{}';
  const calls = [];
  const ctx = {
    async backupConfig() {
      await writeFile(backupPath, await readFile(configPath, 'utf8'));
      return { ok: true, path: backupPath };
    },
    async restoreConfig({ path }) {
      await writeFile(configPath, await readFile(path, 'utf8'));
      installs = '{}';
      return { ok: true };
    },
    openclaw: {
      async configGet() {
        calls.push('get');
        if (installs === null) return { ok: false, value: '', status: 1, errorSummary: 'missing' };
        return { ok: true, value: installs, status: 0, errorSummary: null };
      },
      async configUnset(key) {
        calls.push(['unset', key]);
        installs = null;
        return { status: 0, signal: null, timedOut: false };
      },
      async configValidate() {
        calls.push('validate');
        return { available: true, valid: true, status: 0, errorSummary: null };
      },
    },
  };
  assert.equal((await entry.preflight(ctx)).ok, true);
  const applied = await entry.apply(ctx);
  assert.equal(applied.changed, true);
  assert.equal(applied.backupPath, backupPath);
  assert.deepEqual(calls.filter(call => Array.isArray(call)), [['unset', 'plugins.installs']]);
  assert.equal((await entry.verify(ctx)).ok, true);
  const rolled = await entry.rollback(ctx, { applyResult: applied });
  assert.equal(rolled.rolledBack, true);
  assert.equal(await readFile(configPath, 'utf8'), '{"plugins":{"installs":{}}}\n');

  installs = '{"discord":{"spec":"plugin"}}';
  const blocked = await entry.preflight(ctx);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'plugins_installs_not_empty');

  installs = '{}';
  const invalid = {
    ...ctx,
    openclaw: {
      ...ctx.openclaw,
      async configValidate() {
        return { available: true, valid: false, status: 1, errorSummary: null };
      },
    },
  };
  const rejected = await entry.apply(invalid);
  assert.equal(rejected.error, true);
  assert.match(rejected.errorSummary, /config validate/);
  assert.equal(installs, '{}');
  await rm(directory, { recursive: true, force: true });
});
