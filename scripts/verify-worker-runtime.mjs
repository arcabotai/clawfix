#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export function assertIsolatedDatabase(value) {
  const url = new URL(value);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'PostgreSQL required');
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Smoke database must be loopback-only');
  assert.equal(url.pathname, '/clawfix_worker_ci', 'Dedicated disposable CI database required');
  assert.equal(url.search, '', 'Database options are not accepted');
}

async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assertIsolatedDatabase(databaseUrl);
  process.env.DATABASE_URL = databaseUrl;
  const { initDB, getPool, claimWebhookDelivery, completeWebhookDelivery } = await import('../src/db.js');
  const db = getPool();
  let worker;
  let log = '';
  let deadline;
  const stop = () => {
    if (!worker?.pid) return;
    try { process.kill(-worker.pid, 'SIGTERM'); } catch {}
  };
  try {
    assert.equal(await initDB(), true, 'Fixture schema initialization failed');
    const args = ['node_modules/wrangler/bin/wrangler.js', 'dev', '--local', '--ip', '127.0.0.1', '--port', '8787',
      '--var', 'NODE_ENV:test', '--var', 'ALLOW_PUBLIC_AI:0', '--var', 'CLAWFIX_AGENT_V2:1',
      '--var', 'CLAWFIX_CANARY_TOKEN:ci-only-canary'];
    worker = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true',
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: databaseUrl },
    });
    worker.on('error', (error) => { log += `\n${error.message}`; });
    for (const stream of [worker.stdout, worker.stderr]) stream.on('data', (chunk) => { log = (log + chunk).slice(-30_000); });
    deadline = setTimeout(stop, 240_000);
    const baseUrl = 'http://127.0.0.1:8787';
    const request = async (path, options = {}) => {
      const response = await fetch(baseUrl + path, { ...options, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      assert.ok(response.ok, `${path} returned ${response.status}`);
      return response;
    };
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const response = await fetch(baseUrl + '/api/health', { signal: AbortSignal.timeout(1000) });
        if (response.ok) { await response.body.cancel(); ready = true; break; }
        await response.body.cancel();
      } catch {}
      if (worker.exitCode !== null) break;
      await delay(1000);
    }
    assert.ok(ready, 'Worker did not become healthy');
    const { runProductionVerification, parseSseEvents } = await import('./verify-production.mjs');
    const { version } = JSON.parse(await readFile('package.json', 'utf8'));
    const surface = await runProductionVerification({ baseUrl, expectedVersion: version });
    const jsonHeaders = { 'Content-Type': 'application/json' };
    const conversationId = randomUUID();
    const agentResponse = await request('/api/v2/agent/messages', {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ conversationId, message: 'CI diagnostic check. Do not propose any repair.', availableRepairs: [] }),
    });
    const events = parseSseEvents(await agentResponse.text());
    assert.equal(events[0].event, 'agent.meta');
    assert.equal(events.at(-1).event, 'agent.done');
    assert.ok(!events.some((event) => event.event === 'agent.error'));
    assert.ok(events.some((event) => event.event === 'assistant.delta'));

    const diagnostic = await (await request('/api/diagnose', {
      method: 'POST', headers: { ...jsonHeaders, 'x-clawfix-canary': 'ci-only-canary' },
      body: JSON.stringify({ system: { os: 'linux-ci', arch: 'x64' }, openclaw: { version: 'ci', processExists: true, portListening: true }, logs: { errors: '' }, _localIssues: [] }),
    })).json();
    assert.equal(diagnostic.canary, true);
    assert.equal(diagnostic.persisted, true);
    assert.equal(diagnostic.fixScript, null, 'Worker must withhold shell that cannot be syntax-validated');
    const stored = await (await request(`/api/fix/${diagnostic.fixId}`)).json();
    assert.equal(stored.fixId, diagnostic.fixId);
    const publicStats = await (await request('/api/stats')).json();
    assert.equal(publicStats.totalDiagnoses, 0, 'CI canary polluted public counters');
    const durable = await db.query('SELECT id FROM diagnoses WHERE id = $1', [diagnostic.fixId]);
    assert.equal(durable.rowCount, 1);

    const { acquireConcurrencyLease, consumeFixedWindow } = await import('../src/shared-state.js');
    const admissions = await Promise.all(Array.from({ length: 3 }, () => acquireConcurrencyLease({ scope: 'worker-ci-capacity', limit: 1, ttlMs: 10_000, db })));
    try { assert.equal(admissions.filter((lease) => lease.allowed).length, 1); }
    finally { await Promise.all(admissions.filter((lease) => lease.allowed).map((lease) => lease.release())); }
    const windows = await Promise.all(Array.from({ length: 4 }, () => consumeFixedWindow({ scope: 'worker-ci-window', key: 'same-client', limit: 2, windowMs: 60_000, db })));
    assert.equal(windows.filter((window) => window.allowed).length, 2);
    const webhookId = randomUUID();
    assert.equal((await claimWebhookDelivery('ci', webhookId, { db })).status, 'claimed');
    assert.equal((await claimWebhookDelivery('ci', webhookId, { db })).status, 'pending');
    assert.equal(await completeWebhookDelivery('ci', webhookId, { db }), true);
    assert.equal((await claimWebhookDelivery('ci', webhookId, { db })).status, 'duplicate');
    console.log(JSON.stringify({ ok: true, runtime: 'workerd', database: 'isolated PostgreSQL',
      checks: [...surface.checks.map((check) => check.name), 'agent-SSE', 'durable-diagnosis', 'canary-exclusion',
        'repair-validation-fails-closed', 'concurrent-admission', 'atomic-rate-limits', 'webhook-idempotency'] }, null, 2));
  } catch (error) {
    console.error(log);
    throw error;
  } finally {
    clearTimeout(deadline);
    stop();
    if (worker?.pid && worker.exitCode === null) {
      await Promise.race([once(worker, 'exit').catch(() => {}), delay(4000)]);
      try { process.kill(-worker.pid, 'SIGKILL'); } catch {}
    }
    await db?.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
