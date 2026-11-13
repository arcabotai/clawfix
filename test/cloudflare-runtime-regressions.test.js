import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { validateRepairScript } from '../src/repair-validator.js';

// VM module linking substitutes only infrastructure boundaries, without installing
// dependencies, opening sockets, or touching a real database/provider.
async function loadModule(relativePath, mocks = {}) {
  const entry = new URL(relativePath, import.meta.url);
  const overrides = new Map(Object.entries(mocks).map(([specifier, exports]) => [
    specifier.startsWith('.') ? new URL(specifier, entry).href : specifier, exports,
  ]));
  const cache = new Map();
  async function load(identifier) {
    if (cache.has(identifier)) return cache.get(identifier);
    let module;
    if (overrides.has(identifier) || identifier.startsWith('node:')) {
      const exports = overrides.has(identifier) ? overrides.get(identifier) : await import(identifier);
      module = new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      });
    } else {
      assert.ok(identifier.startsWith('file:'), `Unmocked external import: ${identifier}`);
      module = new vm.SourceTextModule(await readFile(new URL(identifier), 'utf8'), {
        identifier,
        initializeImportMeta(meta) { meta.url = identifier; },
      });
    }
    cache.set(identifier, module);
    return module;
  }
  const module = await load(entry.href);
  await module.link((specifier, parent) => load(
    specifier.startsWith('.') ? new URL(specifier, parent.identifier).href : specifier,
  ));
  await module.evaluate();
  return module.namespace;
}

if (!vm.SourceTextModule) {
  // The normal repository runner needs no VM flags. Re-execute only this small
  // dependency-free suite when invoked through that runner.
  test('Cloudflare runtime regression cases', () => {
    const result = spawnSync(process.execPath, [
      '--experimental-vm-modules', '--test', fileURLToPath(import.meta.url),
    ], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
} else {
  test('repair validation fails closed without a genuine Bash validator', () => {
    for (const script of [
      '#!/usr/bin/env bash\nset -euo pipefail\necho healthy',
      '#!/usr/bin/env bash\nset -euo pipefail\nif true; then',
    ]) {
      const result = validateRepairScript(script, { spawn: null });
      assert.equal(result.ok, false);
      assert.equal(result.syntax.ok, false);
      assert.match(result.blockers[0].message, /unavailable/i);
    }
    assert.equal(validateRepairScript('', { spawn: null }).ok, true);
  });

  test('AI budget storage failure releases the already-acquired global lease', async () => {
    const events = [];
    const budgetError = new Error('budget query failed');
    const db = {
      async query(sql) {
        if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
        if (sql.includes('INSERT INTO concurrency_leases')) events.push('acquire');
        if (sql.includes('INSERT INTO rate_limit_windows')) {
          events.push('budget');
          throw budgetError;
        }
        if (sql.includes('DELETE FROM concurrency_leases WHERE scope')) events.push('release');
        return { rows: [] };
      },
    };
    const { sharedAIRequestGuard } = await loadModule('../src/security.js', {
      './db.js': { getPool() { throw new Error('Unexpected default database access'); } },
    });
    await assert.rejects(sharedAIRequestGuard.acquire({}, { env: {}, db }), error => error === budgetError);
    assert.deepEqual(events, ['acquire', 'budget', 'release']);
  });

  test('Node still uses real Bash syntax checks without requiring ShellCheck', () => {
    assert.equal(validateRepairScript('echo healthy', { runShellCheck: false }).ok, true);
    assert.equal(validateRepairScript('if true; then', { runShellCheck: false }).ok, false);
  });

  test('AI guard retains admission semantics and transfers release only on success', async () => {
    for (const count of [1, 3]) {
      let deletes = 0;
      const db = { async query(sql) {
        if (sql.includes('DELETE FROM concurrency_leases WHERE scope')) deletes += 1;
        return { rows: [{ count: sql.includes('INSERT INTO rate_limit_windows') ? count : 0 }] };
      } };
      const { sharedAIRequestGuard } = await loadModule('../src/security.js', { './db.js': { getPool: () => null } });
      const result = await sharedAIRequestGuard.acquire({}, { env: { AI_DAILY_REQUEST_LIMIT: '2' }, db });
      assert.equal(result.allowed, count === 1);
      if (result.allowed) {
        assert.equal(deletes, 0);
        await result.release();
        await result.release();
      } else {
        assert.equal(result.status, 429);
      }
      assert.equal(deletes, 1);
    }
  });

  test('Worker database readiness never performs schema DDL', async () => {
    const queries = [];
    class Client {
      async connect() {}
      async end() {}
      async query(sql) {
        queries.push(sql);
        assert.doesNotMatch(sql, /\b(?:CREATE|ALTER|DROP)\b/i);
        return { rows: [{ count: 8 }] };
      }
    }
    const { ensureDBReady } = await loadModule('../src/db.js', {
      pg: { default: { Client, Pool: class { constructor() { throw new Error('Unexpected Node pool'); } } } },
      './runtime-env.js': {
        hasHyperdriveBinding: () => true,
        resolveDatabaseUrl: () => 'postgres://synthetic-local-only',
      },
    });
    assert.equal(await ensureDBReady({ now: 1000 }), true);
    assert.equal(await ensureDBReady({ now: 1001 }), true);
    assert.equal(queries.length, 1);
    assert.match(queries[0], /pg_catalog\.pg_class/);
  });

  test('Worker adds runtime version proof without consuming the SSE body', async () => {
    let streamController;
    const stream = new ReadableStream({ start(controller) { streamController = controller; } });
    const upstream = new Response(stream, { status: 202, statusText: 'Accepted stream', headers: {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no',
    } });
    let forwarded;
    const { default: worker } = await loadModule('../src/worker.js', {
      'cloudflare:node': { httpServerHandler: ({ port }) => {
        assert.equal(port, 3000);
        return { fetch: async (...args) => { forwarded = args; return upstream; } };
      } },
      './server.js': { app: { listen(port) { assert.equal(port, 3000); } } },
      './db.js': { ensureDBReady: async () => true, getPool() { throw new Error('Unexpected DB access'); } },
      './shared-state.js': { cleanupSharedState() { throw new Error('Unexpected cleanup'); } },
    });
    const env = { CF_VERSION_METADATA: { id: 'provider-version-id' } };
    const request = new Request('https://clawfix.test/api/chat');
    const context = {};
    const response = await worker.fetch(request, env, context);
    assert.deepEqual(forwarded, [request, env, context]);
    assert.equal(response.headers.get('X-ClawFix-Version-ID'), 'provider-version-id');
    assert.equal(response.status, upstream.status);
    assert.equal(response.statusText, upstream.statusText);
    for (const [key, value] of upstream.headers) assert.equal(response.headers.get(key), value);
    assert.equal(response.body, upstream.body);
    assert.equal(upstream.bodyUsed, false);
    assert.equal(response.bodyUsed, false);
    assert.equal(stream.locked, false);
    // The Worker returned before the stream had data or ended. It remains live.
    streamController.enqueue(new TextEncoder().encode('data: live\n\n'));
    streamController.close();
    assert.equal(await response.text(), 'data: live\n\n');
  });

  test('Worker annotates immutable redirects and database-unavailable responses', async () => {
    let ready = true;
    const { default: worker } = await loadModule('../src/worker.js', {
      'cloudflare:node': { httpServerHandler: () => ({ fetch: async () => Response.redirect('https://clawfix.test/new', 307) }) },
      './server.js': { app: { listen() {} } },
      './db.js': { ensureDBReady: async () => ready, getPool: () => null },
      './shared-state.js': { cleanupSharedState() {} },
    });
    const env = { CF_VERSION_METADATA: { id: 'current-version' } };
    const response = await worker.fetch(new Request('https://clawfix.test/'), env, {});
    assert.equal(response.status, 307);
    assert.equal(response.headers.get('Location'), 'https://clawfix.test/new');
    assert.equal(response.headers.get('X-ClawFix-Version-ID'), 'current-version');
    ready = false;
    const unavailable = await worker.fetch(new Request('https://clawfix.test/'), env, {});
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get('Cache-Control'), 'no-store');
    assert.equal(unavailable.headers.get('X-ClawFix-Version-ID'), 'current-version');
    assert.deepEqual(await unavailable.json(), { error: 'Database unavailable' });
  });

  test('Worker leaves responses unchanged when version metadata is absent', async () => {
    const upstream = new Response(null, { status: 204, headers: { 'X-Original': 'preserved' } });
    const { default: worker } = await loadModule('../src/worker.js', {
      'cloudflare:node': { httpServerHandler: () => ({ fetch: async () => upstream }) },
      './server.js': { app: { listen() {} } },
      './db.js': { ensureDBReady: async () => true, getPool: () => null },
      './shared-state.js': { cleanupSharedState() {} },
    });
    assert.equal(await worker.fetch(new Request('https://clawfix.test/'), {}, {}), upstream);
    assert.equal(upstream.headers.has('X-ClawFix-Version-ID'), false);
  });

  test('Worker schedule uses readiness and shared-state cleanup only', async () => {
    const db = {};
    const calls = [];
    const { default: worker } = await loadModule('../src/worker.js', {
      'cloudflare:node': { httpServerHandler: () => ({}) },
      './server.js': { app: { listen() {} } },
      './db.js': { ensureDBReady: async () => { calls.push('ready'); return true; }, getPool: () => db },
      './shared-state.js': { cleanupSharedState: async options => { assert.equal(options.db, db); calls.push('cleanup'); } },
    });
    await worker.scheduled({}, {}, {});
    assert.deepEqual(calls, ['ready', 'cleanup']);
  });

  test('runtime config preserves existing exposure, bindings, schedule and version metadata', async () => {
    const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
    assert.equal(config.account_id, 'e320a5a80611f9a30148d452929b1fb1');
    assert.equal(config.keep_vars, true);
    assert.equal(config.workers_dev, true);
    assert.equal(config.preview_urls, true);
    assert.equal(Object.hasOwn(config, 'routes'), false);
    assert.equal(config.compatibility_date, '2026-09-01');
    assert.deepEqual(config.triggers.crons, ['*/15 * * * *']);
    assert.deepEqual(config.hyperdrive, [{ binding: 'HYPERDRIVE', id: '054e6fd0b1bb4910906bd052fbd288fc' }]);
    assert.deepEqual(config.version_metadata, { binding: 'CF_VERSION_METADATA' });
  });

  for (const route of ['chat', 'agent-v2']) {
    for (const failingGuard of ['conversation', 'ai']) {
      test(`${route} independently releases both guards when ${failingGuard} cleanup keeps failing`, async () => {
        const calls = { conversation: 0, ai: 0 };
        let handler;
        const release = name => async () => {
          calls[name] += 1;
          if (name === failingGuard) throw new Error(`synthetic ${name} release failure`);
        };
        const security = await loadModule('../src/security.js', { './db.js': { getPool: () => null } });
        await loadModule(`../src/routes/${route}.js`, {
          express: { Router: () => ({ post(_path, callback) { handler = callback; } }) },
          '../db.js': { getPool: () => null, getDiagnosis: async () => null },
          '../ai.js': { getAIConfig: () => ({ timeoutMs: 1000 }), requestAI() { throw new Error('Unexpected provider access'); } },
          '../security.js': {
            ...security,
            consumeRouteRateLimit: async () => ({ allowed: true }),
            isPaidAIEnabled: () => true,
            sharedAIRequestGuard: { acquire: async () => ({ allowed: true, release: release('ai') }) },
          },
          '../shared-state.js': {
            acquireConcurrencyLease: async () => ({ allowed: true, release: release('conversation') }),
            beginConversationTurn: async () => { throw new Error('synthetic turn failure'); },
            appendConversationMessage() { throw new Error('Unexpected conversation write'); },
          },
        });
        const response = new EventEmitter();
        Object.assign(response, {
          headersSent: false,
          status(code) { this.statusCode = code; return this; },
          json(body) { this.body = body; this.headersSent = true; return this; },
        });
        await assert.doesNotReject(handler({ body: {
          conversationId: '11111111-1111-4111-8111-111111111111',
          message: 'hello', availableRepairs: [],
        } }, response));
        assert.equal(response.statusCode, 500);
        assert.ok(calls.conversation >= 1);
        assert.ok(calls.ai >= 1);
        assert.equal(calls[failingGuard === 'ai' ? 'conversation' : 'ai'], 1,
          'a successfully released guard must not be released twice');
      });
    }
  }
}
