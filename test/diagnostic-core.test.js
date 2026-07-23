import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  createScanCoordinator,
  isScanEvent,
  scanCompleted,
  scanError,
  scanStarted,
  scanStep,
  scanWarning,
  SCAN_PHASES,
} from '../cli/core/events.js';
import { createDiagnosticsCore, DiagnosticsCoreIncompleteError } from '../cli/core/diagnostics.js';

// ============================================================
// Slice 1 — event contracts (cli/core/events.js)
// ============================================================

test('scanStarted produces a frozen, branded, revision-stamped event and validates its input', () => {
  const event = scanStarted({ revision: 'rev-1' });
  assert.deepEqual(event, { type: 'scan.started', revision: 'rev-1' });
  assert.equal(Object.isFrozen(event), true);
  assert.equal(isScanEvent(event), true);
  assert.throws(() => scanStarted({}), TypeError);
  assert.throws(() => scanStarted({ revision: '' }), TypeError);
  assert.throws(() => scanStarted({ revision: 42 }), TypeError);
  assert.throws(() => scanStarted(), TypeError);
});

test('SCAN_PHASES is a frozen fixed enum covering every diagnostic collection band', () => {
  assert.equal(Object.isFrozen(SCAN_PHASES), true);
  assert.deepEqual([...SCAN_PHASES], [
    'discover', 'system', 'config', 'gateway', 'logs', 'service', 'workspace', 'ports', 'native', 'issues',
  ]);
});

test('scanStep validates phase/label/data, deep-freezes the structured snapshot, and decouples it from the caller', () => {
  const data = { binary: '/usr/local/bin/openclaw', nested: { count: 1 } };
  const event = scanStep({ revision: 'rev-1', phase: 'discover', label: 'Finding OpenClaw', data });

  assert.equal(event.type, 'scan.step');
  assert.equal(event.revision, 'rev-1');
  assert.equal(event.phase, 'discover');
  assert.equal(event.label, 'Finding OpenClaw');
  assert.deepEqual(event.data, data);
  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.data), true);
  assert.equal(Object.isFrozen(event.data.nested), true);
  assert.throws(() => { event.data.nested.count = 2; }, TypeError);
  assert.throws(() => { event.label = 'tampered'; }, TypeError);

  // Snapshot semantics: mutating the caller's original object after construction must not
  // retroactively change the already-emitted, already-validated event.
  data.nested.count = 999;
  assert.equal(event.data.nested.count, 1);

  assert.throws(() => scanStep({ revision: 'rev-1', phase: 'not-a-real-phase', label: 'x', data: {} }), TypeError);
  assert.throws(() => scanStep({ revision: 'rev-1', phase: 'discover', label: '', data: {} }), TypeError);
  assert.throws(() => scanStep({ revision: 'rev-1', phase: 'discover', label: 'x', data: 'not-an-object' }), TypeError);
  assert.throws(() => scanStep({ revision: 'rev-1', phase: 'discover', label: 'x', data: ['not-plain'] }), TypeError);
  assert.throws(() => scanStep({ phase: 'discover', label: 'x', data: {} }), TypeError);
});

test('scanStep data snapshot accepts nested JSON-like payloads, including shared-but-non-cyclic subtrees', () => {
  const validNested = {
    text: 'hello',
    count: 3,
    negative: -1.5,
    zero: 0,
    flag: true,
    nothing: null,
    list: [1, 'two', false, null, { nested: true }, [1, 2, 3]],
    empty: {},
    emptyList: [],
  };
  const event = scanStep({
    revision: 'rev-1', phase: 'discover', label: 'x', data: validNested,
  });
  assert.deepEqual(event.data, validNested);
  assert.equal(Object.isFrozen(event.data.list), true);
  assert.equal(Object.isFrozen(event.data.list[4]), true);

  // A value referenced at two positions (a DAG, not a cycle) must be accepted — the snapshot
  // clones each occurrence independently rather than rejecting it as circular.
  const shared = { value: 1 };
  const dag = { first: shared, second: shared };
  const dagEvent = scanStep({
    revision: 'rev-1', phase: 'discover', label: 'x', data: dag,
  });
  assert.deepEqual(dagEvent.data, { first: { value: 1 }, second: { value: 1 } });
});

test('scanStep data snapshot rejects every non-JSON-like category without invoking getters', () => {
  const rejects = (data) => {
    assert.throws(() => scanStep({
      revision: 'rev-1', phase: 'discover', label: 'x', data,
    }), TypeError);
  };

  rejects({ bad: undefined });
  rejects({ bad: () => {} });
  rejects({ bad: Symbol('x') });
  rejects({ bad: 10n });
  rejects({ bad: NaN });
  rejects({ bad: Infinity });
  rejects({ bad: -Infinity });
  rejects({ bad: new Date() });
  rejects({ bad: new Map() });
  rejects({ bad: new Set() });
  rejects({ bad: new (class Foo {})() });
  // eslint-disable-next-line no-sparse-arrays
  rejects({ bad: [1, , 3] });
  rejects({ bad: [1, undefined, 3] });

  const withSymbolKey = {};
  withSymbolKey[Symbol('key')] = 'value';
  rejects(withSymbolKey);

  const cyclicObject = {};
  cyclicObject.self = cyclicObject;
  rejects(cyclicObject);

  const cyclicArray = [];
  cyclicArray.push(cyclicArray);
  rejects(cyclicArray);

  let getterCalled = false;
  const withGetter = {};
  Object.defineProperty(withGetter, 'evil', {
    enumerable: true,
    configurable: true,
    get() { getterCalled = true; return 'leaked'; },
  });
  assert.throws(() => scanStep({
    revision: 'rev-1', phase: 'discover', label: 'x', data: withGetter,
  }), TypeError);
  assert.equal(getterCalled, false, 'validating a getter property must not execute it');

  const withSetter = {};
  Object.defineProperty(withSetter, 'evil', {
    enumerable: true,
    configurable: true,
    set() {},
  });
  rejects(withSetter);

  let arrayGetterCalled = false;
  const arrayWithGetter = [1];
  Object.defineProperty(arrayWithGetter, 0, {
    enumerable: true,
    configurable: true,
    get() { arrayGetterCalled = true; return 'leaked'; },
  });
  assert.throws(() => scanStep({
    revision: 'rev-1', phase: 'discover', label: 'x', data: { bad: arrayWithGetter },
  }), TypeError);
  assert.equal(arrayGetterCalled, false, 'validating an array getter must not execute it');

  const withHiddenProperty = { visible: true };
  Object.defineProperty(withHiddenProperty, 'hidden', { value: 'not-json', enumerable: false });
  rejects(withHiddenProperty);

  const arrayWithCustomProperty = [1];
  arrayWithCustomProperty.extra = true;
  rejects({ bad: arrayWithCustomProperty });
});

test('scanStep snapshot preserves an own __proto__ JSON key without mutating the clone prototype', () => {
  const payload = JSON.parse('{"__proto__":{"polluted":true},"safe":1}');
  const event = scanStep({ revision: 'rev-1', phase: 'discover', label: 'x', data: payload });
  assert.equal(Object.prototype.hasOwnProperty.call(event.data, '__proto__'), true);
  assert.deepEqual(event.data.__proto__, { polluted: true });
  assert.equal(Object.getPrototypeOf(event.data), Object.prototype);
  assert.equal(event.data.polluted, undefined);
});

test('scanCompleted summary and findings snapshots reject non-JSON-like values the same way scanStep does', () => {
  assert.throws(() => scanCompleted({
    revision: 'rev-1', summary: { when: new Date() }, findings: [],
  }), TypeError);
  assert.throws(() => scanCompleted({
    revision: 'rev-1', summary: {}, findings: [{ bad: undefined }],
  }), TypeError);
  assert.throws(() => scanCompleted({
    revision: 'rev-1', summary: {}, findings: [new Set()],
  }), TypeError);
});

test('scanCompleted requires a summary object and findings array, and deep-freezes both', () => {
  const summary = { gateway: { running: true }, node: 'v22.0.0' };
  const findings = [{ severity: 'high', text: 'example' }];
  const event = scanCompleted({ revision: 'rev-1', summary, findings });

  assert.equal(event.type, 'scan.completed');
  assert.deepEqual(event.summary, summary);
  assert.deepEqual(event.findings, findings);
  assert.equal(Object.isFrozen(event.summary), true);
  assert.equal(Object.isFrozen(event.summary.gateway), true);
  assert.equal(Object.isFrozen(event.findings), true);
  assert.equal(Object.isFrozen(event.findings[0]), true);
  assert.throws(() => { event.findings.push({}); }, TypeError);
  assert.throws(() => { event.findings[0].severity = 'low'; }, TypeError);

  // Snapshot semantics apply here too.
  findings.push({ severity: 'low', text: 'late addition' });
  assert.equal(event.findings.length, 1);

  assert.throws(() => scanCompleted({ revision: 'rev-1', summary, findings: 'nope' }), TypeError);
  assert.throws(() => scanCompleted({ revision: 'rev-1', summary: null, findings: [] }), TypeError);
  assert.throws(() => scanCompleted({ summary: {}, findings: [] }), TypeError);
});

test('scanWarning and scanError are scan-scoped: both require and carry the immutable revision', () => {
  const warning = scanWarning({
    revision: 'rev-1',
    code: 'COLLECTOR_TIMEOUT',
    message: 'npm version probe timed out',
  });
  assert.deepEqual(warning, {
    type: 'scan.warning',
    revision: 'rev-1',
    code: 'COLLECTOR_TIMEOUT',
    message: 'npm version probe timed out',
  });
  assert.equal(Object.isFrozen(warning), true);

  const error = scanError({
    revision: 'rev-1',
    error: { message: 'OpenClaw not found on this system.', code: 'OPENCLAW_NOT_FOUND' },
  });
  assert.deepEqual(error, {
    type: 'scan.error',
    revision: 'rev-1',
    error: { message: 'OpenClaw not found on this system.', code: 'OPENCLAW_NOT_FOUND' },
  });
  assert.equal(Object.isFrozen(error), true);
  assert.equal(Object.isFrozen(error.error), true);
  assert.throws(() => { error.error.message = 'tampered'; }, TypeError);

  // error.code is optional; error.message is required.
  const errorWithoutCode = scanError({ revision: 'rev-1', error: { message: 'internal failure' } });
  assert.deepEqual(errorWithoutCode.error, { message: 'internal failure' });

  let messageGetterCalled = false;
  const accessorError = {};
  Object.defineProperty(accessorError, 'message', {
    enumerable: true,
    get() { messageGetterCalled = true; return 'should not execute'; },
  });
  assert.throws(() => scanError({ revision: 'rev-1', error: accessorError }), TypeError);
  assert.equal(messageGetterCalled, false, 'scanError validation must not execute error.message getters');

  // A revision is REQUIRED on both — this is the corrected contract (the roadmap's bare
  // warning({message})/error({error}) signatures are not sufficient: every scan-scoped event
  // must carry the immutable revision so stale-scan suppression can key on it).
  assert.throws(() => scanWarning({ code: 'X', message: 'y' }), TypeError);
  assert.throws(() => scanWarning({ revision: '', code: 'X', message: 'y' }), TypeError);
  assert.throws(() => scanWarning({ revision: 'rev-1', message: 'y' }), TypeError);
  assert.throws(() => scanWarning({ revision: 'rev-1', code: 'X' }), TypeError);
  assert.throws(() => scanError({ code: 'X' }), TypeError);
  assert.throws(() => scanError({ revision: 'rev-1' }), TypeError);
  assert.throws(() => scanError({ revision: 'rev-1', error: {} }), TypeError);
  assert.throws(() => scanError({ revision: 'rev-1', error: { message: 5 } }), TypeError);
});

test('isScanEvent recognizes only events constructed by these validated factories, not look-alikes', () => {
  const event = scanStarted({ revision: 'rev-1' });
  assert.equal(isScanEvent(event), true);
  assert.equal(isScanEvent({ type: 'scan.started', revision: 'rev-1' }), false);
  assert.equal(isScanEvent(null), false);
  assert.equal(isScanEvent(undefined), false);
  assert.equal(isScanEvent('scan.started'), false);
  assert.equal(isScanEvent(42), false);
});

// ============================================================
// Slice 1 — createScanCoordinator (stale event AND stale result suppression)
// ============================================================

test('createScanCoordinator issues distinct, deterministic revisions from an injected makeId', () => {
  let counter = 0;
  const coordinator = createScanCoordinator({ makeId: () => `rev-${++counter}` });
  const handleA = coordinator.begin();
  const handleB = coordinator.begin();
  assert.equal(handleA.revision, 'rev-1');
  assert.equal(handleB.revision, 'rev-2');
  assert.notEqual(handleA.revision, handleB.revision);
  assert.equal(coordinator.currentRevision(), 'rev-2');
  assert.throws(() => createScanCoordinator({ makeId: 'not-a-function' }), TypeError);
  assert.throws(() => createScanCoordinator({ sink: 'not-a-function' }), TypeError);
});

test('createScanCoordinator suppresses BOTH stale events and stale results once a newer scan begins', () => {
  const sunk = [];
  let counter = 0;
  const coordinator = createScanCoordinator({
    makeId: () => `rev-${++counter}`,
    sink: (event) => sunk.push(event),
  });

  const stale = coordinator.begin();
  assert.equal(stale.isCurrent(), true);

  const fresh = coordinator.begin();
  assert.equal(stale.isCurrent(), false, 'starting a newer scan must immediately supersede the older handle');
  assert.equal(fresh.isCurrent(), true);

  // Late events from the SUPERSEDED (stale) revision must never reach the sink.
  stale.emit(scanStep({ revision: stale.revision, phase: 'discover', label: 'Finding OpenClaw', data: {} }));
  stale.emit(scanWarning({ revision: stale.revision, code: 'LATE', message: 'late warning from a superseded scan' }));
  stale.emit(scanCompleted({ revision: stale.revision, summary: {}, findings: [] }));
  assert.deepEqual(sunk, [], 'no event from the stale revision may reach the sink');

  // The stale scan's final result must also be dropped — same currency source as the event gate.
  assert.equal(stale.settle({ diagnostic: 'stale-result' }), undefined);

  // Events and the result from the CURRENT revision are forwarded/returned normally.
  fresh.emit(scanStep({ revision: fresh.revision, phase: 'discover', label: 'Finding OpenClaw', data: {} }));
  fresh.emit(scanCompleted({ revision: fresh.revision, summary: {}, findings: [] }));
  assert.equal(sunk.length, 2);
  assert.equal(sunk[0].type, 'scan.step');
  assert.equal(sunk[1].type, 'scan.completed');
  assert.equal(fresh.settle({ diagnostic: 'fresh-result' }).diagnostic, 'fresh-result');
});

test('createScanCoordinator forwards at most one terminal event per handle (exactly-once completion/error)', () => {
  const sunk = [];
  let counter = 0;
  const coordinator = createScanCoordinator({
    makeId: () => `rev-${++counter}`,
    sink: (event) => sunk.push(event),
  });
  const handle = coordinator.begin();

  handle.emit(scanStarted({ revision: handle.revision }));
  handle.emit(scanCompleted({ revision: handle.revision, summary: {}, findings: [] }));
  // Anything emitted after the first terminal event must be dropped, even though the revision
  // is still current — this scan is over, so a second "terminal" (or any further event) is stale
  // relative to the scan's own lifecycle, not just relative to a newer scan.
  handle.emit(scanError({ revision: handle.revision, error: { message: 'too late' } }));
  handle.emit(scanStep({ revision: handle.revision, phase: 'issues', label: 'late step', data: {} }));

  assert.equal(sunk.length, 2);
  assert.equal(sunk[0].type, 'scan.started');
  assert.equal(sunk[1].type, 'scan.completed');
});

test('createScanCoordinator forwards at most one terminal event per handle when the terminal is scan.error', () => {
  const sunk = [];
  const coordinator = createScanCoordinator({ makeId: () => 'rev-only', sink: (event) => sunk.push(event) });
  const handle = coordinator.begin();

  handle.emit(scanError({ revision: handle.revision, error: { message: 'boom', code: 'INTERNAL' } }));
  handle.emit(scanCompleted({ revision: handle.revision, summary: {}, findings: [] }));

  assert.equal(sunk.length, 1);
  assert.equal(sunk[0].type, 'scan.error');
});

test('createScanCoordinator handle.emit rejects an event whose revision does not match the presenting handle', () => {
  const coordinator = createScanCoordinator({ makeId: () => 'rev-only' });
  const handle = coordinator.begin();
  const foreignEvent = scanStep({ revision: 'someone-elses-revision', phase: 'discover', label: 'x', data: {} });
  assert.throws(() => handle.emit(foreignEvent), TypeError);
});

test('createScanCoordinator handle.emit rejects values that are not validated scan events', () => {
  const coordinator = createScanCoordinator({ makeId: () => 'rev-only' });
  const handle = coordinator.begin();
  assert.throws(() => handle.emit({ type: 'scan.step', revision: handle.revision }), TypeError);
  assert.throws(() => handle.emit(null), TypeError);
});

test('createScanCoordinator.begin requires makeId() to return a non-empty string and leaves currency untouched on failure', () => {
  const emptyStringCoordinator = createScanCoordinator({ makeId: () => '' });
  assert.throws(() => emptyStringCoordinator.begin(), TypeError);
  assert.equal(emptyStringCoordinator.currentRevision(), null);

  const numberCoordinator = createScanCoordinator({ makeId: () => 42 });
  assert.throws(() => numberCoordinator.begin(), TypeError);
  assert.equal(numberCoordinator.currentRevision(), null);

  const nullCoordinator = createScanCoordinator({ makeId: () => null });
  assert.throws(() => nullCoordinator.begin(), TypeError);
  assert.equal(nullCoordinator.currentRevision(), null);

  const objectCoordinator = createScanCoordinator({ makeId: () => ({}) });
  assert.throws(() => objectCoordinator.begin(), TypeError);
  assert.equal(objectCoordinator.currentRevision(), null);

  // A coordinator that already has a valid current revision must not lose it to a subsequent
  // failed begin() call.
  let toggle = 'valid-revision';
  const flakyCoordinator = createScanCoordinator({ makeId: () => toggle });
  flakyCoordinator.begin();
  assert.equal(flakyCoordinator.currentRevision(), 'valid-revision');
  toggle = '';
  assert.throws(() => flakyCoordinator.begin(), TypeError);
  assert.equal(flakyCoordinator.currentRevision(), 'valid-revision');
});

test('createScanCoordinator.begin defaults makeId to a real UUID generator when omitted', () => {
  const coordinator = createScanCoordinator();
  const handleA = coordinator.begin();
  const handleB = coordinator.begin();
  assert.match(handleA.revision, /^[0-9a-f-]{36}$/);
  assert.notEqual(handleA.revision, handleB.revision);
});

// ============================================================
// Slice 2 — createDiagnosticsCore: discover / system / config phases only
//
// Task 4 is being extracted in vertical slices. This slice implements ONLY the discover, system,
// and config collection phases plus the OpenClaw-not-found terminal outcome. The gateway, logs,
// service, workspace, ports, and native collection bands, pure issue derivation, envelope/summary
// assembly, and cancellation/deadline machinery are NOT implemented yet (Slices 3-6) — a scan that
// finds OpenClaw rejects with an explicit DiagnosticsCoreIncompleteError instead of silently
// pretending to produce a real result. Nothing calls this module from cli/bin/clawfix.js yet, so
// this incompleteness has no effect on the running CLI.
// ============================================================

function fakeDeps(overrides = {}) {
  const openclawBin = overrides.openclawBin ?? '/usr/local/bin/openclaw';
  const openclawDir = overrides.openclawDir ?? '/home/fake-user/.openclaw';
  const configPath = `${openclawDir}/openclaw.json`;
  const existingPaths = overrides.existingPaths ?? new Set([openclawDir, configPath]);
  const configJson = overrides.config ?? { gateway: { port: 18789 }, env: { SECRET: 'shh' } };

  const calls = {
    exists: [],
    readJson: [],
    findExecutable: 0,
    npmVersion: 0,
    version: 0,
    collectOpenClawVersion: 0,
  };

  const fs = {
    async exists(path) {
      calls.exists.push(path);
      return existingPaths.has(path);
    },
    async readJson(path) {
      calls.readJson.push(path);
      return configJson;
    },
  };
  const openclaw = {
    async findExecutable() {
      calls.findExecutable += 1;
      return overrides.openclawBinFound === false ? '' : openclawBin;
    },
    async npmVersion() {
      calls.npmVersion += 1;
      return overrides.npmVersion ?? '10.2.0';
    },
    async version() {
      calls.version += 1;
      return overrides.versionResult === undefined
        ? { status: 0, stdout: '1.2.3\n', stderr: '' }
        : overrides.versionResult;
    },
  };
  const os = {
    homedir: () => overrides.home ?? '/home/fake-user',
    platform: () => overrides.platform ?? 'linux',
    release: () => overrides.release ?? '6.1.0-fake',
    arch: () => overrides.arch ?? 'x64',
    hostname: () => overrides.hostname ?? 'unit-test-marker-host',
    nodeVersion: () => overrides.nodeVersion ?? 'v22.9.0-fake',
  };
  const env = overrides.env ?? {};
  const clock = { now: () => overrides.now ?? new Date('2026-07-23T12:00:00.000Z') };
  let hashInvocations = 0;
  const injectedCreateHash = (...args) => {
    hashInvocations += 1;
    return createHash(...args);
  };
  const redactCalls = [];
  const redact = (value) => {
    redactCalls.push(value);
    return overrides.redact ? overrides.redact(value) : value;
  };
  const nativeCollectors = {
    collectOpenClawVersion(binary, runSync) {
      calls.collectOpenClawVersion += 1;
      return overrides.collectOpenClawVersion
        ? overrides.collectOpenClawVersion(binary, runSync)
        : {
          version: '1.2.3', runtimeCompatible: true, runtimeRequired: '', runtimeCurrent: '', error: '',
        };
    },
  };

  return {
    deps: {
      redact, fs, openclaw, os, env, clock, createHash: injectedCreateHash, nativeCollectors,
    },
    calls,
    redactCalls,
    getHashInvocations: () => hashInvocations,
  };
}

test('createDiagnosticsCore requires every injected boundary and rejects a missing redactor', () => {
  const { deps } = fakeDeps();
  assert.throws(() => createDiagnosticsCore({ ...deps, redact: undefined }), TypeError);
  assert.throws(() => createDiagnosticsCore({ ...deps, fs: undefined }), TypeError);
  assert.throws(() => createDiagnosticsCore({ ...deps, openclaw: undefined }), TypeError);
  assert.throws(() => createDiagnosticsCore({ ...deps, os: undefined }), TypeError);
  assert.throws(() => createDiagnosticsCore({ ...deps, env: undefined }), TypeError);
  assert.throws(() => createDiagnosticsCore({ ...deps, clock: undefined }), TypeError);
  assert.throws(() => createDiagnosticsCore({ ...deps, createHash: undefined }), TypeError);
  assert.throws(() => createDiagnosticsCore({ ...deps, nativeCollectors: undefined }), TypeError);
  assert.throws(() => createDiagnosticsCore({ ...deps, os: { homedir: () => '/x' } }), TypeError);
  assert.doesNotThrow(() => createDiagnosticsCore(deps));
});

test('runDiagnostics validates revision before touching any injected boundary', async () => {
  const { deps, calls } = fakeDeps();
  const core = createDiagnosticsCore(deps);
  await assert.rejects(core.runDiagnostics({ revision: '' }), TypeError);
  await assert.rejects(core.runDiagnostics({}), TypeError);
  await assert.rejects(core.runDiagnostics({ revision: 'rev-1', emit: 'not-a-function' }), TypeError);
  assert.equal(calls.findExecutable, 0);
  assert.equal(calls.exists.length, 0);
});

test('runDiagnostics runs the discover phase from injected boundaries only, then reports remaining work', async () => {
  const { deps, calls } = fakeDeps();
  const core = createDiagnosticsCore(deps);
  const events = [];
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-1', emit: (e) => events.push(e) }),
    DiagnosticsCoreIncompleteError,
  );

  assert.equal(events[0].type, 'scan.started');
  assert.equal(events[0].revision, 'rev-1');
  const discoverStep = events.find((e) => e.type === 'scan.step' && e.phase === 'discover');
  assert.ok(discoverStep);
  assert.equal(discoverStep.label, 'Finding OpenClaw');
  assert.equal(discoverStep.data.binary, '/usr/local/bin/openclaw');
  assert.equal(discoverStep.data.configDir, '/home/fake-user/.openclaw');
  assert.equal(calls.findExecutable, 1);
});

test('runDiagnostics resolves an OpenClaw-not-found result, emits exactly one terminal scan.error, and never emits scan.completed', async () => {
  const { deps, calls } = fakeDeps({ openclawBinFound: false, existingPaths: new Set() });
  const core = createDiagnosticsCore(deps);
  const events = [];
  const result = await core.runDiagnostics({ revision: 'rev-2', emit: (e) => events.push(e) });

  assert.deepEqual(result, { revision: 'rev-2', error: 'OpenClaw not found on this system.' });
  assert.deepEqual(events.map((e) => e.type), ['scan.started', 'scan.error']);
  assert.equal(events[1].revision, 'rev-2');
  assert.equal(events[1].error.code, 'OPENCLAW_NOT_FOUND');
  assert.equal(events.filter((e) => e.type === 'scan.completed').length, 0);

  // Not-found short-circuits before any further collection.
  assert.equal(calls.npmVersion, 0);
  assert.equal(calls.version, 0);
  assert.equal(calls.readJson.length, 0);
});

test('runDiagnostics runs the system phase using injected os, createHash, npmVersion, and collectOpenClawVersion', async () => {
  const { deps } = fakeDeps({
    hostname: 'unit-test-marker-host',
    npmVersion: '11.0.0-fake',
    platform: 'darwin',
    release: '24.0.0-fake',
    arch: 'arm64',
    nodeVersion: 'v22.9.0-fake',
    collectOpenClawVersion: () => ({
      version: '9.9.9-fake', runtimeCompatible: true, runtimeRequired: '', runtimeCurrent: '', error: '',
    }),
  });
  const core = createDiagnosticsCore(deps);
  const events = [];
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-3', emit: (e) => events.push(e) }),
    DiagnosticsCoreIncompleteError,
  );

  const systemStep = events.find((e) => e.type === 'scan.step' && e.phase === 'system');
  assert.ok(systemStep);
  assert.equal(systemStep.label, 'Collecting system information');
  assert.equal(systemStep.data.os, 'darwin');
  assert.equal(systemStep.data.osVersion, '24.0.0-fake');
  assert.equal(systemStep.data.arch, 'arm64');
  assert.equal(systemStep.data.nodeVersion, 'v22.9.0-fake');
  assert.equal(systemStep.data.npmVersion, '11.0.0-fake');
  assert.equal(systemStep.data.ocVersion, '9.9.9-fake');

  // The host hash must derive from the INJECTED hostname/createHash, not the real machine's —
  // proof that the core reaches no ambient os/crypto global.
  const expectedHostHash = createHash('sha256').update('unit-test-marker-host').digest('hex').slice(0, 8);
  assert.equal(systemStep.data.hostHash, expectedHostHash);
});

test('runDiagnostics falls back to an unresolved version probe when no OpenClaw binary was found but a config dir exists', async () => {
  const { deps, calls } = fakeDeps({ openclawBinFound: false, existingPaths: new Set(['/home/fake-user/.openclaw']) });
  const core = createDiagnosticsCore(deps);
  const events = [];
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-3b', emit: (e) => events.push(e) }),
    DiagnosticsCoreIncompleteError,
  );
  const systemStep = events.find((e) => e.type === 'scan.step' && e.phase === 'system');
  assert.equal(systemStep.data.ocVersion, '');
  assert.equal(calls.version, 0);
  assert.equal(calls.collectOpenClawVersion, 0);
});

test('runDiagnostics runs the config phase, deletes the top-level env block, and redacts exactly once via the injected redactor', async () => {
  const seenByRedact = [];
  const { deps } = fakeDeps({
    config: { gateway: { port: 4321 }, env: { OPENCLAW_TOKEN: 'shh' }, agents: { defaults: { workspace: '/w' } } },
    redact: (value) => { seenByRedact.push(value); return { ...value, redacted: true }; },
  });
  const core = createDiagnosticsCore(deps);
  const events = [];
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-4', emit: (e) => events.push(e) }),
    DiagnosticsCoreIncompleteError,
  );

  assert.equal(seenByRedact.length, 1);
  assert.equal('env' in seenByRedact[0], false, 'the top-level config env block must be deleted before redaction');
  assert.deepEqual(seenByRedact[0].gateway, { port: 4321 });

  const configStep = events.find((e) => e.type === 'scan.step' && e.phase === 'config');
  assert.ok(configStep);
  assert.equal(configStep.label, 'Checking configuration');
  assert.equal(configStep.data.configExists, true);
});

test('runDiagnostics reports configExists=false and skips redaction when no config file is present', async () => {
  const { deps, redactCalls } = fakeDeps({ existingPaths: new Set(['/home/fake-user/.openclaw']) });
  const core = createDiagnosticsCore(deps);
  const events = [];
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-5', emit: (e) => events.push(e) }),
    DiagnosticsCoreIncompleteError,
  );
  const configStep = events.find((e) => e.type === 'scan.step' && e.phase === 'config');
  assert.equal(configStep.data.configExists, false);
  assert.equal(redactCalls.length, 0);
});

test('runDiagnostics rejects an invalid redactor return and emits exactly one INTERNAL terminal', async () => {
  const { deps } = fakeDeps({ redact: () => undefined });
  const core = createDiagnosticsCore(deps);
  const events = [];
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-invalid-redactor', emit: (event) => events.push(event) }),
    (error) => error instanceof TypeError && /redact must return a plain object/.test(error.message),
  );
  const terminals = events.filter((event) => event.type === 'scan.error' || event.type === 'scan.completed');
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].type, 'scan.error');
  assert.equal(terminals[0].error.code, 'INTERNAL');
  assert.equal(events.some((event) => event.type === 'scan.completed'), false);
  assert.equal(events.some((event) => event.type === 'scan.step' && event.phase === 'config'), false);
});

test('runDiagnostics never writes to the console or stdout/stderr directly', async () => {
  const originalLog = console.log;
  const originalWrite = process.stdout.write;
  const writes = [];
  console.log = (...args) => writes.push(['console.log', args]);
  process.stdout.write = (chunk) => { writes.push(['stdout.write', chunk]); return true; };
  try {
    const found = fakeDeps();
    await assert.rejects(
      createDiagnosticsCore(found.deps).runDiagnostics({ revision: 'rev-6' }),
      DiagnosticsCoreIncompleteError,
    );
    const notFound = fakeDeps({ openclawBinFound: false, existingPaths: new Set() });
    const result = await createDiagnosticsCore(notFound.deps).runDiagnostics({ revision: 'rev-7' });
    assert.equal(result.error, 'OpenClaw not found on this system.');
  } finally {
    console.log = originalLog;
    process.stdout.write = originalWrite;
  }
  assert.deepEqual(writes, []);
});

test('DiagnosticsCoreIncompleteError explicitly names the collection bands Task 4 has not yet extracted', async () => {
  const { deps } = fakeDeps();
  const core = createDiagnosticsCore(deps);
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-8' }),
    (error) => {
      assert.ok(error instanceof DiagnosticsCoreIncompleteError);
      assert.equal(error.code, 'NOT_IMPLEMENTED');
      assert.match(error.message, /gateway/);
      assert.match(error.message, /native/);
      assert.match(error.message, /envelope/);
      return true;
    },
  );
});

// ============================================================
// Terminal-event contract corrections (post-Slice-2 review)
//
// Every started scan must produce EXACTLY ONE terminal event (scan.completed XOR scan.error),
// never followed by scan.completed. The intentionally-incomplete Slice-2 scaffold is not exempt:
// reaching the "not yet implemented" point must emit a scan.error{code:'NOT_IMPLEMENTED'} before
// rejecting. An unexpected failure from an injected discover/system/config boundary must emit a
// scan.error{code:'INTERNAL'} and then reject the ORIGINAL error (not a wrapped one). If the sink
// itself throws while delivering that terminal event, there must be no second attempt.
// ============================================================

test('runDiagnostics emits exactly one terminal scan.error (code NOT_IMPLEMENTED) before rejecting the intentional Slice-2 incompleteness, and never emits scan.completed', async () => {
  const { deps } = fakeDeps();
  const core = createDiagnosticsCore(deps);
  const events = [];
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-10', emit: (e) => events.push(e) }),
    DiagnosticsCoreIncompleteError,
  );
  const terminals = events.filter((e) => e.type === 'scan.error' || e.type === 'scan.completed');
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].type, 'scan.error');
  assert.equal(terminals[0].revision, 'rev-10');
  assert.equal(terminals[0].error.code, 'NOT_IMPLEMENTED');
  assert.equal(events.filter((e) => e.type === 'scan.completed').length, 0);
});

test('runDiagnostics emits exactly one INTERNAL terminal scan.error and rejects the original error when the discover boundary throws unexpectedly', async () => {
  const boom = new Error('filesystem exploded');
  const { deps } = fakeDeps();
  deps.fs.exists = async () => { throw boom; };
  const core = createDiagnosticsCore(deps);
  const events = [];
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-11', emit: (e) => events.push(e) }),
    (error) => error === boom,
  );
  assert.deepEqual(events.map((e) => e.type), ['scan.started', 'scan.error']);
  assert.equal(events[1].error.code, 'INTERNAL');
  assert.equal(events[1].error.message, 'filesystem exploded');
  assert.equal(events.filter((e) => e.type === 'scan.completed').length, 0);
});

test('runDiagnostics emits exactly one INTERNAL terminal scan.error and rejects the original error when the system boundary throws unexpectedly', async () => {
  const boom = new Error('npm probe exploded');
  const { deps } = fakeDeps();
  deps.openclaw.npmVersion = async () => { throw boom; };
  const core = createDiagnosticsCore(deps);
  const events = [];
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-12', emit: (e) => events.push(e) }),
    (error) => error === boom,
  );
  assert.deepEqual(events.map((e) => e.type), ['scan.started', 'scan.step', 'scan.error']);
  const terminal = events[events.length - 1];
  assert.equal(terminal.error.code, 'INTERNAL');
  assert.equal(terminal.error.message, 'npm probe exploded');
  assert.equal(events.filter((e) => e.type === 'scan.completed').length, 0);
  assert.equal(events.filter((e) => e.type === 'scan.error').length, 1);
});

test('runDiagnostics does not attempt a second terminal event if the emit sink throws while delivering the first one', async () => {
  const { deps } = fakeDeps({ openclawBinFound: false, existingPaths: new Set() });
  const core = createDiagnosticsCore(deps);
  const delivered = [];
  const throwingEmit = (event) => {
    delivered.push(event.type);
    if (event.type !== 'scan.started') throw new Error('sink exploded');
  };
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-13', emit: throwingEmit }),
    (error) => error.message === 'sink exploded',
  );
  // Exactly one attempt at the terminal event (scan.error), even though the sink threw while
  // delivering it — no fallback/replacement second emission was attempted.
  assert.deepEqual(delivered, ['scan.started', 'scan.error']);
});
