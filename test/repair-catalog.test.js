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
