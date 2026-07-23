import { randomUUID } from 'node:crypto';

// The fixed set of diagnostic collection bands a scan.step event can report on. Extending this
// list is how later Task 4 slices add gateway/logs/service/workspace/ports/native/issues phases;
// it exists now so scanStep can validate `phase` even before every phase is implemented.
export const SCAN_PHASES = Object.freeze([
  'discover',
  'system',
  'config',
  'gateway',
  'logs',
  'service',
  'workspace',
  'ports',
  'native',
  'issues',
]);

const SCAN_EVENTS = new WeakSet();

function brand(event) {
  SCAN_EVENTS.add(event);
  return event;
}

export function isScanEvent(value) {
  return value !== null && typeof value === 'object' && SCAN_EVENTS.has(value);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Recursively validate that a caller-supplied payload is JSON-like transport data — the only
// shape a semantic scan event's structured fields may carry — and build a fresh clone of it.
// structuredClone() is deliberately NOT used here: it happily accepts Date/Map/Set/class
// instances (an internally-mutable Date survives Object.freeze) and cycles, none of which are
// valid transport-neutral data. `seen` is an ancestor-only guard (added on entry, removed on
// exit), so it rejects true cycles while still allowing the same plain object/array to appear at
// two unrelated positions (a DAG) — each occurrence is cloned independently.
//
// Property access uses getOwnPropertyDescriptor + descriptor.value, never a plain `value[key]`
// read, so a malicious/accidental getter is never invoked while validating.
function validateJsonLike(value, seen) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('numbers must be finite: NaN and Infinity are not JSON-like transport data');
    }
    return value;
  }
  if (type !== 'object') {
    throw new TypeError(`${type} values are not JSON-like transport data`);
  }

  if (seen.has(value)) {
    throw new TypeError('circular references are not JSON-like transport data');
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === 'symbol')) {
    throw new TypeError('symbol-keyed properties are not JSON-like transport data');
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const result = new Array(value.length);
      for (const key of ownKeys) {
        if (key === 'length') continue;
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
          throw new TypeError('custom array properties are not JSON-like transport data');
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor.enumerable || descriptor.get || descriptor.set) {
          throw new TypeError('hidden or accessor array elements are not JSON-like transport data');
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) throw new TypeError('sparse arrays are not JSON-like transport data');
        Object.defineProperty(result, String(index), {
          value: validateJsonLike(descriptor.value, seen),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return result;
    }

    if (!isPlainObject(value)) {
      throw new TypeError(
        'only plain objects and arrays are JSON-like transport data (no Date/Map/Set/class instances)',
      );
    }

    const result = {};
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable) {
        throw new TypeError('non-enumerable properties are not JSON-like transport data');
      }
      if (descriptor.get || descriptor.set) {
        throw new TypeError('accessor properties/getters/setters are not JSON-like transport data');
      }
      Object.defineProperty(result, key, {
        value: validateJsonLike(descriptor.value, seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

// Snapshot a caller-supplied payload so a later mutation of the caller's own object cannot
// retroactively change an already-validated, already-emitted event.
function freezeSnapshot(value) {
  return deepFreeze(validateJsonLike(value, new WeakSet()));
}

function validateRevision(revision) {
  if (typeof revision !== 'string' || revision.length === 0) {
    throw new TypeError('revision must be a non-empty string');
  }
  return revision;
}

function validatePlainObject(value, name) {
  if (!isPlainObject(value)) throw new TypeError(`${name} must be a plain object`);
  return value;
}

export function scanStarted({ revision } = {}) {
  validateRevision(revision);
  return brand(Object.freeze({ type: 'scan.started', revision }));
}

export function scanStep({
  revision, phase, label, data = {},
} = {}) {
  validateRevision(revision);
  if (!SCAN_PHASES.includes(phase)) {
    throw new TypeError(`phase must be one of: ${SCAN_PHASES.join(', ')}`);
  }
  if (typeof label !== 'string' || label.length === 0) {
    throw new TypeError('label must be a non-empty string');
  }
  validatePlainObject(data, 'data');
  return brand(Object.freeze({
    type: 'scan.step',
    revision,
    phase,
    label,
    data: freezeSnapshot(data),
  }));
}

export function scanCompleted({ revision, summary, findings } = {}) {
  validateRevision(revision);
  validatePlainObject(summary, 'summary');
  if (!Array.isArray(findings)) throw new TypeError('findings must be an array');
  return brand(Object.freeze({
    type: 'scan.completed',
    revision,
    summary: freezeSnapshot(summary),
    findings: freezeSnapshot(findings),
  }));
}

export function scanWarning({ revision, code, message } = {}) {
  validateRevision(revision);
  if (typeof code !== 'string' || code.length === 0) {
    throw new TypeError('code must be a non-empty string');
  }
  if (typeof message !== 'string' || message.length === 0) {
    throw new TypeError('message must be a non-empty string');
  }
  return brand(Object.freeze({
    type: 'scan.warning', revision, code, message,
  }));
}

export function scanError({ revision, error } = {}) {
  validateRevision(revision);
  validatePlainObject(error, 'error');
  const descriptors = Object.getOwnPropertyDescriptors(error);
  const messageDescriptor = descriptors.message;
  if (!messageDescriptor || !Object.prototype.hasOwnProperty.call(messageDescriptor, 'value')
    || typeof messageDescriptor.value !== 'string' || messageDescriptor.value.length === 0) {
    throw new TypeError('error.message must be a non-empty data-property string');
  }
  const codeDescriptor = descriptors.code;
  if (codeDescriptor && (!Object.prototype.hasOwnProperty.call(codeDescriptor, 'value')
    || typeof codeDescriptor.value !== 'string')) {
    throw new TypeError('error.code must be a data-property string');
  }
  const safeError = codeDescriptor === undefined
    ? { message: messageDescriptor.value }
    : { message: messageDescriptor.value, code: codeDescriptor.value };
  return brand(Object.freeze({ type: 'scan.error', revision, error: deepFreeze(safeError) }));
}

// Caller-owned, per-instance scan currency tracker. All mutable state (which revision is
// "current") lives in this closure — there is no module-level global. Ownership belongs to
// whoever drives scans (a test, later a session controller): each creates and holds its own
// coordinator instance.
//
// The coordinator gates BOTH emitted events and final results on the same currency source, so a
// superseded scan's late scan.step/scan.warning/scan.error/scan.completed can never reach the
// sink, and its final settle() value can never overwrite newer state.
export function createScanCoordinator({ makeId = randomUUID, sink } = {}) {
  if (typeof makeId !== 'function') throw new TypeError('makeId must be a function');
  if (sink !== undefined && typeof sink !== 'function') throw new TypeError('sink must be a function');

  let current = null;

  function begin() {
    const revision = makeId();
    if (typeof revision !== 'string' || revision.length === 0) {
      throw new TypeError('makeId() must return a non-empty string');
    }
    current = revision;
    let terminated = false;

    function isCurrent() {
      return current === revision;
    }

    function emit(event) {
      if (!isScanEvent(event)) throw new TypeError('event must be a validated scan event');
      if (event.revision !== revision) {
        throw new TypeError("event revision must match this scan handle's revision");
      }
      if (!isCurrent() || terminated) return;
      if (event.type === 'scan.completed' || event.type === 'scan.error') terminated = true;
      sink?.(event);
    }

    function settle(value) {
      return isCurrent() ? value : undefined;
    }

    return Object.freeze({
      revision, emit, isCurrent, settle,
    });
  }

  function currentRevision() {
    return current;
  }

  return Object.freeze({ begin, currentRevision });
}
