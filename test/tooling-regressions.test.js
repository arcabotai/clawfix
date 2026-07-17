import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const json = async path => JSON.parse(await read(path));

test('root package is private and version-coherent with the publishable CLI', async () => {
  const [rootPackage, cliPackage, cliSource] = await Promise.all([
    json('package.json'),
    json('cli/package.json'),
    read('cli/bin/clawfix.js'),
  ]);

  assert.equal(rootPackage.private, true);
  assert.equal(rootPackage.version, cliPackage.version);
  assert.match(cliSource, /new URL\(['"]\.\.\/package\.json['"], import\.meta\.url\)/);
  assert.match(cliSource, new RegExp(`return ['"]${cliPackage.version.replaceAll('.', '\\.') }['"]`));
});

test('CI packs and allowlist-validates the publishable cli package', async () => {
  const ci = await read('.github/workflows/ci.yml');
  assert.match(ci, /npm pack \.\/cli --dry-run --json/);
  assert.match(ci, /verify-cli-package\.mjs/);
  assert.doesNotMatch(ci, /run: npm pack --dry-run --json/);
});

test('release installs from lockfile and runs every pre-publish gate', async () => {
  const release = await read('.github/workflows/release.yml');
  assert.match(release, /run: npm ci/);
  assert.match(release, /run: npm test/);
  assert.match(release, /npm run validate:repairs/);
  assert.match(release, /npm audit --omit=dev/);
  assert.match(release, /node --check cli\/bin\/native-diagnostics\.js/);
  assert.match(release, /verify-cli-package\.mjs/);
  assert.match(release, /npm publish --access public --provenance/);
});

test('Docker build is strict, least-privilege, and copies only runtime inputs', async () => {
  const [dockerfile, dockerignore] = await Promise.all([
    read('Dockerfile'),
    read('.dockerignore'),
  ]);

  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /COPY --chown=node:node src \.\/src/);
  assert.match(dockerfile, /COPY --chown=node:node cli\/bin\/security\.js \.\/cli\/bin\/security\.js/);
  assert.match(dockerfile, /RUN node -e .*import\('\.\/src\/server\.js'\)/);
  assert.match(dockerfile, /^HEALTHCHECK /m);
  assert.doesNotMatch(dockerfile, /^COPY \. \.$/m);
  assert.match(dockerignore, /^\*$/m);
  for (const allowed of ['!package.json', '!package-lock.json', '!src/**', '!cli/bin/security.js']) {
    assert.match(dockerignore, new RegExp(`^${allowed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
  const ci = await read('.github/workflows/ci.yml');
  assert.match(ci, /docker run .*clawfix:ci/);
  assert.match(ci, /curl --fail .*\/api\/health/);
});

test('Blaxel provisioning requires and verifies an exact detached commit', async () => {
  const lab = await read('scripts/blaxel-lab.mjs');
  assert.match(lab, /CLAWFIX_LAB_REF/);
  assert.match(lab, /\^\[0-9a-f\]\{40\}\$/i);
  assert.match(lab, /checkout --detach/);
  assert.match(lab, /rev-parse HEAD/);
  assert.match(lab, /expected.*HEAD|HEAD.*expected/i);
  assert.doesNotMatch(lab, /git -C \/app\/clawfix pull --ff-only/);
});

test('Blaxel command and JSON contracts fail closed', async () => {
  const { assertCommandResult, parseJsonOutput } = await import('../scripts/blaxel-contracts.mjs');

  assert.equal(assertCommandResult('ok', { exitCode: 0 }).exitCode, 0);
  assert.equal(assertCommandResult('expected failure', { exitCode: 2 }, { allowedExitCodes: [2] }).exitCode, 2);
  assert.throws(() => assertCommandResult('failed', { exitCode: 1 }), /exit code 1/);
  assert.throws(() => assertCommandResult('timed out', { exitCode: 0, timedOut: true }), /timed out/);
  assert.throws(() => assertCommandResult('incomplete', {}), /missing a numeric exit code/);
  assert.throws(() => parseJsonOutput('empty', '  '), /empty JSON/);
  assert.throws(() => parseJsonOutput('invalid', '{nope'), /invalid JSON/);
  assert.deepEqual(parseJsonOutput('valid', '{"ok":true}'), { ok: true });
});

test('scenario evidence requires expected issue IDs and restoration proof', async () => {
  const { assertScenarioEvidence } = await import('../scripts/blaxel-contracts.mjs');
  const valid = {
    issues: [{ nativeCheckId: 'config/schema-invalid' }],
    diagnostic: { nativeConfig: { available: true, valid: false } },
  };

  assert.deepEqual(
    assertScenarioEvidence('invalid-config', valid, {
      expectedIssueIds: ['config/schema-invalid'],
      evidence: value => value.diagnostic.nativeConfig.valid === false,
    }),
    ['config/schema-invalid'],
  );
  assert.throws(() => assertScenarioEvidence('missing', { issues: [], diagnostic: {} }, {
    expectedIssueIds: ['required/id'],
    evidence: () => true,
  }), /required\/id/);
  assert.throws(() => assertScenarioEvidence('weak', valid, {
    expectedIssueIds: ['config/schema-invalid'],
    evidence: () => false,
  }), /expected evidence/);
});

test('scenario scripts wire fail-closed contracts into every fault and restoration', async () => {
  const [scenarios, nativeEvidence] = await Promise.all([
    read('scripts/blaxel-scenarios.mjs'),
    read('scripts/blaxel-native-evidence.mjs'),
  ]);
  for (const issueId of [
    'config/schema-invalid',
    'gateway-not-running',
    'runtime/gateway-port-conflict',
  ]) {
    assert.match(scenarios, new RegExp(`expectedIssueIds: \\['${issueId}'\\]`));
  }
  assert.equal((scenarios.match(/scenarioResult\.restoration = restoration/g) || []).length, 3);
  assert.match(scenarios, /assertCommandResult/);
  assert.match(scenarios, /parseJsonOutput/);
  assert.match(nativeEvidence, /assertCommandResult/);
  assert.match(nativeEvidence, /parseJsonOutput/);
});

test('CLI package manifest validator rejects additions and omissions', async () => {
  const { EXPECTED_CLI_FILES, validateCliPackageManifest } = await import('../scripts/verify-cli-package.mjs');
  assert.ok(EXPECTED_CLI_FILES.includes('bin/security.js'));
  assert.ok(EXPECTED_CLI_FILES.includes('bin/workspace.js'));
  const manifest = [{ name: 'clawfix', version: '0.9.0', files: EXPECTED_CLI_FILES.map(path => ({ path })) }];

  assert.doesNotThrow(() => validateCliPackageManifest(manifest, { name: 'clawfix', version: '0.9.0' }));
  assert.throws(() => validateCliPackageManifest([
    { ...manifest[0], files: [...manifest[0].files, { path: '.env' }] },
  ], { name: 'clawfix', version: '0.9.0' }), /unexpected.*\.env/i);
  assert.throws(() => validateCliPackageManifest([
    { ...manifest[0], files: manifest[0].files.slice(1) },
  ], { name: 'clawfix', version: '0.9.0' }), /missing/i);
});
