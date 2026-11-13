#!/usr/bin/env node
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const ACCOUNT = 'e320a5a80611f9a30148d452929b1fb1';
export const REPOSITORY = 'arcabotai/clawfix';
export const WORKER = 'clawfix';

export function isApprovedPushRun(run, sha) {
  return run?.head_sha === sha && run.head_branch === 'main' && run.conclusion === 'success'
    && run.event === 'push' && run.head_repository?.full_name === REPOSITORY;
}

function byName(items) {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

export function assertRuntimePreserved(before, after) {
  for (const key of ['compatibility_date', 'compatibility_flags']) {
    assert.ok(isDeepStrictEqual(after.settings[key], before.settings[key]), `Runtime ${key} changed`);
  }
  const runtimeBindings = (s) => byName(s.settings.bindings.filter((b) => b.name !== 'CF_VERSION_METADATA'));
  assert.ok(isDeepStrictEqual(runtimeBindings(after), runtimeBindings(before)), 'Production runtime bindings changed');
  const domains = (s) => [...s.domains].sort((a, b) => a.hostname.localeCompare(b.hostname));
  assert.ok(isDeepStrictEqual(domains(after), domains(before)), 'Production domains changed');
  assert.ok(isDeepStrictEqual(after.schedules.map((s) => s.cron).sort(), before.schedules.map((s) => s.cron).sort()), 'Cleanup cron changed');
  assert.ok(isDeepStrictEqual(after.exposure, before.exposure), 'Provider exposure changed');
}

export function assertDeploymentTarget(config) {
  assert.equal(config.name, WORKER, 'Wrong production Worker');
  assert.equal(config.account_id, ACCOUNT, 'Wrong production account');
  assert.equal(config.keep_vars, true, 'Production variables must be preserved');
  assert.deepEqual(config.hyperdrive, [{ binding: 'HYPERDRIVE', id: '054e6fd0b1bb4910906bd052fbd288fc' }]);
  assert.deepEqual(config.version_metadata, { binding: 'CF_VERSION_METADATA' });
  for (const forbidden of ['routes', 'route', 'vars']) {
    assert.equal(forbidden in config, false, `Deployment must not change ${forbidden}`);
  }
}

const workerPath = `/accounts/${ACCOUNT}/workers/scripts/${WORKER}`;

async function productionSnapshot(cloudflare) {
  const [settings, allDomains, schedules, exposure] = await Promise.all([
    cloudflare(`${workerPath}/settings`), cloudflare(`/accounts/${ACCOUNT}/workers/domains`),
    cloudflare(`${workerPath}/schedules`), cloudflare(`${workerPath}/subdomain`),
  ]);
  const domains = allDomains.filter((domain) => domain.service === WORKER);
  assert.ok(domains.some((d) => d.hostname === 'clawfix.dev'), 'Existing production domain missing');
  assert.ok(domains.some((d) => d.hostname === 'www.clawfix.dev'), 'Existing www domain missing');
  return { settings, domains, schedules: schedules.schedules, exposure };
}

async function activeVersion(cloudflare) {
  const current = (await cloudflare(`${workerPath}/deployments`)).deployments[0];
  assert.ok(current?.versions?.length === 1 && current.versions[0].percentage === 100, 'Production must have one 100% version');
  return current.versions[0].version_id;
}

export async function deployFromMain({ sha, config, github, cloudflare, wrangler, verifyLive, receipt = async () => {} }) {
  assert.match(sha, /^[a-f0-9]{40}$/, 'Invalid source SHA');
  assertDeploymentTarget(config);
  const currentMain = async () => (await github(`/repos/${REPOSITORY}/git/ref/heads/main`)).object.sha;
  if (await currentMain() !== sha) return { status: 'skipped-stale', sha };
  const runs = await github(`/repos/${REPOSITORY}/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=20`);
  assert.ok(runs.workflow_runs.some((run) => isApprovedPushRun(run, sha)), 'Exact main SHA has no successful push CI');

  const before = await productionSnapshot(cloudflare);
  const rollbackVersionId = await activeVersion(cloudflare);
  await receipt({ status: 'uploading', sha, rollbackVersionId });
  await wrangler(['versions', 'upload', '--config', 'wrangler.jsonc', '--tag', sha, '--message', `GitHub ${sha}`, '--keep-vars']);
  const versions = await cloudflare(`${workerPath}/versions`);
  const candidate = versions.items.find((version) => version.annotations?.['workers/tag'] === sha);
  assert.ok(candidate?.id, 'Uploaded exact-SHA version not found; no promotion attempted');
  const versionId = candidate.id;
  const uploaded = await cloudflare(`${workerPath}/versions/${versionId}`);
  assert.equal(uploaded.annotations?.['workers/tag'], sha, 'Worker version SHA mismatch');
  assertRuntimePreserved(before, { ...before, settings: {
    ...uploaded.resources.script_runtime, bindings: uploaded.resources.bindings,
  } });
  await receipt({ status: 'uploaded', sha, versionId, rollbackVersionId });
  if (await currentMain() !== sha) return { status: 'skipped-stale', sha, versionId, rollbackVersionId };
  assert.equal(await activeVersion(cloudflare), rollbackVersionId, 'Production changed externally; no promotion attempted');

  const promote = (id, message) => wrangler(['versions', 'deploy', '--config', 'wrangler.jsonc', '--version-id', id,
    '--percentage', '100', '--yes', '--message', message]);
  try {
    await receipt({ status: 'promoting', sha, versionId, rollbackVersionId });
    await promote(versionId, `GitHub ${sha}`);
    assert.equal(await activeVersion(cloudflare), versionId, 'Provider active version mismatch');
    assertRuntimePreserved(before, await productionSnapshot(cloudflare));
    await verifyLive(versionId);
  } catch (error) {
    // Reconcile first: never replace a different operator's deployment or retry an ambiguous upload.
    const current = await activeVersion(cloudflare);
    if (current === versionId) {
      await promote(rollbackVersionId, `Rollback failed GitHub ${sha}`);
      assert.equal(await activeVersion(cloudflare), rollbackVersionId, 'Rollback verification failed');
      await receipt({ status: 'rolled-back', sha, versionId, rollbackVersionId });
      throw new Error('Deployment verification failed; restored previous version', { cause: error });
    }
    throw error;
  }
  return { status: 'deployed', sha, versionId, rollbackVersionId };
}

function command(args) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', timeout: 180_000 });
  assert.equal(result.status, 0, 'Deployment command failed; inspect the preceding command output');
}

async function main() {
  let latest = {};
  const receipt = async (record) => {
    latest = record;
    await writeFile('deployment-result.json', `${JSON.stringify(record, null, 2)}\n`);
  };
  try {
    const sha = process.env.DEPLOY_SHA;
    assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY, 'Wrong GitHub repository');
    assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT, 'Wrong Cloudflare environment account');
    assert.ok(process.env.CLOUDFLARE_API_TOKEN && process.env.GH_TOKEN, 'Deployment credentials are missing');
    const checkout = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
    assert.equal(checkout.status, 0);
    assert.equal(checkout.stdout.trim(), sha, 'Checkout is not the exact approved SHA');
    const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
    const request = async (origin, path, token) => {
      const response = await fetch(origin + path, {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'ClawFix-GitHub-Deployment/1.0' },
        redirect: 'error', signal: AbortSignal.timeout(20_000),
      });
      assert.ok(response.ok, `Deployment API read failed: HTTP ${response.status}`);
      const body = await response.json();
      if (origin.includes('cloudflare')) {
        assert.ok(body.success, 'Cloudflare API read unsuccessful');
        return body.result;
      }
      return body;
    };
    const cloudflare = (path) => request('https://api.cloudflare.com/client/v4', path, process.env.CLOUDFLARE_API_TOKEN);
    const account = await cloudflare(`/accounts/${ACCOUNT}`);
    assert.equal(account.id, ACCOUNT, 'Authenticated account mismatch');
    const result = await deployFromMain({
      sha, config, receipt, cloudflare,
      github: (path) => request('https://api.github.com', path, process.env.GH_TOKEN),
      wrangler: async (args) => command(['node_modules/wrangler/bin/wrangler.js', ...args]),
      verifyLive: async (versionId) => {
        for (const host of ['clawfix.dev', 'www.clawfix.dev']) {
          let observed = false;
          for (let attempt = 0; attempt < 8; attempt += 1) {
            try {
              const response = await fetch(`https://${host}/?deployment=${versionId}`, {
                redirect: 'error', signal: AbortSignal.timeout(5000),
                headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'ClawFix-GitHub-Deployment/1.0' },
              });
              observed = response.ok && response.headers.get('x-clawfix-version-id') === versionId;
              await response.body.cancel();
              if (observed) break;
            } catch { /* bounded read-only retries allow edge propagation */ }
            await delay(2500);
          }
          assert.ok(observed, `Live ${host} did not serve the exact Worker version`);
        }
        // Default verifier is read-only: no paid model calls, diagnoses or user-data writes.
        command(['scripts/verify-production.mjs']);
      },
    });
    await receipt(result);
    console.log(JSON.stringify(result));
  } catch (error) {
    await receipt({ ...latest, error: error.message });
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
