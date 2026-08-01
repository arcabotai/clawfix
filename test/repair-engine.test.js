import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createRepairEngine } from '../cli/core/repair-engine.js';
import { normalizeFindings } from '../cli/core/findings.js';

function gatewayFinding(overrides = {}) {
  const [finding] = normalizeFindings({
    localIssues: [{ severity: 'high', text: 'Gateway is not running', ...overrides }],
    knownRepairIds: ['gateway-not-running'],
  });
  return finding;
}

function fakeCatalogEntry({ preflightOk = true, verifyOk = true } = {}) {
  const calls = [];
  return {
    calls,
    title: 'Restart the OpenClaw gateway',
    description: 'test entry',
    risk: 'low',
    async preflight() {
      calls.push('preflight');
      return preflightOk ? { ok: true, evidence: {} } : { ok: false, reason: 'gateway_already_running', evidence: {} };
    },
    async preview() {
      calls.push('preview');
      return { steps: ['do it'] };
    },
    async apply() {
      calls.push('apply');
      return { status: 0 };
    },
    async verify() {
      calls.push('verify');
      return { ok: verifyOk, evidence: {} };
    },
    async rollback() {
      calls.push('rollback');
      return { rolledBack: false, note: 'nothing to revert' };
    },
  };
}

test('createPlan freezes a plan tied to the finding, revision, and a fingerprint', () => {
  const finding = gatewayFinding();
  const engine = createRepairEngine({ catalog: { 'gateway-not-running': fakeCatalogEntry() } });
  const plan = engine.createPlan({ finding, revision: 'rev-1' });

  assert.equal(plan.repairId, 'gateway-not-running');
  assert.equal(plan.findingId, finding.id);
  assert.equal(plan.revision, 'rev-1');
  assert.equal(typeof plan.fingerprint, 'string');
  assert.equal(typeof plan.approvalToken, 'string');
  assert.ok(Object.isFrozen(plan));
});

test('createPlan refuses a finding that is not repairable', () => {
  const [nonRepairable] = normalizeFindings({
    localIssues: [{ severity: 'medium', text: 'Something unrelated' }],
    knownRepairIds: ['gateway-not-running'],
  });
  const engine = createRepairEngine({ catalog: { 'gateway-not-running': fakeCatalogEntry() } });
  assert.throws(() => engine.createPlan({ finding: nonRepairable, revision: 'rev-1' }));
});

test('applyPlan runs preflight -> preview -> apply -> verify and reports applied on success', async () => {
  const finding = gatewayFinding();
  const entry = fakeCatalogEntry();
  const engine = createRepairEngine({ catalog: { 'gateway-not-running': entry } });
  const plan = engine.createPlan({ finding, revision: 'rev-1' });

  const result = await engine.applyPlan({
    planId: plan.planId,
    approvalToken: plan.approvalToken,
    revision: 'rev-1',
    finding,
    ctx: {},
  });

  assert.equal(result.status, 'applied');
  assert.deepEqual(entry.calls, ['preflight', 'preview', 'apply', 'verify']);
});

test('applyPlan rolls back and reports verify_failed when runtime verification fails', async () => {
  const finding = gatewayFinding();
  const entry = fakeCatalogEntry({ verifyOk: false });
  const engine = createRepairEngine({ catalog: { 'gateway-not-running': entry } });
  const plan = engine.createPlan({ finding, revision: 'rev-1' });

  const result = await engine.applyPlan({
    planId: plan.planId,
    approvalToken: plan.approvalToken,
    revision: 'rev-1',
    finding,
    ctx: {},
  });

  assert.equal(result.status, 'verify_failed');
  assert.deepEqual(entry.calls, ['preflight', 'preview', 'apply', 'verify', 'rollback']);
});

test('applyPlan never reports applied when the adapter apply step returns a failure status', async () => {
  const finding = gatewayFinding();
  const entry = fakeCatalogEntry();
  entry.apply = async () => {
    entry.calls.push('apply');
    return { status: 1, stage: 'generate-token' };
  };
  const engine = createRepairEngine({ catalog: { 'gateway-not-running': entry } });
  const plan = engine.createPlan({ finding, revision: 'rev-1' });

  const result = await engine.applyPlan({
    planId: plan.planId,
    approvalToken: plan.approvalToken,
    revision: 'rev-1',
    finding,
    ctx: {},
  });

  assert.equal(result.status, 'verify_failed');
  assert.equal(result.verify.ok, false);
  assert.deepEqual(entry.calls, ['preflight', 'preview', 'apply', 'rollback']);
});

test('applyPlan is blocked without ever calling apply when preflight evidence says it is unnecessary', async () => {
  const finding = gatewayFinding();
  const entry = fakeCatalogEntry({ preflightOk: false });
  const engine = createRepairEngine({ catalog: { 'gateway-not-running': entry } });
  const plan = engine.createPlan({ finding, revision: 'rev-1' });

  const result = await engine.applyPlan({
    planId: plan.planId,
    approvalToken: plan.approvalToken,
    revision: 'rev-1',
    finding,
    ctx: {},
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'gateway_already_running');
  assert.deepEqual(entry.calls, ['preflight']);
});

test('applyPlan rejects a stale plan when the revision has moved on', async () => {
  const finding = gatewayFinding();
  const entry = fakeCatalogEntry();
  const engine = createRepairEngine({ catalog: { 'gateway-not-running': entry } });
  const plan = engine.createPlan({ finding, revision: 'rev-1' });

  const result = await engine.applyPlan({
    planId: plan.planId,
    approvalToken: plan.approvalToken,
    revision: 'rev-2', // a new scan happened since the plan was created
    finding,
    ctx: {},
  });

  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'stale_plan');
  assert.deepEqual(entry.calls, []);
});

test('applyPlan rejects a stale plan when the finding evidence has changed under the same revision', async () => {
  const finding = gatewayFinding();
  const changedFinding = { ...finding, evidence: [{ label: 'path', detail: 'changed' }] };
  const entry = fakeCatalogEntry();
  const engine = createRepairEngine({ catalog: { 'gateway-not-running': entry } });
  const plan = engine.createPlan({ finding, revision: 'rev-1' });

  const result = await engine.applyPlan({
    planId: plan.planId,
    approvalToken: plan.approvalToken,
    revision: 'rev-1',
    finding: changedFinding,
    ctx: {},
  });

  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'stale_plan');
});

test('applyPlan rejects an invalid approval token without consuming the real one', async () => {
  const finding = gatewayFinding();
  const entry = fakeCatalogEntry();
  const engine = createRepairEngine({ catalog: { 'gateway-not-running': entry } });
  const plan = engine.createPlan({ finding, revision: 'rev-1' });

  const wrongAttempt = await engine.applyPlan({
    planId: plan.planId,
    approvalToken: 'not-the-real-token',
    revision: 'rev-1',
    finding,
    ctx: {},
  });
  assert.equal(wrongAttempt.status, 'rejected');
  assert.equal(wrongAttempt.reason, 'invalid_token');

  const realAttempt = await engine.applyPlan({
    planId: plan.planId,
    approvalToken: plan.approvalToken,
    revision: 'rev-1',
    finding,
    ctx: {},
  });
  assert.equal(realAttempt.status, 'applied');
});

test('applyPlan rejects token reuse: a second redemption of the same plan never re-applies', async () => {
  const finding = gatewayFinding();
  const entry = fakeCatalogEntry();
  const engine = createRepairEngine({ catalog: { 'gateway-not-running': entry } });
  const plan = engine.createPlan({ finding, revision: 'rev-1' });

  const first = await engine.applyPlan({
    planId: plan.planId,
    approvalToken: plan.approvalToken,
    revision: 'rev-1',
    finding,
    ctx: {},
  });
  assert.equal(first.status, 'applied');
  assert.equal(entry.calls.filter((call) => call === 'apply').length, 1);

  const second = await engine.applyPlan({
    planId: plan.planId,
    approvalToken: plan.approvalToken,
    revision: 'rev-1',
    finding,
    ctx: {},
  });
  assert.equal(second.status, 'rejected');
  assert.equal(second.reason, 'token_reused');
  assert.equal(entry.calls.filter((call) => call === 'apply').length, 1, 'apply must not run a second time');
});

test('two plans for the same finding get different tokens, and each others token is rejected', async () => {
  const finding = gatewayFinding();
  const entry = fakeCatalogEntry();
  const engine = createRepairEngine({ catalog: { 'gateway-not-running': entry } });
  const planA = engine.createPlan({ finding, revision: 'rev-1' });
  const planB = engine.createPlan({ finding, revision: 'rev-1' });

  assert.notEqual(planA.approvalToken, planB.approvalToken);
  assert.notEqual(planA.planId, planB.planId);

  const crossResult = await engine.applyPlan({
    planId: planA.planId,
    approvalToken: planB.approvalToken,
    revision: 'rev-1',
    finding,
    ctx: {},
  });
  assert.equal(crossResult.status, 'rejected');
  assert.equal(crossResult.reason, 'invalid_token');
});

test('the real fix command routes catalog repairs through the repair engine before legacy fixes', async () => {
  const source = await readFile(new URL('../cli/interfaces/plain.js', import.meta.url), 'utf8');
  assert.match(source, /const catalogRepair = repairCatalog\[issue\.repairId\]/);
  assert.match(source, /knownRepairIds: \[\.\.\.new Set\(\[\.\.\.Object\.keys\(BUILTIN_FIXES\), \.\.\.Object\.keys\(repairCatalog\)\]\)\]/);
  assert.match(source, /if \(catalogRepair\) \{\s*await applyCatalogRepair\(issue, rl, session\)/);
  assert.match(source, /Repair applied and verified\./);
  assert.match(source, /Repair ran, but runtime verification failed\./);
  assert.doesNotMatch(source, /Gateway restarted and verified\./);
  assert.match(source, /revision: result\.revision/);
  assert.match(source, /Batch repair is disabled/);
  assert.match(source, /Apply\?'.*\[y\/N\]/);
  assert.doesNotMatch(source, /function applyAllFixes|\[Y\/n\]/);
});

// ============================================================
// Risk refusal and stage-failure containment
// ============================================================

test('applyPlan refuses high and critical risk repairs without running them', async () => {
  for (const risk of ['high', 'critical', 'HIGH']) {
    const finding = gatewayFinding();
    const entry = { ...fakeCatalogEntry(), risk };
    const engine = createRepairEngine({ catalog: { 'gateway-not-running': entry } });
    const plan = engine.createPlan({ finding, revision: 'rev-1' });

    const outcome = await engine.applyPlan({
      planId: plan.planId,
      approvalToken: plan.approvalToken,
      revision: 'rev-1',
      finding,
      ctx: {},
    });

    assert.equal(outcome.status, 'blocked', `risk=${risk}`);
    assert.equal(outcome.reason, 'risk_refused');
    // Nothing ran — not even preflight.
    assert.deepEqual(entry.calls, []);
  }
});

test('applyPlan still applies low and medium risk repairs', async () => {
  for (const risk of ['low', 'medium']) {
    const finding = gatewayFinding();
    const entry = { ...fakeCatalogEntry(), risk };
    const engine = createRepairEngine({ catalog: { 'gateway-not-running': entry } });
    const plan = engine.createPlan({ finding, revision: 'rev-1' });

    const outcome = await engine.applyPlan({
      planId: plan.planId,
      approvalToken: plan.approvalToken,
      revision: 'rev-1',
      finding,
      ctx: {},
    });
    assert.equal(outcome.status, 'applied', `risk=${risk}`);
  }
});

test('a throwing verify reports verify_failed with the apply result, not a rejected promise', async () => {
  const finding = gatewayFinding();
  const entry = fakeCatalogEntry();
  entry.verify = async () => { throw new Error('verify exploded'); };
  const engine = createRepairEngine({ catalog: { 'gateway-not-running': entry } });
  const plan = engine.createPlan({ finding, revision: 'rev-1' });

  const outcome = await engine.applyPlan({
    planId: plan.planId,
    approvalToken: plan.approvalToken,
    revision: 'rev-1',
    finding,
    ctx: {},
  });

  assert.equal(outcome.status, 'verify_failed');
  assert.equal(outcome.verify.ok, false);
  assert.match(outcome.verify.error, /verify exploded/);
  // The caller must still learn that the repair already ran.
  assert.deepEqual(outcome.applyResult, { status: 0 });
  assert.ok(outcome.rollback);
});

test('a throwing rollback does not mask the verify failure', async () => {
  const finding = gatewayFinding();
  const entry = fakeCatalogEntry({ verifyOk: false });
  entry.rollback = async () => { throw new Error('rollback exploded'); };
  const engine = createRepairEngine({ catalog: { 'gateway-not-running': entry } });
  const plan = engine.createPlan({ finding, revision: 'rev-1' });

  const outcome = await engine.applyPlan({
    planId: plan.planId,
    approvalToken: plan.approvalToken,
    revision: 'rev-1',
    finding,
    ctx: {},
  });

  assert.equal(outcome.status, 'verify_failed');
  assert.equal(outcome.rollback.rolledBack, false);
  assert.match(outcome.rollback.note, /rollback failed: rollback exploded/);
});

test('a throwing apply attempts rollback and preserves a partial-change outcome', async () => {
  const finding = gatewayFinding();
  const entry = fakeCatalogEntry();
  entry.apply = async () => {
    entry.calls.push('apply');
    throw new Error('second step crashed');
  };
  const engine = createRepairEngine({ catalog: { 'gateway-not-running': entry } });
  const plan = engine.createPlan({ finding, revision: 'rev-1' });

  const outcome = await engine.applyPlan({
    planId: plan.planId,
    approvalToken: plan.approvalToken,
    revision: 'rev-1',
    finding,
    ctx: {},
  });

  assert.equal(outcome.status, 'error');
  assert.match(outcome.error, /apply failed: second step crashed/);
  assert.equal(outcome.applyResult.changed, 'unknown');
  assert.deepEqual(entry.calls, ['preflight', 'preview', 'apply', 'rollback']);
  assert.ok(outcome.rollback);
});

test('a failed apply result rolls back recorded changes and never verifies', async () => {
  const finding = gatewayFinding();
  const entry = fakeCatalogEntry();
  entry.apply = async () => {
    entry.calls.push('apply');
    return {
      status: 1,
      changed: true,
      changes: [{ type: 'config', key: 'gateway.auth.mode', before: 'none', after: 'token' }],
      errorSummary: 'second step failed',
    };
  };
  const engine = createRepairEngine({ catalog: { 'gateway-not-running': entry } });
  const plan = engine.createPlan({ finding, revision: 'rev-1' });

  const outcome = await engine.applyPlan({
    planId: plan.planId,
    approvalToken: plan.approvalToken,
    revision: 'rev-1',
    finding,
    ctx: {},
  });

  assert.equal(outcome.status, 'error');
  assert.match(outcome.error, /apply failed: second step failed/);
  assert.deepEqual(entry.calls, ['preflight', 'preview', 'apply', 'rollback']);
  assert.equal(entry.calls.includes('verify'), false);
});

test('a throwing preflight reports an error outcome instead of rejecting', async () => {
  const finding = gatewayFinding();
  const entry = fakeCatalogEntry();
  entry.preflight = async () => { throw new Error('preflight exploded'); };
  const engine = createRepairEngine({ catalog: { 'gateway-not-running': entry } });
  const plan = engine.createPlan({ finding, revision: 'rev-1' });

  const outcome = await engine.applyPlan({
    planId: plan.planId,
    approvalToken: plan.approvalToken,
    revision: 'rev-1',
    finding,
    ctx: {},
  });

  assert.equal(outcome.status, 'error');
  assert.match(outcome.error, /preflight failed: preflight exploded/);
  assert.equal(entry.calls.includes('apply'), false);
});
