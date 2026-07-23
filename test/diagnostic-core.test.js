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
    gatewayStatusText: [],
    gatewayProcesses: [],
    readFileTail: [],
    serviceManagerState: [],
    stat: [],
    readdir: [],
    countMarkdownFiles: [],
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
    async stat(path) {
      calls.stat.push(path);
      const sizes = overrides.fileSizes ?? {};
      if (!(path in sizes)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return { size: sizes[path] };
    },
    async readdir(path) {
      calls.readdir.push(path);
      const dirs = overrides.dirEntries ?? {};
      if (!(path in dirs)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return dirs[path];
    },
    async countMarkdownFiles(path) {
      calls.countMarkdownFiles.push(path);
      if (overrides.countMarkdownFilesThrows) throw new Error('countMarkdownFiles exploded');
      return overrides.mdFileCount ?? 0;
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
    async gatewayStatusText(options) {
      calls.gatewayStatusText.push(options);
      if (overrides.gatewayStatusTextThrows) throw overrides.gatewayStatusTextThrows;
      return overrides.gatewayStatusText ?? 'runtime: ok\nrunning, pid 4242';
    },
    async gatewayProcesses(options) {
      calls.gatewayProcesses.push(options);
      return overrides.gatewayProcesses ?? '';
    },
    async readFileTail(path, options) {
      calls.readFileTail.push({ path, options });
      const tails = overrides.fileTails ?? {};
      return { text: tails[path] ?? '' };
    },
    async serviceManagerState(options) {
      calls.serviceManagerState.push(options);
      return overrides.serviceManagerState ?? {};
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

// ============================================================
// Slice 3A — createDiagnosticsCore: gateway / logs / service / workspace collection bands
//
// This slice extends runDiagnostics through the gateway, logs, service, and workspace
// collection bands (the original collectDiagnostics() lines ~643-779 in cli/bin/clawfix.js).
// Ports, native collectors, pure issue derivation, envelope/summary assembly, and
// cancellation/deadline machinery remain deferred to later Task 4 slices — a scan that reaches
// past the workspace phase still rejects with DiagnosticsCoreIncompleteError.
// ============================================================

function findStep(events, phase) {
  return events.find((e) => e.type === 'scan.step' && e.phase === phase);
}

test('createDiagnosticsCore requires the newly-injected gateway/logs/service/workspace boundary methods', () => {
  const { deps } = fakeDeps();
  assert.throws(() => createDiagnosticsCore({
    ...deps, openclaw: { findExecutable: deps.openclaw.findExecutable, npmVersion: deps.openclaw.npmVersion, version: deps.openclaw.version },
  }), TypeError);
  assert.throws(() => createDiagnosticsCore({
    ...deps,
    openclaw: { ...deps.openclaw, gatewayStatusText: undefined },
  }), TypeError);
  assert.throws(() => createDiagnosticsCore({
    ...deps,
    openclaw: { ...deps.openclaw, gatewayProcesses: undefined },
  }), TypeError);
  assert.throws(() => createDiagnosticsCore({
    ...deps,
    openclaw: { ...deps.openclaw, readFileTail: undefined },
  }), TypeError);
  assert.throws(() => createDiagnosticsCore({
    ...deps,
    openclaw: { ...deps.openclaw, serviceManagerState: undefined },
  }), TypeError);
  assert.throws(() => createDiagnosticsCore({
    ...deps,
    fs: { exists: deps.fs.exists, readJson: deps.fs.readJson },
  }), TypeError);
  assert.throws(() => createDiagnosticsCore({
    ...deps,
    fs: { ...deps.fs, stat: undefined },
  }), TypeError);
  assert.throws(() => createDiagnosticsCore({
    ...deps,
    fs: { ...deps.fs, readdir: undefined },
  }), TypeError);
  assert.throws(() => createDiagnosticsCore({
    ...deps,
    fs: { ...deps.fs, countMarkdownFiles: undefined },
  }), TypeError);
  assert.doesNotThrow(() => createDiagnosticsCore(deps));
});

test('runDiagnostics gateway phase reports the default port, status line, and pid facts from raw config', async () => {
  const { deps, calls } = fakeDeps({
    config: { gateway: {}, env: { SECRET: 'shh' } },
    gatewayStatusText: 'startup log line\nrunning, pid 4242 listening on 18789',
    gatewayProcesses: '4242',
  });
  const core = createDiagnosticsCore(deps);
  const events = [];
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-gw-1', emit: (e) => events.push(e) }),
    DiagnosticsCoreIncompleteError,
  );
  const gatewayStep = findStep(events, 'gateway');
  assert.ok(gatewayStep);
  assert.equal(gatewayStep.label, 'Checking gateway status');
  assert.equal(gatewayStep.data.port, 18789, 'must fall back to the default port when config.gateway.port is absent');
  assert.equal(gatewayStep.data.statusLine, 'running, pid 4242 listening on 18789');
  assert.equal(gatewayStep.data.pid, '4242');
  assert.equal(gatewayStep.data.running, true);

  assert.deepEqual(calls.gatewayStatusText[0], { executable: '/usr/local/bin/openclaw', timeoutMs: 5000 });
  assert.deepEqual(calls.gatewayProcesses[0], { timeoutMs: 5000 });
});

test('runDiagnostics gateway phase honors a configured port and reports a null pid when no process is found', async () => {
  const { deps } = fakeDeps({
    config: { gateway: { port: 9999 }, env: {} },
    gatewayStatusText: 'not running',
    gatewayProcesses: '',
  });
  const core = createDiagnosticsCore(deps);
  const events = [];
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-gw-2', emit: (e) => events.push(e) }),
    DiagnosticsCoreIncompleteError,
  );
  const gatewayStep = findStep(events, 'gateway');
  assert.equal(gatewayStep.data.port, 9999);
  assert.equal(gatewayStep.data.pid, null);
  assert.equal(gatewayStep.data.running, false);
});

test('runDiagnostics gateway phase reports an unknown status without calling gatewayStatusText when no binary was found', async () => {
  const { deps, calls } = fakeDeps({
    openclawBinFound: false,
    existingPaths: new Set(['/home/fake-user/.openclaw']),
    gatewayProcesses: '777',
  });
  const core = createDiagnosticsCore(deps);
  const events = [];
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-gw-3', emit: (e) => events.push(e) }),
    DiagnosticsCoreIncompleteError,
  );
  const gatewayStep = findStep(events, 'gateway');
  assert.equal(gatewayStep.data.statusLine, 'unknown');
  assert.equal(gatewayStep.data.running, false);
  // gatewayProcesses is unconditional in the original collector, even with no binary.
  assert.equal(gatewayStep.data.pid, '777');
  assert.equal(calls.gatewayStatusText.length, 0);
});

test('runDiagnostics logs phase reports bounded, rounded size facts and detects gateway-log errors via the original filter', async () => {
  const logPath = '/home/fake-user/.openclaw/logs/gateway.log';
  const errLogPath = '/home/fake-user/.openclaw/logs/gateway.err.log';
  const { deps, calls } = fakeDeps({
    existingPaths: new Set(['/home/fake-user/.openclaw', '/home/fake-user/.openclaw/openclaw.json', logPath, errLogPath]),
    fileSizes: { [logPath]: 3 * 1024 * 1024, [errLogPath]: 1024 * 1024 },
    fileTails: {
      [logPath]: 'plain line one\nERROR: boom\nsignal SIGTERM\nplain line two',
      [errLogPath]: 'stderr detail one\nstderr detail two',
    },
  });
  const core = createDiagnosticsCore(deps);
  const events = [];
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-logs-1', emit: (e) => events.push(e) }),
    DiagnosticsCoreIncompleteError,
  );
  const logsStep = findStep(events, 'logs');
  assert.ok(logsStep);
  assert.equal(logsStep.label, 'Reading recent logs');
  assert.equal(logsStep.data.logSizeMB, 3);
  assert.equal(logsStep.data.errLogSizeMB, 1);
  assert.equal(logsStep.data.hasErrors, true);
  assert.equal(logsStep.data.errorLineCount, 1);
  assert.equal(logsStep.data.hasGatewaySignals, true);
  assert.equal(logsStep.data.gatewaySignalLineCount, 1);
  assert.equal(logsStep.data.hasStderr, true);

  assert.equal(calls.readFileTail.length, 2, 'both bounded log tails are collected for later issue/envelope use');
  assert.deepEqual(calls.readFileTail, [
    {
      path: logPath,
      options: { maxLines: 500, maxBytes: 1024 * 1024 },
    },
    {
      path: errLogPath,
      options: { maxLines: 200, maxBytes: 1024 * 1024 },
    },
  ]);
  assert.ok(calls.stat.includes(logPath));
  assert.ok(calls.stat.includes(errLogPath));
});

test('runDiagnostics logs phase reports hasErrors=false when no gateway-log line matches the error filter', async () => {
  const logPath = '/home/fake-user/.openclaw/logs/gateway.log';
  const { deps } = fakeDeps({
    existingPaths: new Set(['/home/fake-user/.openclaw', '/home/fake-user/.openclaw/openclaw.json', logPath]),
    fileSizes: { [logPath]: 0 },
    fileTails: { [logPath]: 'all quiet\nnothing to see here' },
  });
  const core = createDiagnosticsCore(deps);
  const events = [];
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-logs-2', emit: (e) => events.push(e) }),
    DiagnosticsCoreIncompleteError,
  );
  const logsStep = findStep(events, 'logs');
  assert.equal(logsStep.data.hasErrors, false);
  assert.equal(logsStep.data.errLogSizeMB, 0);
});

test('runDiagnostics logs phase reports zero sizes and fetches no tail when neither log file exists', async () => {
  const { deps, calls } = fakeDeps();
  const core = createDiagnosticsCore(deps);
  const events = [];
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-logs-3', emit: (e) => events.push(e) }),
    DiagnosticsCoreIncompleteError,
  );
  const logsStep = findStep(events, 'logs');
  assert.equal(logsStep.data.logSizeMB, 0);
  assert.equal(logsStep.data.errLogSizeMB, 0);
  assert.equal(logsStep.data.hasErrors, false);
  assert.equal(calls.readFileTail.length, 0);
  assert.equal(calls.stat.length, 0);
});

test('runDiagnostics service phase reports raw service-manager state facts with nulls for absent fields', async () => {
  const { deps, calls } = fakeDeps({
    serviceManagerState: {
      manager: 'launchd', runs: 5, pid: 999, state: 'running', lastExitCode: 0, uptimeStr: '1:02:03', uptimeSeconds: 3723,
    },
  });
  const core = createDiagnosticsCore(deps);
  const events = [];
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-svc-1', emit: (e) => events.push(e) }),
    DiagnosticsCoreIncompleteError,
  );
  const serviceStep = findStep(events, 'service');
  assert.ok(serviceStep);
  assert.equal(serviceStep.label, 'Checking service health');
  assert.deepEqual(serviceStep.data, {
    manager: 'launchd', runs: 5, pid: 999, state: 'running', subState: null, nRestarts: null, lastExitCode: 0, uptimeStr: '1:02:03', uptimeSeconds: 3723,
  });
  assert.deepEqual(calls.serviceManagerState[0], { timeoutMs: 5000 });
});

test('runDiagnostics service phase reports all-null facts when the service manager is unavailable', async () => {
  const { deps } = fakeDeps({ serviceManagerState: {} });
  const core = createDiagnosticsCore(deps);
  const events = [];
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-svc-2', emit: (e) => events.push(e) }),
    DiagnosticsCoreIncompleteError,
  );
  const serviceStep = findStep(events, 'service');
  assert.deepEqual(serviceStep.data, {
    manager: null, runs: null, pid: null, state: null, subState: null, nRestarts: null, lastExitCode: null, uptimeStr: null, uptimeSeconds: null,
  });
});

test('runDiagnostics workspace phase reports path resolution, markdown/memory counts, SOUL/AGENTS existence, plugin facts, and derived CODEX_HOME facts', async () => {
  const workspaceDir = '/home/fake-user/workspace';
  const soulPath = `${workspaceDir}/SOUL.md`;
  const agentsPath = `${workspaceDir}/AGENTS.md`;
  const memoryDir = `${workspaceDir}/memory`;
  const { deps, calls } = fakeDeps({
    config: {
      agents: { defaults: { workspace: workspaceDir } },
      plugins: { entries: { codex: { enabled: true }, disabledPlugin: { enabled: false } } },
      env: {},
    },
    existingPaths: new Set([
      '/home/fake-user/.openclaw', '/home/fake-user/.openclaw/openclaw.json',
      workspaceDir, soulPath, agentsPath, memoryDir,
    ]),
    mdFileCount: 12,
    dirEntries: { [memoryDir]: ['2026-07-20.md', '2026-07-21.md', 'notes.txt'] },
    env: { CODEX_HOME: '/home/fake-user/.openclaw/codex-home' },
  });
  const core = createDiagnosticsCore(deps);
  const events = [];
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-ws-1', emit: (e) => events.push(e) }),
    DiagnosticsCoreIncompleteError,
  );
  const workspaceStep = findStep(events, 'workspace');
  assert.ok(workspaceStep);
  assert.equal(workspaceStep.label, 'Checking workspace');
  assert.equal(workspaceStep.data.path, workspaceDir);
  assert.equal(workspaceStep.data.exists, true);
  assert.equal(workspaceStep.data.mdFiles, 12);
  assert.equal(workspaceStep.data.memoryFiles, 2, 'only .md entries in the memory dir are counted');
  assert.equal(workspaceStep.data.hasSoul, true);
  assert.equal(workspaceStep.data.hasAgents, true);
  assert.deepEqual(workspaceStep.data.plugins, [
    { name: 'codex', enabled: true },
    { name: 'disabledPlugin', enabled: false },
  ]);
  assert.deepEqual(workspaceStep.data.codexHome, {
    expected: '/home/fake-user/.openclaw/codex-home',
    shellSet: true,
    matchesExpected: true,
  });
  assert.ok(calls.countMarkdownFiles.includes(workspaceDir));
  assert.ok(calls.readdir.includes(memoryDir));
});

test('runDiagnostics workspace phase reports all defaults and performs no workspace-path lookups when no workspace is configured', async () => {
  const { deps, calls } = fakeDeps();
  const core = createDiagnosticsCore(deps);
  const events = [];
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-ws-2', emit: (e) => events.push(e) }),
    DiagnosticsCoreIncompleteError,
  );
  const workspaceStep = findStep(events, 'workspace');
  assert.deepEqual(workspaceStep.data, {
    path: null,
    exists: false,
    mdFiles: 0,
    memoryFiles: 0,
    hasSoul: false,
    hasAgents: false,
    plugins: [],
    codexHome: {
      expected: '/home/fake-user/.openclaw/codex-home',
      shellSet: false,
      matchesExpected: false,
    },
  });
  assert.equal(calls.countMarkdownFiles.length, 0);
  assert.equal(calls.readdir.length, 0);
});

test('runDiagnostics workspace phase reports exists=false and skips file lookups when the configured workspace path is missing', async () => {
  const workspaceDir = '/home/fake-user/missing-workspace';
  const { deps, calls } = fakeDeps({
    config: { agents: { defaults: { workspace: workspaceDir } }, env: {} },
  });
  const core = createDiagnosticsCore(deps);
  const events = [];
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-ws-3', emit: (e) => events.push(e) }),
    DiagnosticsCoreIncompleteError,
  );
  const workspaceStep = findStep(events, 'workspace');
  assert.equal(workspaceStep.data.path, workspaceDir);
  assert.equal(workspaceStep.data.exists, false);
  assert.equal(workspaceStep.data.mdFiles, 0);
  assert.equal(workspaceStep.data.memoryFiles, 0);
  assert.equal(calls.countMarkdownFiles.length, 0);
});

test('runDiagnostics workspace phase fails open to zero counts when countMarkdownFiles and readdir throw', async () => {
  const workspaceDir = '/home/fake-user/workspace';
  const memoryDir = `${workspaceDir}/memory`;
  const { deps } = fakeDeps({
    config: { agents: { defaults: { workspace: workspaceDir } }, env: {} },
    existingPaths: new Set([
      '/home/fake-user/.openclaw', '/home/fake-user/.openclaw/openclaw.json', workspaceDir, memoryDir,
    ]),
    countMarkdownFilesThrows: true,
  });
  const core = createDiagnosticsCore(deps);
  const events = [];
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-ws-4', emit: (e) => events.push(e) }),
    DiagnosticsCoreIncompleteError,
  );
  const workspaceStep = findStep(events, 'workspace');
  assert.equal(workspaceStep.data.mdFiles, 0);
  assert.equal(workspaceStep.data.memoryFiles, 0, 'readdir throwing on an existing memory dir must fail open to zero, not crash the scan');
  assert.equal(workspaceStep.data.hasSoul, false);
  assert.equal(workspaceStep.data.hasAgents, false);
});

test('runDiagnostics reports the CODEX_HOME fact from injected env, not from ambient process.env', async () => {
  const originalCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = '/should-never-be-read';
  try {
    const { deps } = fakeDeps({ env: { CODEX_HOME: '/injected/codex-home' } });
    const core = createDiagnosticsCore(deps);
    const events = [];
    await assert.rejects(
      core.runDiagnostics({ revision: 'rev-codex-env', emit: (e) => events.push(e) }),
      DiagnosticsCoreIncompleteError,
    );
    const workspaceStep = findStep(events, 'workspace');
    assert.deepEqual(workspaceStep.data.codexHome, {
      expected: '/home/fake-user/.openclaw/codex-home',
      shellSet: true,
      matchesExpected: false,
    });
    assert.equal(JSON.stringify(workspaceStep.data).includes('/injected/codex-home'), false);
  } finally {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  }
});

test('runDiagnostics gateway/logs/service/workspace step data never carries secrets or the full raw config', async () => {
  const workspaceDir = '/home/fake-user/workspace';
  const { deps } = fakeDeps({
    config: {
      gateway: { port: 18789 },
      agents: { defaults: { workspace: workspaceDir } },
      env: { OPENCLAW_TOKEN: 'super-secret-token-value' },
    },
    redact: (value) => ({ ...value, redacted: true }),
  });
  const core = createDiagnosticsCore(deps);
  const events = [];
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-secrets', emit: (e) => events.push(e) }),
    DiagnosticsCoreIncompleteError,
  );
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes('super-secret-token-value'), 'no scan.step data may leak a config secret');
  assert.ok(!serialized.includes('OPENCLAW_TOKEN'), 'no scan.step data may leak a raw config key');
  for (const event of events) {
    if (event.type === 'scan.step') {
      assert.equal(Object.isFrozen(event.data), true);
    }
  }
});

test('runDiagnostics never emits scan.completed while traversing the gateway/logs/service/workspace bands', async () => {
  const { deps } = fakeDeps();
  const core = createDiagnosticsCore(deps);
  const events = [];
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-no-complete', emit: (e) => events.push(e) }),
    DiagnosticsCoreIncompleteError,
  );
  assert.deepEqual(events.map((e) => e.phase).filter(Boolean), ['discover', 'system', 'config', 'gateway', 'logs', 'service', 'workspace']);
  assert.equal(events.filter((e) => e.type === 'scan.completed').length, 0);
  const terminals = events.filter((e) => e.type === 'scan.error' || e.type === 'scan.completed');
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].error.code, 'NOT_IMPLEMENTED');
});

test('runDiagnostics emits exactly one INTERNAL terminal scan.error and rejects the original error when the gateway boundary throws unexpectedly', async () => {
  const boom = new Error('gateway status probe exploded');
  const { deps } = fakeDeps({ gatewayStatusTextThrows: boom });
  const core = createDiagnosticsCore(deps);
  const events = [];
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-gw-boundary-fail', emit: (e) => events.push(e) }),
    (error) => error === boom,
  );
  assert.deepEqual(events.map((e) => e.type), ['scan.started', 'scan.step', 'scan.step', 'scan.step', 'scan.error']);
  const terminal = events[events.length - 1];
  assert.equal(terminal.error.code, 'INTERNAL');
  assert.equal(terminal.error.message, 'gateway status probe exploded');
  assert.equal(events.filter((e) => e.type === 'scan.completed').length, 0);
  assert.equal(events.some((e) => e.type === 'scan.step' && e.phase === 'gateway'), false);
});

test('DiagnosticsCoreIncompleteError names the still-unextracted bands after Slice 3A (ports, native, envelope) and no longer blocks on gateway/logs/service/workspace', async () => {
  const { deps } = fakeDeps();
  const core = createDiagnosticsCore(deps);
  await assert.rejects(
    core.runDiagnostics({ revision: 'rev-msg' }),
    (error) => {
      assert.ok(error instanceof DiagnosticsCoreIncompleteError);
      assert.equal(error.code, 'NOT_IMPLEMENTED');
      assert.match(error.message, /gateway/);
      assert.match(error.message, /native/);
      assert.match(error.message, /envelope/);
      assert.match(error.message, /ports/);
      assert.match(error.message, /workspace/);
      return true;
    },
  );
});
