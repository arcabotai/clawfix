import assert from 'node:assert/strict';
import test from 'node:test';

const deployment = await import('../scripts/deploy-cloudflare.mjs').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

test('Worker smoke refuses any non-isolated database before initialization', async () => {
  let smoke = {};
  try { smoke = await import('../scripts/verify-worker-runtime.mjs'); } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
  assert.equal(typeof smoke.assertIsolatedDatabase, 'function', 'isolated Worker smoke is missing');
  smoke.assertIsolatedDatabase('postgres://postgres:ci-only@127.0.0.1:5432/clawfix_worker_ci');
  for (const url of [
    'postgres://postgres:ci-only@database.example/clawfix_worker_ci',
    'postgres://postgres:ci-only@localhost/clawfix',
    'postgres://postgres:ci-only@localhost/clawfix_worker_ci?options=unsafe',
    '',
  ]) assert.throws(() => smoke.assertIsolatedDatabase(url));
});

const SHA = 'a'.repeat(40);

test('automatic deployment is CI-gated and secrets are restricted to the deployment step', async () => {
  const { readFile } = await import('node:fs/promises');
  let workflow = '';
  try { workflow = await readFile(new URL('../.github/workflows/deploy-cloudflare.yml', import.meta.url), 'utf8'); } catch {}
  assert.match(workflow, /workflow_run:/, 'CI completion deployment workflow is missing');
  assert.match(workflow, /workflows: \[CI\]/);
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /scripts\/deploy-cloudflare\.mjs/);
  assert.match(workflow, /actions: read/);
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /worker:smoke/);
  assert.match(ci, /postgres:16/);
});

test('only a successful same-repository main push is an automatic deployment source', () => {
  assert.equal(typeof deployment.isApprovedPushRun, 'function', 'CI provenance guard is missing');
  const valid = { head_sha: SHA, head_branch: 'main', conclusion: 'success', event: 'push', head_repository: { full_name: 'arcabotai/clawfix' } };
  assert.equal(deployment.isApprovedPushRun(valid, SHA), true);
  for (const bad of [
    { ...valid, head_branch: 'feature' },
    { ...valid, conclusion: 'failure' },
    { ...valid, event: 'pull_request' },
    { ...valid, head_repository: { full_name: 'attacker/fork' } },
    { ...valid, head_sha: 'b'.repeat(40) },
  ]) assert.equal(deployment.isApprovedPushRun(bad, SHA), false);
});

function pipelineFixture({ stale = false, staleAfterUpload = false, externalDuringFailure = false, ciSuccess = true, corruptBinding = false, liveFails = false } = {}) {
  let active = '11111111-1111-4111-8111-111111111111';
  const next = '22222222-2222-4222-8222-222222222222';
  const commands = [];
  const settings = { compatibility_date: '2026-09-01', compatibility_flags: ['nodejs_compat'], bindings: [
    { name: 'ALLOW_PUBLIC_AI', type: 'plain_text', text: '0' },
    { name: 'HYPERDRIVE', type: 'hyperdrive', id: '054e6fd0b1bb4910906bd052fbd288fc' },
  ] };
  return {
    commands,
    options: {
      sha: SHA,
      config: validConfig,
      github: async (path) => path.includes('/git/ref/')
        ? { object: { sha: (stale || (staleAfterUpload && commands.length > 0)) ? 'b'.repeat(40) : SHA } }
        : { workflow_runs: [{ head_sha: SHA, head_branch: 'main', conclusion: ciSuccess ? 'success' : 'failure', event: 'push', head_repository: { full_name: 'arcabotai/clawfix' } }] },
      cloudflare: async (path) => {
        if (path.endsWith('/settings')) return structuredClone(settings);
        if (path.endsWith('/domains')) return [{ hostname: 'clawfix.dev', service: 'clawfix' }, { hostname: 'www.clawfix.dev', service: 'clawfix' }];
        if (path.endsWith('/schedules')) return { schedules: [{ cron: '*/15 * * * *' }] };
        if (path.endsWith('/subdomain')) return { enabled: true, previews_enabled: true };
        if (path.endsWith('/deployments')) return { deployments: [{ versions: [{ version_id: active, percentage: 100 }] }] };
        if (path.endsWith('/versions')) return { items: [{ id: next, annotations: { 'workers/tag': SHA } }] };
        if (path.endsWith('/versions/' + next)) return { id: next, annotations: { 'workers/tag': SHA }, resources: {
          script_runtime: settings,
          bindings: [{ ...settings.bindings[0], text: corruptBinding ? '1' : '0' }, settings.bindings[1], { name: 'CF_VERSION_METADATA', type: 'version_metadata' }],
        } };
        throw new Error('Unexpected Cloudflare fixture path: ' + path);
      },
      wrangler: async (args) => {
        commands.push(args);
        if (args[1] === 'deploy') active = args[args.indexOf('--version-id') + 1];
      },
      verifyLive: async (versionId) => {
        assert.equal(versionId, next);
        if (externalDuringFailure) active = '33333333-3333-4333-8333-333333333333';
        if (liveFails || externalDuringFailure) throw new Error('synthetic live check failed');
      },
    },
  };
}

test('deploys the exact CI-approved SHA and exact version ID without synchronizing routes', async () => {
  assert.equal(typeof deployment.deployFromMain, 'function', 'deployment pipeline is missing');
  const fixture = pipelineFixture();
  const result = await deployment.deployFromMain(fixture.options);
  assert.equal(result.status, 'deployed');
  assert.equal(result.sha, SHA);
  assert.equal(result.versionId, '22222222-2222-4222-8222-222222222222');
  assert.equal(fixture.commands.length, 2);
  assert.deepEqual(fixture.commands[0].slice(0, 2), ['versions', 'upload']);
  assert.ok(fixture.commands[0].includes('--keep-vars'));
  assert.deepEqual(fixture.commands[1].slice(0, 2), ['versions', 'deploy']);
});

test('stale main and failed CI cannot mutate production', async () => {
  const stale = pipelineFixture({ stale: true });
  assert.equal((await deployment.deployFromMain(stale.options)).status, 'skipped-stale');
  assert.equal(stale.commands.length, 0);
  const failed = pipelineFixture({ ciSuccess: false });
  await assert.rejects(deployment.deployFromMain(failed.options), /CI/);
  assert.equal(failed.commands.length, 0);
});

test('candidate cannot change runtime variables before promotion', async () => {
  const fixture = pipelineFixture({ corruptBinding: true });
  await assert.rejects(deployment.deployFromMain(fixture.options), /bindings/);
  assert.equal(fixture.commands.length, 1);
});

test('a failed live verification restores only this deployment to its previous version', async () => {
  const fixture = pipelineFixture({ liveFails: true });
  await assert.rejects(deployment.deployFromMain(fixture.options), /restored previous version/);
  assert.equal(fixture.commands.length, 3);
  assert.ok(fixture.commands[2].includes('11111111-1111-4111-8111-111111111111'));
});

test('a newer main arriving after upload prevents promotion', async () => {
  const fixture = pipelineFixture({ staleAfterUpload: true });
  assert.equal((await deployment.deployFromMain(fixture.options)).status, 'skipped-stale');
  assert.equal(fixture.commands.length, 1);
});

test('failed checks never roll back a different operator deployment', async () => {
  const fixture = pipelineFixture({ externalDuringFailure: true });
  await assert.rejects(deployment.deployFromMain(fixture.options), /synthetic live check failed/);
  assert.equal(fixture.commands.length, 2);
});

test('runtime preservation errors do not expose production variable values', () => {
  const before = { settings: { bindings: [{ name: 'EXAMPLE', type: 'plain_text', text: 'sensitive-production-value' }] }, domains: [], schedules: [], exposure: {} };
  const after = structuredClone(before);
  after.settings.bindings[0].text = 'different-private-value';
  assert.throws(() => deployment.assertRuntimePreserved(before, after), (error) => {
    assert.doesNotMatch(error.message, /sensitive-production-value|different-private-value/);
    return true;
  });
});

const validConfig = {
  name: 'clawfix',
  account_id: 'e320a5a80611f9a30148d452929b1fb1',
  keep_vars: true,
  hyperdrive: [{ binding: 'HYPERDRIVE', id: '054e6fd0b1bb4910906bd052fbd288fc' }],
  version_metadata: { binding: 'CF_VERSION_METADATA' },
};

test('deployment refuses a different account, worker, or destructive variable configuration', () => {
  assert.equal(typeof deployment.assertDeploymentTarget, 'function', 'production target guard is missing');
  deployment.assertDeploymentTarget(validConfig);
  for (const bad of [
    { ...validConfig, name: 'another-worker' },
    { ...validConfig, account_id: 'another-account' },
    { ...validConfig, keep_vars: false },
    { ...validConfig, hyperdrive: [] },
    { ...validConfig, routes: ['another.example/*'] },
    { ...validConfig, vars: { ALLOW_PUBLIC_AI: '1' } },
  ]) assert.throws(() => deployment.assertDeploymentTarget(bad));
});

test('deployment preserves production secrets, variable values, database binding, domains and cron', () => {
  assert.equal(typeof deployment.assertRuntimePreserved, 'function', 'runtime preservation guard is missing');
  const before = {
    settings: { compatibility_date: '2026-09-01', compatibility_flags: ['nodejs_compat'], bindings: [
      { name: 'ALLOW_PUBLIC_AI', type: 'plain_text', text: '0' },
      { name: 'RESEND_API_KEY', type: 'secret_text' },
      { name: 'HYPERDRIVE', type: 'hyperdrive', id: '054e6fd0b1bb4910906bd052fbd288fc' },
    ] },
    domains: [{ hostname: 'clawfix.dev', service: 'clawfix' }, { hostname: 'www.clawfix.dev', service: 'clawfix' }],
    schedules: [{ cron: '*/15 * * * *' }],
    exposure: { enabled: true, previews_enabled: true },
  };
  const after = structuredClone(before);
  after.settings.bindings.push({ name: 'CF_VERSION_METADATA', type: 'version_metadata' });
  deployment.assertRuntimePreserved(before, after);
  for (const mutate of [
    (s) => { s.settings.bindings[0].text = '1'; },
    (s) => { s.settings.bindings.splice(1, 1); },
    (s) => { s.settings.bindings[2].id = 'wrong-db'; },
    (s) => { s.domains.pop(); },
    (s) => { s.schedules = []; },
    (s) => { s.exposure.enabled = false; },
  ]) {
    const bad = structuredClone(after);
    mutate(bad);
    assert.throws(() => deployment.assertRuntimePreserved(before, bad));
  }
});
