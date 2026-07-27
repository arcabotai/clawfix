import test from 'node:test';
import assert from 'node:assert/strict';

import { repairCatalog } from '../cli/core/repair-catalog.js';

function fakeOpenClaw({ statusText = '', pid = '', invokeResult } = {}) {
  const calls = [];
  return {
    calls,
    gatewayStatusText: async () => statusText,
    gatewayProcesses: async () => pid,
    invoke: async (argv, options) => {
      calls.push({ argv, options });
      return invokeResult ?? { status: 0, timedOut: false, errorSummary: null, stdout: '' };
    },
  };
}

test('gateway-not-running is registered under a stable id and carries the required contract fields', () => {
  const entry = repairCatalog['gateway-not-running'];
  assert.ok(entry, 'expected a gateway-not-running catalog entry');
  assert.equal(entry.id, 'gateway-not-running');
  assert.equal(typeof entry.title, 'string');
  assert.equal(typeof entry.description, 'string');
  assert.equal(typeof entry.risk, 'string');
  for (const fn of ['preflight', 'preview', 'apply', 'verify', 'rollback']) {
    assert.equal(typeof entry[fn], 'function', `expected entry.${fn} to be a function`);
  }
});

test('preflight reports ok when the gateway is currently down', async () => {
  const entry = repairCatalog['gateway-not-running'];
  const ctx = { openclaw: fakeOpenClaw({ statusText: 'state not running', pid: '' }) };
  const result = await entry.preflight(ctx);
  assert.equal(result.ok, true);
  assert.equal(result.evidence.running, false);
});

test('preflight blocks when runtime evidence already shows the gateway running', async () => {
  const entry = repairCatalog['gateway-not-running'];
  const ctx = { openclaw: fakeOpenClaw({ statusText: 'state active, running with pid 123', pid: '123' }) };
  const result = await entry.preflight(ctx);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'gateway_already_running');
});

test('preview describes the plan without touching any adapter', async () => {
  const entry = repairCatalog['gateway-not-running'];
  const ctx = { openclaw: fakeOpenClaw() };
  const preview = await entry.preview(ctx);
  assert.ok(Array.isArray(preview.steps) && preview.steps.length > 0);
  assert.equal(ctx.openclaw.calls.length, 0);
});

test('apply invokes the OpenClaw adapter with an argv array, never a shell string', async () => {
  const entry = repairCatalog['gateway-not-running'];
  const openclaw = fakeOpenClaw();
  const ctx = { openclaw };
  await entry.apply(ctx);
  assert.equal(openclaw.calls.length, 1);
  const [{ argv }] = openclaw.calls;
  assert.ok(Array.isArray(argv));
  assert.deepEqual(argv, ['gateway', 'restart']);
  for (const part of argv) {
    assert.equal(typeof part, 'string');
  }
});

test('verify uses live runtime evidence (process/port), not any title comparison', async () => {
  const entry = repairCatalog['gateway-not-running'];
  const ctx = {
    openclaw: fakeOpenClaw({ statusText: 'state active, running with pid 456', pid: '456' }),
    wait: async () => {},
  };
  const result = await entry.verify(ctx);
  assert.equal(result.ok, true);
  assert.equal(result.evidence.pid, '456');
});

test('verify reports failure when runtime evidence still shows the gateway down', async () => {
  const entry = repairCatalog['gateway-not-running'];
  const ctx = { openclaw: fakeOpenClaw({ statusText: 'not running', pid: '' }), wait: async () => {} };
  const result = await entry.verify(ctx);
  assert.equal(result.ok, false);
});

test('rollback is informational only — a gateway restart has no state to revert', async () => {
  const entry = repairCatalog['gateway-not-running'];
  const result = await entry.rollback({ openclaw: fakeOpenClaw() }, { applyResult: {} });
  assert.equal(result.rolledBack, false);
  assert.equal(typeof result.note, 'string');
});

// ============================================================
// Gateway liveness: the port is the verdict
//
// verify() previously returned ok:true with nothing listening, because the PID probe matched
// ClawFix's own concurrent `openclaw gateway status` call. That let a repair which changed
// nothing be reported as `applied`.
// ============================================================

function gatewayCtx({ listening, pid = '', statusText = 'Service: systemd user (disabled)' }) {
  return {
    openclaw: {
      async gatewayStatusText() { return statusText; },
      async gatewayProcesses() { return pid; },
      async gatewayListening() { return listening; },
    },
    wait: async () => {},
  };
}

test('verify fails when nothing is listening, even if a PID probe matches', async () => {
  const entry = repairCatalog['gateway-not-running'];
  // A stray PID must not outvote an unlistening port.
  const result = await entry.verify(gatewayCtx({ listening: false, pid: '4242' }));
  assert.equal(result.ok, false);
  assert.equal(result.evidence.listening, false);
});

test('verify succeeds when the gateway port is accepting connections', async () => {
  const entry = repairCatalog['gateway-not-running'];
  const result = await entry.verify(gatewayCtx({ listening: true, pid: '4242' }));
  assert.equal(result.ok, true);
  assert.equal(result.evidence.listening, true);
});

test('preflight allows the repair when the port is closed', async () => {
  const entry = repairCatalog['gateway-not-running'];
  const result = await entry.preflight(gatewayCtx({ listening: false }));
  assert.equal(result.ok, true);
});

test('preflight blocks the repair when the gateway is already up', async () => {
  const entry = repairCatalog['gateway-not-running'];
  const result = await entry.preflight(gatewayCtx({ listening: true, pid: '4242' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'gateway_already_running');
});

test('status prose alone never counts as the gateway running', async () => {
  const entry = repairCatalog['gateway-not-running'];
  const result = await entry.verify(gatewayCtx({
    listening: false,
    statusText: 'Gateway: running, pid 999\nstate active',
  }));
  assert.equal(result.ok, false);
});

test('without a port probe the filtered PID evidence is used', async () => {
  const entry = repairCatalog['gateway-not-running'];
  const ctx = {
    openclaw: {
      async gatewayStatusText() { return ''; },
      async gatewayProcesses() { return '4242'; },
      // Older adapter with no port probe at all.
    },
    wait: async () => {},
  };
  const result = await entry.verify(ctx);
  assert.equal(result.ok, true);
  assert.equal(result.evidence.listening, null);
});

// ============================================================
// auto-update-enabled-warning
// ============================================================

function configCtx(values, {
  setStatus = 0,
  invokeStatus = 0,
  invokeThrows = false,
  invokeCreatesToken = true,
  invokeCreatesTokenOnFailure = false,
  setNoOpKeys = [],
  unsetStatus = 0,
  unsetNoOpKeys = [],
  unreadableKeys = [],
  unreadableOnGetCounts = {},
} = {}) {
  const store = { ...values };
  const calls = [];
  const getCounts = new Map();
  return {
    calls,
    store,
    ctx: {
      openclaw: {
        async configGet(key) {
          calls.push(['get', key]);
          const count = (getCounts.get(key) ?? 0) + 1;
          getCounts.set(key, count);
          if (unreadableKeys.includes(key)
              || unreadableOnGetCounts[key]?.includes(count)) {
            return { ok: false, value: '', status: 1, errorSummary: 'read failed' };
          }
          return { ok: true, value: store[key] ?? '', status: 0, errorSummary: null };
        },
        async configHasValue(key) {
          calls.push(['has', key]);
          const count = (getCounts.get(key) ?? 0) + 1;
          getCounts.set(key, count);
          if (unreadableKeys.includes(key)
              || unreadableOnGetCounts[key]?.includes(count)) {
            return { ok: false, present: false, status: 1, errorSummary: 'read failed' };
          }
          return {
            ok: true,
            present: String(store[key] ?? '').trim().length > 0,
            status: 0,
            errorSummary: null,
          };
        },
        async configSet(key, value) {
          calls.push(['set', key, value]);
          if (setStatus === 0 && !setNoOpKeys.includes(key)) store[key] = String(value);
          return { status: setStatus };
        },
        async configUnset(key) {
          calls.push(['unset', key]);
          if (unsetStatus === 0 && !unsetNoOpKeys.includes(key)) delete store[key];
          return { status: unsetStatus };
        },
        async invoke(argv) {
          calls.push(['invoke', argv.join(' ')]);
          if (invokeThrows) throw new Error('token generation crashed');
          if ((invokeStatus === 0 && invokeCreatesToken)
              || (invokeStatus !== 0 && invokeCreatesTokenOnFailure)) {
            store['gateway.auth.token'] = 'generated-secret';
          }
          return { status: invokeStatus, errorSummary: invokeStatus === 0 ? null : 'token generation failed' };
        },
        async gatewayStatusText() { return ''; },
        async gatewayProcesses() { return ''; },
        async gatewayListening() { return false; },
      },
      wait: async () => {},
    },
  };
}

test('auto-update repair turns the flag off and verifies by reading it back', async () => {
  const entry = repairCatalog['auto-update-enabled-warning'];
  const { ctx, store } = configCtx({ 'update.auto.enabled': 'true' });

  assert.equal((await entry.preflight(ctx)).ok, true);
  const applied = await entry.apply(ctx);
  assert.equal(applied.status, 0);
  assert.equal(store['update.auto.enabled'], 'false');
  assert.equal((await entry.verify(ctx)).ok, true);
});

test('auto-update repair is blocked when it is already disabled', async () => {
  const entry = repairCatalog['auto-update-enabled-warning'];
  const { ctx } = configCtx({ 'update.auto.enabled': 'false' });
  const pre = await entry.preflight(ctx);
  assert.equal(pre.ok, false);
  assert.equal(pre.reason, 'auto_update_already_disabled');
});

test('auto-update repair refuses to act on an unreadable flag rather than guessing', async () => {
  const entry = repairCatalog['auto-update-enabled-warning'];
  const { ctx } = configCtx({});
  const pre = await entry.preflight(ctx);
  assert.equal(pre.ok, false);
  assert.equal(pre.reason, 'config_state_unknown');
});

test('auto-update verify fails when the value did not actually change', async () => {
  const entry = repairCatalog['auto-update-enabled-warning'];
  const { ctx } = configCtx({ 'update.auto.enabled': 'true' }, { setStatus: 1 });
  await entry.apply(ctx);
  assert.equal((await entry.verify(ctx)).ok, false);
});

test('auto-update rollback restores the previous value', async () => {
  const entry = repairCatalog['auto-update-enabled-warning'];
  const { ctx, store } = configCtx({ 'update.auto.enabled': 'true' });
  await entry.apply(ctx);
  const back = await entry.rollback(ctx);
  assert.equal(back.rolledBack, true);
  assert.equal(store['update.auto.enabled'], 'true');
});

// ============================================================
// gateway-loopback-no-auth
// ============================================================

test('gateway auth repair sets token mode and has OpenClaw generate the token', async () => {
  const entry = repairCatalog['gateway-loopback-no-auth'];
  const { ctx, calls, store } = configCtx({ 'gateway.auth.mode': 'none' });

  assert.equal((await entry.preflight(ctx)).ok, true);
  const applied = await entry.apply(ctx);
  assert.equal(applied.status, 0);
  assert.equal(store['gateway.auth.mode'], 'token');
  assert.equal(store['gateway.auth.token'], 'generated-secret');
  assert.deepEqual(calls.at(-1), ['invoke', 'doctor --fix --generate-gateway-token']);
  assert.equal((await entry.verify(ctx)).ok, true);
});

test('gateway auth repair verifies token presence without exposing its value', async () => {
  const entry = repairCatalog['gateway-loopback-no-auth'];
  const { ctx } = configCtx({ 'gateway.auth.mode': 'none' });
  await entry.apply(ctx);
  const verify = await entry.verify(ctx);

  assert.equal(verify.ok, true);
  assert.equal(verify.evidence.tokenPresent, true);
  assert.equal(JSON.stringify(verify).includes('generated-secret'), false);
});

test('gateway auth repair reuses an existing token without invoking the generator', async () => {
  const entry = repairCatalog['gateway-loopback-no-auth'];
  const { ctx, calls, store } = configCtx({
    'gateway.auth.mode': 'none',
    'gateway.auth.token': 'existing-secret',
  });

  const applied = await entry.apply(ctx);
  assert.equal(applied.status, 0);
  assert.equal(applied.tokenPreviouslyPresent, true);
  assert.equal(calls.some(([verb]) => verb === 'invoke'), false);
  assert.equal(store['gateway.auth.token'], 'existing-secret');
  assert.equal((await entry.verify(ctx)).ok, true);
});

test('gateway auth repair is blocked when auth is already required', async () => {
  const entry = repairCatalog['gateway-loopback-no-auth'];
  for (const mode of ['token', 'password', 'trusted-proxy']) {
    const { ctx } = configCtx({ 'gateway.auth.mode': mode });
    const pre = await entry.preflight(ctx);
    assert.equal(pre.ok, false, mode);
    assert.equal(pre.reason, 'gateway_auth_already_enabled');
  }
});

test('gateway auth repair blocks when the current mode cannot be read', async () => {
  const entry = repairCatalog['gateway-loopback-no-auth'];
  const { ctx, calls } = configCtx({}, { unreadableKeys: ['gateway.auth.mode'] });
  const preflight = await entry.preflight(ctx);

  assert.equal(preflight.ok, false);
  assert.equal(preflight.reason, 'config_state_unknown');
  assert.match(preflight.evidence.errorSummary, /read failed/);
  assert.equal(calls.some(([verb]) => verb === 'set'), false);
});

test('gateway auth repair fails verification when doctor exits zero without a token', async () => {
  const entry = repairCatalog['gateway-loopback-no-auth'];
  const { ctx } = configCtx(
    { 'gateway.auth.mode': 'none' },
    { invokeCreatesToken: false },
  );

  const applied = await entry.apply(ctx);
  assert.equal(applied.status, 0);
  assert.equal((await entry.verify(ctx)).ok, false);
});

test('gateway auth repair removes a partially generated token during rollback', async () => {
  const entry = repairCatalog['gateway-loopback-no-auth'];
  const { ctx, store } = configCtx(
    { 'gateway.auth.mode': 'none' },
    { invokeStatus: 1, invokeCreatesTokenOnFailure: true },
  );
  const preflight = await entry.preflight(ctx);
  const applied = await entry.apply(ctx);

  assert.equal(applied.status, 1);
  assert.equal(applied.changed, true);
  assert.equal(applied.stage, 'generate-token');
  assert.deepEqual(applied.changes, [{
    type: 'config',
    key: 'gateway.auth.mode',
    before: 'none',
    after: 'token',
  }]);
  assert.equal(store['gateway.auth.mode'], 'token');
  assert.equal(store['gateway.auth.token'], 'generated-secret');

  const rollback = await entry.rollback(ctx, { applyResult: applied, preflight });
  assert.equal(rollback.rolledBack, true);
  assert.equal(store['gateway.auth.mode'], 'none');
  assert.equal('gateway.auth.token' in store, false);
});

test('gateway auth rollback rejects a status-zero mode no-op', async () => {
  const entry = repairCatalog['gateway-loopback-no-auth'];
  const { ctx, store } = configCtx(
    { 'gateway.auth.mode': 'token', 'gateway.auth.token': 'generated-secret' },
    { setNoOpKeys: ['gateway.auth.mode'] },
  );
  const rollback = await entry.rollback(ctx, {
    applyResult: {
      changed: true,
      tokenPreviouslyPresent: false,
      tokenMayHaveChanged: true,
    },
  });

  assert.equal(rollback.rolledBack, false);
  assert.equal(store['gateway.auth.mode'], 'token');
  assert.equal(store['gateway.auth.token'], 'generated-secret');
});

test('gateway auth rollback rejects an unreadable post-rollback mode', async () => {
  const entry = repairCatalog['gateway-loopback-no-auth'];
  const { ctx } = configCtx(
    { 'gateway.auth.mode': 'token' },
    { unreadableOnGetCounts: { 'gateway.auth.mode': [1] } },
  );
  const rollback = await entry.rollback(ctx, {
    applyResult: { changed: true, tokenPreviouslyPresent: true, tokenMayHaveChanged: false },
  });

  assert.equal(rollback.rolledBack, false);
  assert.match(rollback.note, /could not be read back/i);
});

test('gateway auth rollback rejects a status-zero token-unset no-op', async () => {
  const entry = repairCatalog['gateway-loopback-no-auth'];
  const { ctx, store } = configCtx(
    { 'gateway.auth.mode': 'token', 'gateway.auth.token': 'generated-secret' },
    { unsetNoOpKeys: ['gateway.auth.token'] },
  );
  const rollback = await entry.rollback(ctx, {
    applyResult: {
      changed: true,
      tokenPreviouslyPresent: false,
      tokenMayHaveChanged: true,
    },
  });

  assert.equal(rollback.rolledBack, false);
  assert.equal(store['gateway.auth.mode'], 'none');
  assert.equal(store['gateway.auth.token'], 'generated-secret');
});

test('gateway auth rollback rejects unreadable token state after removal', async () => {
  const entry = repairCatalog['gateway-loopback-no-auth'];
  const { ctx, store } = configCtx(
    { 'gateway.auth.mode': 'token', 'gateway.auth.token': 'generated-secret' },
    { unreadableOnGetCounts: { 'gateway.auth.token': [1] } },
  );
  const rollback = await entry.rollback(ctx, {
    applyResult: {
      changed: true,
      tokenPreviouslyPresent: false,
      tokenMayHaveChanged: true,
    },
  });

  assert.equal(rollback.rolledBack, false);
  assert.equal(store['gateway.auth.mode'], 'none');
  assert.equal('gateway.auth.token' in store, false);
  assert.match(rollback.note, /absence could not be verified/i);
});

test('gateway auth repair carries medium risk and says clients need the new token', async () => {
  const entry = repairCatalog['gateway-loopback-no-auth'];
  assert.equal(entry.risk, 'medium');
  const preview = await entry.preview();
  assert.match(preview.steps.join(' '), /existing clients need the new token/i);
});

test('the catalog exposes exactly the repairs the findings map can authorize', async () => {
  const { default: fs } = await import('node:fs/promises');
  const findings = await fs.readFile(new URL('../cli/core/findings.js', import.meta.url), 'utf8');
  for (const id of Object.keys(repairCatalog)) {
    assert.match(findings, new RegExp(`'${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`), `${id} is unmapped`);
  }
});

// ============================================================
// Config toggle repairs share one contract
// ============================================================

const TOGGLES = [
  { id: 'auto-update-enabled-warning', key: 'update.auto.enabled', from: 'true', to: 'false' },
  { id: 'no-hybrid-search', key: 'agents.defaults.memorySearch.query.hybrid.enabled', from: 'false', to: 'true' },
  { id: 'no-memory-flush', key: 'agents.defaults.compaction.memoryFlush.enabled', from: 'false', to: 'true' },
];

for (const toggle of TOGGLES) {
  test(`${toggle.id}: flips ${toggle.key} and verifies by reading it back`, async () => {
    const entry = repairCatalog[toggle.id];
    const { ctx, store } = configCtx({ [toggle.key]: toggle.from });

    assert.equal((await entry.preflight(ctx)).ok, true);
    assert.equal((await entry.apply(ctx)).status, 0);
    assert.equal(store[toggle.key], toggle.to);
    assert.equal((await entry.verify(ctx)).ok, true);
  });

  test(`${toggle.id}: is blocked when the key is already correct`, async () => {
    const entry = repairCatalog[toggle.id];
    const { ctx } = configCtx({ [toggle.key]: toggle.to });
    assert.equal((await entry.preflight(ctx)).ok, false);
  });

  test(`${toggle.id}: refuses an unreadable key instead of treating it as false`, async () => {
    const entry = repairCatalog[toggle.id];
    const { ctx } = configCtx({});
    const pre = await entry.preflight(ctx);
    assert.equal(pre.ok, false);
    assert.equal(pre.reason, 'config_state_unknown');
  });

  test(`${toggle.id}: verify fails when the set did not land`, async () => {
    const entry = repairCatalog[toggle.id];
    const { ctx } = configCtx({ [toggle.key]: toggle.from }, { setStatus: 1 });
    await entry.apply(ctx);
    assert.equal((await entry.verify(ctx)).ok, false);
  });

  test(`${toggle.id}: rollback restores the original value`, async () => {
    const entry = repairCatalog[toggle.id];
    const { ctx, store } = configCtx({ [toggle.key]: toggle.from });
    await entry.apply(ctx);
    assert.equal((await entry.rollback(ctx)).rolledBack, true);
    assert.equal(store[toggle.key], toggle.from);
  });

  test(`${toggle.id}: rollback rejects a status-zero setter no-op`, async () => {
    const entry = repairCatalog[toggle.id];
    const { ctx, store } = configCtx(
      { [toggle.key]: toggle.to },
      { setNoOpKeys: [toggle.key] },
    );
    const rollback = await entry.rollback(ctx);
    assert.equal(rollback.rolledBack, false);
    assert.equal(store[toggle.key], toggle.to);
  });

  test(`${toggle.id}: rollback rejects an unreadable restored value`, async () => {
    const entry = repairCatalog[toggle.id];
    const { ctx } = configCtx(
      { [toggle.key]: toggle.to },
      { unreadableOnGetCounts: { [toggle.key]: [1] } },
    );
    const rollback = await entry.rollback(ctx);
    assert.equal(rollback.rolledBack, false);
    assert.match(rollback.note, /could not be read back/i);
  });

  test(`${toggle.id}: preview names the exact command and has no side effects`, async () => {
    const entry = repairCatalog[toggle.id];
    const { ctx, calls } = configCtx({ [toggle.key]: toggle.from });
    const preview = await entry.preview(ctx);
    assert.match(preview.summary, new RegExp(`openclaw config set ${toggle.key.replace(/\./g, '\\.')} ${toggle.to}`));
    assert.equal(calls.some(([verb]) => verb === 'set'), false);
  });
}
