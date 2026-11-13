import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  compareOpenClawVersions as compareFromSecurity,
  configWrittenByNewerVersion as mismatchFromSecurity,
  describeConfigWrittenByNewerVersion as describeFromSecurity,
  parsePrintedOpenClawVersion as parsePrintedFromSecurity,
  parseStoredOpenClawVersion as parseStoredFromSecurity,
} from '../cli/bin/security.js';
import {
  compareOpenClawVersions as compareFromCore,
  configWrittenByNewerVersion as mismatchFromCore,
  deriveIssues,
  describeConfigWrittenByNewerVersion as describeFromCore,
  parsePrintedOpenClawVersion as parsePrintedFromCore,
  parseStoredOpenClawVersion as parseStoredFromCore,
} from '../cli/core/diagnostics.js';
import { normalizeFindings } from '../cli/core/findings.js';
import { detectIssues, KNOWN_ISSUES } from '../src/known-issues.js';
import { validateRepairScript } from '../src/repair-validator.js';
import { DIAGNOSTIC_SCRIPT } from '../src/routes/script.js';

const PROVIDER_SECRET = 'sk-test-provider-secret-value';
const COMMIT = 'abc123def';
const MIGRATION_MARKER = 'migration-marker-not-a-version';

function finding(diagnostic) {
  return detectIssues(diagnostic).find(issue => issue.id === 'config-written-by-newer-version');
}

function collected(config, ocVersion) {
  return {
    config,
    system: { runtimeCompatible: true, nodeVersion: 'v22.0.0', ocVersion },
    gateway: {
      gatewayStatus: 'runtime: ok\nrunning, pid 4242',
      gatewayPort: 18789,
      gatewayPid: '4242',
    },
    logs: { errorLogs: '', stderrLogs: '', gatewayLogTail: '', errLogSizeMB: 0 },
    serviceHealth: { runs: 0, uptimeSeconds: 0, uptimeStr: '', nRestarts: 0 },
    workspace: { workspaceDir: '', hasSoul: true, memoryFiles: 1, codexHome: { matchesExpected: true } },
    ports: {
      gateway: {
        valid: true, available: true, listening: false, process: null, pid: null, collector: 'ss',
      },
    },
    nativeDoctor: { available: false, findings: [] },
    nativeConfig: { available: false, valid: null, warnings: [], errors: [] },
    nativeStatus: { available: false },
    nativeSecurity: { available: false, findings: [] },
  };
}

function configWith(version, extra = {}) {
  return {
    meta: version === undefined ? undefined : { lastTouchedVersion: version, ...extra },
    gateway: { port: 18789, auth: { mode: 'token', token: PROVIDER_SECRET } },
    agents: {
      defaults: {
        contextPruning: { mode: 'cache-ttl' },
        compaction: { memoryFlush: { enabled: true } },
      },
    },
  };
}

function diagnostic(cli, touched) {
  return {
    openclaw: { version: cli },
    config: touched === undefined ? {} : configWith(touched),
  };
}

function localIssue(cli, touched) {
  return deriveIssues(collected(touched === undefined ? {} : configWith(touched), cli))
    .find(issue => issue.knownIssueId === 'config-written-by-newer-version');
}

test('a newer config writer is advisory and names only the two versions', () => {
  const cli = `OpenClaw 2026.11.3 (${COMMIT})`;
  const issue = finding(diagnostic(cli, '2026.11.5'));
  assert.ok(issue);
  assert.equal(issue.severity, 'medium');
  assert.match(issue.description, /written by 2026\.11\.5/);
  assert.match(issue.description, /installed CLI 2026\.11\.3/);
  assert.match(issue.description, /which -a openclaw/);
  assert.match(issue.description, /matching backup/);
  assert.match(issue.description, /No config is written/);
  assert.equal(issue.description.includes(COMMIT), false);
  assert.equal(issue.description.includes(PROVIDER_SECRET), false);
  assert.equal(issue.description.includes(MIGRATION_MARKER), false);
  assert.equal(issue.fix.includes('openclaw.json'), false);
  assert.match(issue.fix, /which -a openclaw/);
  assert.match(issue.fix, /No config changes were made/);
  assert.equal(issue.fix.includes('config set'), false);
  const validation = validateRepairScript(issue.fix);
  assert.equal(validation.ok, true, JSON.stringify(validation.blockers));

  const local = localIssue(cli, '2026.11.5');
  assert.ok(local);
  assert.equal(local.description, issue.description);
  assert.equal(local.description.includes(COMMIT), false);
  const normalized = normalizeFindings({
    localIssues: [local],
    knownRepairIds: ['gateway-not-running'],
  });
  assert.equal(normalized[0].repairable, false);
  assert.equal(normalized[0].repairId, undefined);
});

test('equal and older config writers do not fire', () => {
  for (const [cli, touched] of [
    ['2026.11.5', '2026.11.5'],
    ['OpenClaw 2026.11.5', '2026.11.5'],
    [`OpenClaw 2026.11.5 (${COMMIT})`, '2026.11.5'],
    ['v2026.11.5', '2026.11.5'],
    ['2026.11.5', '2026.11.3'],
    ['2026.11.5', '2026.11.5-beta.2'],
    ['2026.11.5-1', '2026.11.5'],
    ['2026.11.5-beta.2', '2026.11.5-beta.2'],
    ['2026.11.5-beta.2', '2026.11.5-beta.1'],
    ['2026.11.5-beta.2', '2026.11.5-alpha.9'],
    ['2026.11.10', '2026.11.9'],
  ]) {
    assert.equal(finding(diagnostic(cli, touched)), undefined, `${cli} vs ${touched}`);
    assert.equal(localIssue(cli, touched), undefined, `local ${cli} vs ${touched}`);
  }
});

test('prerelease and correction ordering fires only when the config writer is newer', () => {
  const newer = [
    ['2026.11.3', '2026.11.5-beta.2'],
    ['2026.6.5', '2026.6.6-beta.1'],
    ['2026.11.5-beta.1', '2026.11.5-beta.2'],
    ['2026.11.5-beta.2', '2026.11.5-beta.10'],
    ['2026.11.5-alpha.3', '2026.11.5-beta.1'],
    ['2026.11.5-beta.2', '2026.11.5'],
    ['2026.11.5.beta.1', '2026.11.5-beta.2'],
    ['OpenClaw 2026.11.5-beta.2 (abc123def)', '2026.11.5'],
    ['  2026.11.5-beta.2  ', '  2026.11.5  '],
    ['2026.11.5', '2026.11.5-1'],
    ['2026.11.5-1', '2026.11.5-2'],
    ['2026.11.5-beta.1', '2026.11.5-1'],
  ];
  for (const [cli, touched] of newer) {
    const issue = finding(diagnostic(cli, touched));
    assert.ok(issue, `${cli} vs ${touched}`);
    assert.equal(issue.description.includes(COMMIT), false);
    assert.equal(issue.description.includes(PROVIDER_SECRET), false);
    assert.equal(localIssue(cli, touched)?.description, issue.description);
  }

  const stableOverBeta = finding(diagnostic('2026.11.5-beta.2', '2026.11.5'));
  assert.match(stableOverBeta.description, /written by 2026\.11\.5/);
  assert.match(stableOverBeta.description, /installed CLI 2026\.11\.5-beta\.2/);
  const legacy = finding(diagnostic('2026.11.5.beta.1', '2026.11.5-beta.2'));
  assert.match(legacy.description, /written by 2026\.11\.5-beta\.2/);
  assert.match(legacy.description, /installed CLI 2026\.11\.5-beta\.1/);
});

test('missing meta and unparsable versions do not fire', () => {
  assert.equal(finding({ openclaw: { version: '2026.11.3' }, config: {} }), undefined);
  assert.equal(finding({ openclaw: { version: '2026.11.3' }, config: { meta: {} } }), undefined);
  assert.equal(finding({ openclaw: { version: '2026.11.3' }, config: { meta: null } }), undefined);
  assert.equal(finding({ openclaw: { version: '2026.11.3' } }), undefined);
  assert.equal(finding(diagnostic('2026.11.3', undefined)), undefined);

  const unparsable = [
    ['', '2026.11.5'],
    ['unknown', '2026.11.5'],
    ['OpenClaw', '2026.11.5'],
    ['OpenClaw 2026.11.3 extra', '2026.11.5'],
    ['1.2.3', '2026.11.5'],
    ['9.9.9-fake', '2026.11.5'],
    ['2026.11.3', ''],
    ['2026.11.3', 'dev'],
    ['2026.11.3', '2026.13.1'],
    ['2026.11.3', '2026.11.0'],
    ['2026.11.3', '2026.11.5-rc.1'],
    ['2026.11.3', '2026.11.5-beta'],
    ['2026.11.3', '2026.11.5-beta.0'],
    ['2026.11.3', '2026.11.5+build'],
    ['2026.11.3', '2026.11.05'],
    ['2026.11.3', `2026.11.5 ${PROVIDER_SECRET}`],
    ['2026.11.3', 'prefix 2026.11.5'],
    ['2026.11.3', 20261105],
    ['2026.11.3', { version: '2026.11.5' }],
  ];
  for (const [cli, touched] of unparsable) {
    const config = touched === undefined ? {} : { meta: { lastTouchedVersion: touched } };
    assert.equal(
      finding({ openclaw: { version: cli }, config }),
      undefined,
      `${JSON.stringify(cli)} vs ${JSON.stringify(touched)}`,
    );
    if (typeof cli === 'string' && (touched === undefined || typeof touched === 'string')) {
      assert.equal(localIssue(cli, typeof touched === 'string' ? touched : undefined), undefined);
    }
  }

  const markerConfig = configWith('not-a-version', { note: MIGRATION_MARKER });
  assert.equal(finding({ openclaw: { version: '2026.11.3' }, config: markerConfig }), undefined);
  assert.equal(localIssue('2026.11.3', 'not-a-version'), undefined);
});

test('dedicated version fields are whole versions and a hostile field falls back', () => {
  const fromFields = mismatchFromSecurity({
    openclaw: {
      version: `OpenClaw 2026.11.9 (${COMMIT})`,
      cliVersion: '2026.11.3',
      configLastTouchedVersion: '2026.11.5',
    },
    config: { meta: { lastTouchedVersion: '2026.1.1', note: PROVIDER_SECRET } },
  });
  assert.deepEqual(fromFields, { cliVersion: '2026.11.3', configVersion: '2026.11.5' });
  const described = describeFromSecurity(fromFields);
  assert.equal(described.includes(COMMIT), false);
  assert.equal(described.includes(PROVIDER_SECRET), false);
  assert.equal(described.includes('2026.11.9'), false);
  assert.equal(described.includes('2026.1.1'), false);

  const hostile = mismatchFromSecurity({
    openclaw: {
      version: 'OpenClaw 2026.11.3',
      cliVersion: '2026.11.3; rm -rf',
      configLastTouchedVersion: '$(rm)',
    },
    config: { meta: { lastTouchedVersion: '2026.11.5' } },
  });
  assert.deepEqual(hostile, { cliVersion: '2026.11.3', configVersion: '2026.11.5' });
  assert.equal(describeFromSecurity(hostile).includes('rm'), false);
});

test('the server version comparator stays identical to the CLI core copy', async () => {
  const samples = [
    '2026.11.3',
    ' 2026.11.5-beta.2 ',
    'v2026.11.5',
    '2026.11.5.beta.2',
    '2026.11.5-alpha.1',
    '2026.11.5-1',
    '2026.13.1',
    '2026.11.0',
    '2026.11.5-beta.0',
    '2026.11.05',
    '1.2.3',
    'unknown',
    '',
    null,
    202611,
    `OpenClaw 2026.11.3 (${COMMIT})`,
    'OpenClaw 2026.11.5-beta.2',
    'OpenClaw 2026.11.3 extra',
  ];
  for (const sample of samples) {
    assert.equal(parseStoredFromSecurity(sample), parseStoredFromCore(sample));
    assert.equal(parsePrintedFromSecurity(sample), parsePrintedFromCore(sample));
  }
  const pairs = [
    ['2026.11.3', '2026.11.5'],
    ['2026.11.5', '2026.11.5'],
    ['2026.11.5-beta.1', '2026.11.5-beta.2'],
    ['2026.11.5-beta.2', '2026.11.5'],
    ['2026.11.5', '2026.11.5-1'],
    ['2026.11.5.beta.1', '2026.11.5-beta.2'],
    ['2026.6.5', '2026.6.6-beta.1'],
    ['not-a-version', '2026.11.5'],
  ];
  for (const [left, right] of pairs) {
    assert.equal(compareFromSecurity(left, right), compareFromCore(left, right), `${left} vs ${right}`);
  }
  const diagnosticPayload = diagnostic(`OpenClaw 2026.11.3 (${COMMIT})`, '2026.11.5-beta.2');
  const securityMismatch = mismatchFromSecurity(diagnosticPayload);
  const coreMismatch = mismatchFromCore(diagnosticPayload);
  assert.deepEqual(securityMismatch, coreMismatch);
  assert.equal(describeFromSecurity(securityMismatch), describeFromCore(coreMismatch));
  assert.equal(describeFromSecurity(securityMismatch).includes(COMMIT), false);

  const serverFiles = await readdir(new URL('../src', import.meta.url), { recursive: true });
  for (const relative of serverFiles) {
    if (!String(relative).endsWith('.js')) continue;
    const source = await readFile(join(new URL('../src', import.meta.url).pathname, relative), 'utf8');
    assert.equal(source.includes('cli/core/'), false, `${relative} imports cli/core`);
  }
});

test('the hosted collector uploads the version token and not the commit', async (t) => {
  const start = DIAGNOSTIC_SCRIPT.indexOf('OC_VERSION_LINE=""');
  const end = DIAGNOSTIC_SCRIPT.indexOf('# --- Sanitize Config');
  assert.ok(start > 0 && end > start);
  const snippet = DIAGNOSTIC_SCRIPT.slice(start, end);
  const directory = await mkdtemp(join(tmpdir(), 'clawfix-oc-version-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'openclaw');
  await writeFile(bin, '#!/bin/sh\nprintf "%s\\n" "OpenClaw 2026.11.5-beta.2 (abc123def)"\n');
  await chmod(bin, 0o755);
  const result = spawnSync('bash', ['-c', `${snippet}\nprintf 'PAYLOAD:%s' "$OC_VERSION"`], {
    env: {
      ...process.env,
      OPENCLAW_BIN: bin,
      OS_NAME: 'Linux',
      OS_VERSION: 'test',
      OS_ARCH: 'x64',
      NODE_VERSION: 'v22.0.0',
      NPM_VERSION: '10.0.0',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OpenClaw: OpenClaw 2026\.11\.5-beta\.2 \(abc123def\)/);
  assert.match(result.stdout, /PAYLOAD:2026\.11\.5-beta\.2$/);
  assert.equal(result.stdout.includes('PAYLOAD:2026.11.5-beta.2 (abc123def)'), false);
});

test('the newer-config advisory stays out of the executable catalog', () => {
  const issue = KNOWN_ISSUES.find(item => item.id === 'config-written-by-newer-version');
  assert.ok(issue);
  assert.equal(issue.severity, 'medium');
  assert.equal(issue.fix.includes('openclaw.json'), false);
  assert.equal(issue.fix.includes('config set'), false);
  assert.match(issue.fix, /No config changes were made/);
});
