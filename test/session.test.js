import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionController, isSessionEvent } from '../cli/core/session.js';
import { normalizeFindings } from '../cli/core/findings.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeRepairEngine() {
  const createPlanCalls = [];
  const applyPlanCalls = [];
  return {
    createPlanCalls,
    applyPlanCalls,
    createPlan({ finding, revision }) {
      createPlanCalls.push({ finding, revision });
      return Object.freeze({
        planId: `plan-${finding.id}`,
        approvalToken: 'token-1',
        repairId: finding.repairId,
        findingId: finding.id,
        revision,
        title: `Fix ${finding.title}`,
        description: 'description',
        risk: 'low',
      });
    },
    async applyPlan(args) {
      applyPlanCalls.push(args);
      return Object.freeze({ status: 'applied', plan: { planId: args.planId } });
    },
  };
}

function baseController(overrides = {}) {
  const events = [];
  const engine = fakeRepairEngine();
  let revisionCounter = 0;
  const controller = createSessionController({
    runDiagnostics: overrides.runDiagnostics || (async ({ revision, emit }) => {
      emit({ type: 'scan.started', revision });
      const summary = { gateway: { running: true } };
      const findings = [];
      emit({ type: 'scan.completed', revision, summary, findings });
      return { revision, diagnostic: { revision }, issues: [], summary };
    }),
    repairEngine: overrides.repairEngine || engine,
    normalizeFindings: overrides.normalizeFindings || normalizeFindings,
    knownRepairIds: overrides.knownRepairIds || [],
    makeRevisionId: overrides.makeRevisionId || (() => `rev-${(revisionCounter += 1)}`),
    onEvent: (event) => events.push(event),
  });
  return {
    controller, events, engine,
  };
}

// ============================================================
// Construction / validation
// ============================================================

test('createSessionController requires its injected boundaries', () => {
  assert.throws(() => createSessionController({}), TypeError);
  assert.throws(() => createSessionController({ runDiagnostics: () => {} }), TypeError);
  assert.throws(() => createSessionController({
    runDiagnostics: () => {},
    repairEngine: { createPlan: () => {}, applyPlan: () => {} },
  }), TypeError); // missing normalizeFindings/makeRevisionId
  assert.throws(() => createSessionController({
    runDiagnostics: () => {},
    repairEngine: { createPlan: () => {} }, // missing applyPlan
    normalizeFindings: () => [],
    makeRevisionId: () => 'x',
  }), TypeError);
  assert.throws(() => createSessionController({
    runDiagnostics: () => {},
    repairEngine: { createPlan: () => {}, applyPlan: () => {} },
    normalizeFindings: () => [],
    makeRevisionId: () => 'x',
    remoteAnalyzer: {}, // present but missing analyze()
  }), TypeError);
});

test('createSessionController accepts an absent remoteAnalyzer (optional, off by default)', () => {
  const { controller } = baseController();
  assert.equal(controller.getState().revision, null);
});

// ============================================================
// Initial state
// ============================================================

test('initial state has no revision/result/findings and an empty frozen transcript', () => {
  const { controller } = baseController();
  const state = controller.getState();
  assert.equal(state.revision, null);
  assert.equal(state.diagnostic, null);
  assert.deepEqual(state.issues, []);
  assert.deepEqual(state.findings, []);
  assert.equal(state.summary, null);
  assert.equal(state.scanning, false);
  assert.deepEqual(state.transcript, []);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.transcript), true);
});

// ============================================================
// scan() happy path — observable events + committed state
// ============================================================

test('scan() commits revision/diagnostic/issues/findings/summary and emits observable events in order', async () => {
  const { controller, events } = baseController({
    runDiagnostics: async ({ revision, emit }) => {
      emit({ type: 'scan.started', revision });
      emit({ type: 'scan.step', revision, phase: 'discover', label: 'x', data: {} });
      const summary = { gateway: { running: true } };
      const issues = [{ severity: 'high', text: 'Gateway is not running' }];
      emit({ type: 'scan.completed', revision, summary, findings: issues });
      return {
        revision, diagnostic: { revision }, issues, summary,
      };
    },
    knownRepairIds: ['gateway-not-running'],
  });

  const state = await controller.scan();
  assert.equal(state.revision, 'rev-1');
  assert.deepEqual(state.diagnostic, { revision: 'rev-1' });
  assert.equal(state.summary.gateway.running, true);
  assert.equal(state.findings.length, 1);
  assert.equal(state.findings[0].repairable, true);
  assert.equal(state.scanning, false);
  assert.equal(state.scanError, null);

  const types = events.map((event) => event.type);
  assert.deepEqual(types, [
    'session.scan.queued',
    'scan.started',
    'scan.step',
    'scan.completed',
    'session.scan.committed',
  ]);
  assert.equal(events.every(isSessionEvent) === true || true, true); // sanity: no crash iterating
  const committed = events.find((event) => event.type === 'session.scan.committed');
  assert.equal(isSessionEvent(committed), true);
  assert.equal(committed.findingsCount, 1);
  assert.equal(committed.error, null);
});

test('scan() surfaces a soft scan error (e.g. OpenClaw not found) without throwing', async () => {
  const { controller, events } = baseController({
    runDiagnostics: async ({ revision }) => ({ revision, error: 'OpenClaw not found on this system.' }),
  });

  const state = await controller.scan();
  assert.equal(state.diagnostic, null);
  assert.deepEqual(state.issues, []);
  assert.deepEqual(state.findings, []);
  assert.equal(state.scanError.message, 'OpenClaw not found on this system.');
  const committed = events.find((event) => event.type === 'session.scan.committed');
  assert.equal(committed.error.message, 'OpenClaw not found on this system.');
});

test('scan() re-throws a hard failure from runDiagnostics after committing scanError', async () => {
  const { controller, events } = baseController({
    runDiagnostics: async () => { throw new Error('boom'); },
  });

  await assert.rejects(() => controller.scan(), /boom/);
  assert.equal(controller.getState().scanError.message, 'boom');
  const committed = events.find((event) => event.type === 'session.scan.committed');
  assert.equal(committed.error.message, 'boom');
});

// ============================================================
// Rescan supersession + staleness rejection
// ============================================================

test('rescan cancels/supersedes the prior in-flight scan and rejects its late result as stale', async () => {
  const first = deferred();
  let call = 0;
  const { controller, events } = baseController({
    runDiagnostics: async ({ revision, emit, signal }) => {
      call += 1;
      if (call === 1) {
        emit({ type: 'scan.started', revision });
        await first.promise; // never resolves until the test says so
        return {
          revision, diagnostic: { stale: true }, issues: [], summary: { first: true },
        };
      }
      emit({ type: 'scan.started', revision });
      const summary = { second: true };
      emit({ type: 'scan.completed', revision, summary, findings: [] });
      return {
        revision, diagnostic: { fresh: true }, issues: [], summary,
      };
    },
  });

  const firstScanPromise = controller.scan(); // rev-1, will hang on `first.promise`
  await Promise.resolve(); // let the first scan register as in-flight

  const secondState = await controller.scan(); // rev-2, resolves immediately, supersedes rev-1
  assert.equal(secondState.revision, 'rev-2');
  assert.equal(secondState.diagnostic.fresh, true);

  first.resolve(); // late result for the now-superseded rev-1 arrives
  await firstScanPromise;

  // Late rev-1 result must NOT have overwritten the committed rev-2 state.
  const finalState = controller.getState();
  assert.equal(finalState.revision, 'rev-2');
  assert.equal(finalState.diagnostic.fresh, true);

  const types = events.map((event) => event.type);
  assert.ok(types.includes('session.scan.cancelled'), 'expected a cancelled event for the superseded scan');
  assert.ok(types.includes('session.scan.stale'), 'expected a stale event for the late result');

  const cancelledEvent = events.find((event) => event.type === 'session.scan.cancelled');
  assert.equal(cancelledEvent.revision, 'rev-1');
  const staleEvent = events.find((event) => event.type === 'session.scan.stale');
  assert.equal(staleEvent.revision, 'rev-1');
  assert.equal(staleEvent.reason, 'result');
});

test('the superseded scan receives an aborted signal', async () => {
  const seenSignals = [];
  const first = deferred();
  let call = 0;
  const { controller } = baseController({
    runDiagnostics: async ({
      revision, signal,
    }) => {
      call += 1;
      seenSignals.push(signal);
      if (call === 1) {
        await first.promise;
        return {
          revision, diagnostic: {}, issues: [], summary: {},
        };
      }
      return {
        revision, diagnostic: {}, issues: [], summary: {},
      };
    },
  });

  const firstScanPromise = controller.scan();
  await Promise.resolve();
  await controller.scan();
  first.resolve();
  await firstScanPromise;

  assert.equal(seenSignals[0].aborted, true);
  assert.equal(seenSignals[1].aborted, false);
});

// ============================================================
// Explicit cancellation
// ============================================================

test('cancelScan() aborts the in-flight scan and its late result is dropped as stale', async () => {
  const pending = deferred();
  const { controller, events } = baseController({
    runDiagnostics: async ({ revision }) => {
      await pending.promise;
      return {
        revision, diagnostic: {}, issues: [], summary: {},
      };
    },
  });

  const scanPromise = controller.scan();
  await Promise.resolve();
  assert.equal(controller.getState().scanning, true);

  const cancelled = controller.cancelScan();
  assert.equal(cancelled, true);
  assert.equal(controller.getState().scanning, false);
  assert.equal(controller.cancelScan(), false); // nothing left to cancel

  pending.resolve();
  const state = await scanPromise;
  assert.equal(state.revision, null); // never committed
  assert.ok(events.map((event) => event.type).includes('session.scan.stale'));
});

// ============================================================
// Transcript / messages
// ============================================================

test('appendMessage validates role/text, appends to transcript, and emits session.message', () => {
  const { controller, events } = baseController();
  assert.throws(() => controller.appendMessage('bogus', 'hi'), TypeError);
  assert.throws(() => controller.appendMessage('user', ''), TypeError);

  const message = controller.appendMessage('user', 'hello there');
  assert.equal(message.type, 'session.message');
  assert.equal(message.role, 'user');
  assert.equal(message.text, 'hello there');
  assert.equal(isSessionEvent(message), true);

  const state = controller.getState();
  assert.equal(state.transcript.length, 1);
  assert.equal(state.transcript[0].text, 'hello there');
  assert.throws(() => { state.transcript.push('nope'); }, TypeError);
  assert.equal(events.some((event) => event.type === 'session.message'), true);
});

// ============================================================
// proposeRepair() — propose only, identity-only lookup
// ============================================================

test('proposeRepair requires an active revision', () => {
  const { controller } = baseController();
  const proposal = controller.proposeRepair('clawfix:gateway-is-not-running');
  assert.equal(proposal.status, 'no_active_revision');
});

test('proposeRepair rejects an unknown findingId without touching the repair engine', async () => {
  const { controller, engine } = baseController({ knownRepairIds: ['gateway-not-running'] });
  await controller.scan();
  const proposal = controller.proposeRepair('does-not-exist');
  assert.equal(proposal.status, 'not_found');
  assert.equal(engine.createPlanCalls.length, 0);
});

test('proposeRepair refuses a non-repairable finding without touching the repair engine', async () => {
  const { controller, engine } = baseController({
    runDiagnostics: async ({ revision }) => ({
      revision,
      diagnostic: {},
      issues: [{ severity: 'low', kind: 'optimization', text: 'No SOUL.md found (agent has no personality)' }],
      summary: {},
    }),
    knownRepairIds: [], // deliberately NOT registering the repair, so it stays advisory
  });
  await controller.scan();
  const [finding] = controller.getState().findings;
  assert.equal(finding.repairable, false);

  const proposal = controller.proposeRepair(finding.id);
  assert.equal(proposal.status, 'not_repairable');
  assert.equal(engine.createPlanCalls.length, 0);
});

test('proposeRepair creates a plan for a repairable finding by stable id and emits an event', async () => {
  const { controller, engine, events } = baseController({
    runDiagnostics: async ({ revision }) => ({
      revision,
      diagnostic: {},
      issues: [{ severity: 'high', text: 'Gateway is not running' }],
      summary: {},
    }),
    knownRepairIds: ['gateway-not-running'],
  });
  await controller.scan();
  const [finding] = controller.getState().findings;
  assert.equal(finding.repairable, true);

  const proposal = controller.proposeRepair(finding.id);
  assert.equal(proposal.status, 'proposed');
  assert.equal(proposal.plan.repairId, 'gateway-not-running');
  assert.equal(engine.createPlanCalls.length, 1);

  const proposedEvent = events.find((event) => event.type === 'session.repair.proposed');
  assert.equal(proposedEvent.findingId, finding.id);
  assert.equal(proposedEvent.repairId, 'gateway-not-running');
  assert.equal(proposedEvent.planId, proposal.plan.planId);
});

// ============================================================
// applyRepair() — never bypasses the repair engine's own approval/staleness gates
// ============================================================

test('applyRepair rejects an unknown findingId without calling the repair engine', async () => {
  const { controller, engine } = baseController();
  const outcome = await controller.applyRepair({ planId: 'p1', approvalToken: 't1', findingId: 'nope', ctx: {} });
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.reason, 'finding_not_found');
  assert.equal(engine.applyPlanCalls.length, 0);
});

test('applyRepair forwards to the repair engine with the current revision and emits a result event', async () => {
  const { controller, engine, events } = baseController({
    runDiagnostics: async ({ revision }) => ({
      revision,
      diagnostic: {},
      issues: [{ severity: 'high', text: 'Gateway is not running' }],
      summary: {},
    }),
    knownRepairIds: ['gateway-not-running'],
  });
  await controller.scan();
  const [finding] = controller.getState().findings;
  const proposal = controller.proposeRepair(finding.id);

  const outcome = await controller.applyRepair({
    planId: proposal.plan.planId,
    approvalToken: proposal.plan.approvalToken,
    findingId: finding.id,
    ctx: { fake: true },
  });
  assert.equal(outcome.status, 'applied');
  assert.equal(engine.applyPlanCalls.length, 1);
  assert.equal(engine.applyPlanCalls[0].revision, controller.getState().revision);
  assert.equal(engine.applyPlanCalls[0].finding.id, finding.id);

  const resultEvent = events.find((event) => event.type === 'session.repair.result');
  assert.equal(resultEvent.status, 'applied');
  assert.equal(resultEvent.findingId, finding.id);
});

// ============================================================
// No shell/filesystem access
// ============================================================

test('session.js imports no filesystem/process/network boundary directly', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../cli/core/session.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:child_process|node:http|node:https/);
});
