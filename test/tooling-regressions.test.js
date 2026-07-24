import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
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
  assert.ok(cliPackage.files.includes('core/'));
  assert.ok(cliPackage.files.includes('adapters/'));
  assert.ok(cliPackage.files.includes('interfaces/'));
  assert.match(cliSource, /new URL\(['"]\.\.\/package\.json['"], import\.meta\.url\)/);
  assert.match(cliSource, new RegExp(`return ['"]${cliPackage.version.replaceAll('.', '\\.') }['"]`));
  assert.match(cliSource, /from ['"]\.\.\/interfaces\/plain\.js['"]/);
  assert.match(cliSource, /runPlainInterface/);
  assert.doesNotMatch(cliSource, /BUILTIN_FIXES|deriveIssues|collectDiagnosticsLegacy/);
});

test('CLI has exactly one canonical entrypoint and no stale duplicate', async () => {
  const cliPackage = await json('cli/package.json');
  const canonicalEntrypoint = new URL('../cli/bin/clawfix.js', import.meta.url);
  const staleEntrypoint = new URL('../cli/' + 'index.js', import.meta.url);

  assert.deepEqual(Object.keys(cliPackage.bin), ['clawfix']);
  assert.equal(cliPackage.bin.clawfix, 'bin/clawfix.js');
  await access(canonicalEntrypoint);
  assert.equal((await stat(canonicalEntrypoint)).isFile(), true);
  await assert.rejects(access(staleEntrypoint), { code: 'ENOENT' });
});

test('CI packs and allowlist-validates the publishable cli package', async () => {
  const ci = await read('.github/workflows/ci.yml');
  assert.match(ci, /npm pack \.\/cli --dry-run --json/);
  assert.match(ci, /verify-cli-package\.mjs/);
  assert.match(ci, /node --check cli\/adapters\/process\.js/);
  assert.match(ci, /node --check cli\/adapters\/openclaw\.js/);
  assert.doesNotMatch(ci, /run: npm pack --dry-run --json/);
});

test('release uses npm trusted publishing and runs every pre-publish gate', async () => {
  const release = await read('.github/workflows/release.yml');
  assert.match(release, /id-token: write/);
  assert.match(release, /node-version: '24'/);
  assert.match(release, /package-manager-cache: false/);
  assert.match(release, /npm install --global npm@11\.15\.0/);
  assert.match(release, /workflow_dispatch:/);
  assert.match(release, /run: npm ci/);
  assert.match(release, /run: npm test/);
  assert.match(release, /npm run prove:remediation/);
  assert.match(release, /npm run validate:repairs/);
  assert.match(release, /npm audit --omit=dev/);
  assert.match(release, /node --check cli\/bin\/native-diagnostics\.js/);
  assert.match(release, /node --check cli\/adapters\/process\.js/);
  assert.match(release, /node --check cli\/adapters\/openclaw\.js/);
  assert.match(release, /verify-cli-package\.mjs/);
  assert.match(release, /npm publish --access public/);
  assert.doesNotMatch(release, /NPM_TOKEN|NODE_AUTH_TOKEN|--provenance/);
});

test('landing page presents truthful evidence for the published 0.11.1 twenty-one-file package', async () => {
  const landing = await read('src/landing.js');
  assert.match(landing, /npx clawfix@0\.11\.1/);
  assert.match(landing, /clawfix\.dev\/install/);
  assert.match(landing, /install\/sha256/);
  assert.match(landing, /No global npm/);
  assert.match(landing, /GitHub OIDC publish/);
  assert.match(landing, /npm attestation verified/);
  assert.match(landing, /21-file allowlisted package/);
  assert.doesNotMatch(landing, /7-file allowlisted package/);
  assert.doesNotMatch(landing, /18-file allowlisted package/);
  assert.match(landing, /Evidence before repair/);
  assert.match(landing, /releases\/tag\/v0\.11\.1/);
  assert.doesNotMatch(landing, /class="beta-banner"/);
  assert.doesNotMatch(landing, /<code id="cmd-npx">npx clawfix<\/code>/);
});

test('script download guidance requires HTTPS and review before execution', async () => {
  const scriptRoute = await read('src/routes/script.js');
  assert.match(scriptRoute, /curl --fail --show-error --silent --location https:\/\/clawfix\.dev\/fix/);
  assert.match(scriptRoute, /Compare the printed hashes exactly before running the script/);
  assert.doesNotMatch(scriptRoute, /curl[^\n]*\sclawfix\.dev\/fix/);
  assert.doesNotMatch(scriptRoute, /curl[^\n]*\|\s*(?:ba)?sh/);
});


test('bash installer is recommended and never pipes curl into a shell', async () => {
  const [installScript, installRoute, landing, readme, server] = await Promise.all([
    read('scripts/install.sh'),
    read('src/routes/install.js'),
    read('src/landing.js'),
    read('README.md'),
    read('src/server.js'),
  ]);
  assert.match(server, /installRouter/);
  assert.match(installRoute, /install\/sha256/);
  assert.match(installScript, /#!\/usr\/bin\/env bash/);
  assert.match(installScript, /openssl dgst -sha512/);
  assert.match(readme, /clawfix\.dev\/install/);
  assert.match(landing, /cmd-install/);
  for (const source of [installScript, installRoute, landing, readme]) {
    assert.doesNotMatch(source, /curl[^\n]*\|\s*(?:ba)?sh/);
  }
});

test('public surfaces avoid remote shell pipes and privacy absolutes', async () => {
  const sources = await Promise.all([
    read('src/landing.js'),
    read('src/routes/results.js'),
    read('src/routes/script.js'),
    read('src/routes/install.js'),
    read('scripts/install.sh'),
    read('cli/bin/clawfix.js'),
    read('cli/interfaces/plain.js'),
  ]);
  for (const source of sources) {
    assert.doesNotMatch(source, /curl[^\n]*\|\s*(?:ba)?sh/);
    assert.doesNotMatch(source, /all secrets redacted|all redacted|NEVER SENT|Personal data of any kind/i);
  }
  const landing = sources[0];
  assert.match(landing, /recognized secrets/i);
  assert.match(landing, /top-level config env block/i);
});

test('privacy docs disclose upload overrides and actual log limits', async () => {
  const [readme, scriptRoute, landing] = await Promise.all([
    read('README.md'),
    read('src/routes/script.js'),
    read('src/landing.js'),
  ]);
  assert.match(readme, /top-level config `env` block is omitted/);
  assert.doesNotMatch(readme, /Environment variable values.*not collected|Environment variable values.*excluded/i);
  assert.doesNotMatch(readme, /you see everything before anything happens/i);
  assert.match(readme, /--yes/);
  assert.match(readme, /CLAWFIX_AUTO=1/);
  assert.match(readme, /--dry-run/);
  assert.match(readme, /--show-data/);
  assert.match(readme, /200 recent `gateway\.err\.log` lines/);
  assert.match(scriptRoute, /up to 30 matching gateway log lines and up to 50 recent stderr lines/i);
  assert.match(landing, /<code>--yes<\/code>, <code>-y<\/code>, or set <code>CLAWFIX_AUTO=1<\/code>/);
});

test('Docker build is strict, least-privilege, and copies only runtime inputs', async () => {
  const [dockerfile, dockerignore, ci] = await Promise.all([
    read('Dockerfile'),
    read('.dockerignore'),
    read('.github/workflows/ci.yml'),
  ]);

  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /COPY --chown=node:node src \.\/src/);
  assert.match(dockerfile, /COPY --chown=node:node cli\/bin\/security\.js \.\/cli\/bin\/security\.js/);
  assert.match(dockerfile, /COPY --chown=node:node scripts\/install\.sh \.\/scripts\/install\.sh/);
  assert.match(dockerfile, /RUN node -e .*import\('\.\/src\/server\.js'\)/);
  assert.match(dockerfile, /^HEALTHCHECK /m);
  assert.match(dockerfile, /process\.env\.PORT \|\| '3001'/);
  assert.match(ci, /--env PORT=3210 --publish 3210:3210/);
  assert.match(ci, /127\.0\.0\.1:3210\/api\/health/);
  assert.doesNotMatch(dockerfile, /^COPY \. \.$/m);
  assert.match(dockerignore, /^\*$/m);
  for (const allowed of ['!package.json', '!package-lock.json', '!src/**', '!cli/bin/security.js', '!scripts/install.sh']) {
    assert.match(dockerignore, new RegExp(`^${allowed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
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

test('next candidate CLI source manifest remains exactly twenty-one allowlisted files', async () => {
  const { EXPECTED_CLI_FILES, validateCliPackageManifest } = await import('../scripts/verify-cli-package.mjs');
  assert.ok(EXPECTED_CLI_FILES.includes('bin/security.js'));
  assert.ok(EXPECTED_CLI_FILES.includes('bin/workspace.js'));
  assert.ok(EXPECTED_CLI_FILES.includes('core/diagnostics.js'));
  assert.ok(EXPECTED_CLI_FILES.includes('core/events.js'));
  assert.ok(EXPECTED_CLI_FILES.includes('core/findings.js'));
  assert.ok(EXPECTED_CLI_FILES.includes('core/modes.js'));
  assert.ok(EXPECTED_CLI_FILES.includes('core/offline-analyzer.js'));
  assert.ok(EXPECTED_CLI_FILES.includes('core/options.js'));
  assert.ok(EXPECTED_CLI_FILES.includes('core/privacy.js'));
  assert.ok(EXPECTED_CLI_FILES.includes('core/repair-catalog.js'));
  assert.ok(EXPECTED_CLI_FILES.includes('core/repair-engine.js'));
  assert.ok(EXPECTED_CLI_FILES.includes('core/session.js'));
  assert.ok(EXPECTED_CLI_FILES.includes('adapters/process.js'));
  assert.ok(EXPECTED_CLI_FILES.includes('adapters/openclaw.js'));
  assert.ok(EXPECTED_CLI_FILES.includes('adapters/remote-analyzer.js'));
  assert.ok(EXPECTED_CLI_FILES.includes('interfaces/plain.js'));
  assert.equal(EXPECTED_CLI_FILES.length, 21);
  const manifest = [{ name: 'clawfix', version: '0.9.0', files: EXPECTED_CLI_FILES.map(path => ({ path })) }];

  assert.doesNotThrow(() => validateCliPackageManifest(manifest, { name: 'clawfix', version: '0.9.0' }));
  assert.throws(() => validateCliPackageManifest([
    { ...manifest[0], files: [...manifest[0].files, { path: '.env' }] },
  ], { name: 'clawfix', version: '0.9.0' }), /unexpected.*\.env/i);
  assert.throws(() => validateCliPackageManifest([
    { ...manifest[0], files: manifest[0].files.slice(1) },
  ], { name: 'clawfix', version: '0.9.0' }), /missing/i);
});
