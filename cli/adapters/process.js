import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import { TextDecoder } from 'node:util';

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_KILL_GRACE_MS = 250;

function validateInvocation(executable, argv, options = {}) {
  if (typeof executable !== 'string' || executable.length === 0 || executable.includes('\0')) {
    throw new TypeError('executable must be a non-empty string without NUL bytes');
  }
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string' || value.includes('\0'))) {
    throw new TypeError('argv must be an array of strings without NUL bytes');
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive safe integer');
  }
  for (const [name, value] of Object.entries({ maxStdoutBytes, maxStderrBytes })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer`);
    }
  }
  if (options.signal !== undefined && !isAbortSignal(options.signal)) {
    throw new TypeError('signal must be an AbortSignal');
  }
  if (options.cwd !== undefined
    && typeof options.cwd !== 'string'
    && !(options.cwd instanceof URL && options.cwd.protocol === 'file:')) {
    throw new TypeError('cwd must be a string or file URL');
  }
  if (options.env !== undefined && !isPlainObject(options.env)) {
    throw new TypeError('env must be a non-null plain object');
  }
  if (options.windowsHide !== undefined && typeof options.windowsHide !== 'boolean') {
    throw new TypeError('windowsHide must be a boolean');
  }

  return {
    argv: Object.freeze([...argv]),
    timeoutMs,
    maxStdoutBytes,
    maxStderrBytes,
    signal: options.signal,
    cwd: options.cwd instanceof URL ? new URL(options.cwd) : options.cwd,
    env: options.env === undefined ? undefined : Object.freeze({ ...options.env }),
    windowsHide: options.windowsHide ?? true,
  };
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isAbortSignal(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.aborted === 'boolean'
    && typeof value.addEventListener === 'function'
    && typeof value.removeEventListener === 'function';
}

function errorFields(error) {
  if (!error) return { errorSummary: null, errorCode: null };
  return {
    errorSummary: typeof error.message === 'string' ? error.message : String(error),
    errorCode: typeof error.code === 'string' || typeof error.code === 'number' ? error.code : null,
  };
}

function makeResult({
  status = null,
  signal = null,
  stdout = '',
  stderr = '',
  error = null,
  timedOut = false,
  aborted = false,
  stdoutTruncated = false,
  stderrTruncated = false,
  outputLimitExceeded = false,
}) {
  return Object.freeze({
    status,
    signal,
    stdout,
    stderr,
    ...errorFields(error),
    timedOut,
    aborted,
    stdoutTruncated,
    stderrTruncated,
    outputLimitExceeded,
  });
}

function createCollector(limit) {
  const chunks = [];
  let captured = 0;
  let truncated = false;

  return {
    add(value) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const remaining = limit - captured;
      if (remaining > 0) {
        const kept = Buffer.from(chunk.subarray(0, remaining));
        chunks.push(kept);
        captured += kept.length;
      }
      if (chunk.length > remaining) truncated = true;
    },
    value() {
      const bytes = Buffer.concat(chunks, captured);
      return truncated
        ? new TextDecoder().decode(bytes, { stream: true })
        : new TextDecoder().decode(bytes);
    },
    get truncated() {
      return truncated;
    },
  };
}

function abortedResult() {
  const error = new Error('Process aborted');
  error.code = 'ABORT_ERR';
  return makeResult({ error, aborted: true });
}

export function createProcessAdapter({
  spawn = nodeSpawn,
  spawnSync = nodeSpawnSync,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
} = {}) {
  if (typeof spawn !== 'function' || typeof spawnSync !== 'function') {
    throw new TypeError('spawn and spawnSync must be functions');
  }
  if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 0) {
    throw new TypeError('killGraceMs must be a non-negative safe integer');
  }

  async function run(executable, argv, options = {}) {
    const invocation = validateInvocation(executable, argv, options);
    if (invocation.signal?.aborted) return abortedResult();

    const stdout = createCollector(invocation.maxStdoutBytes);
    const stderr = createCollector(invocation.maxStderrBytes);

    return new Promise((resolve) => {
      let child;
      let timer;
      let killTimer;
      let settled = false;
      let processError = null;
      let timedOut = false;
      let aborted = false;

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        invocation.signal?.removeEventListener('abort', onAbort);
        child?.stdout?.removeListener('data', onStdout);
        child?.stderr?.removeListener('data', onStderr);
        child?.removeListener('error', onError);
        child?.removeListener('close', onClose);
      };
      const finish = (status = null, childSignal = null) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(makeResult({
          status: processError ? null : status,
          signal: childSignal,
          stdout: stdout.value(),
          stderr: stderr.value(),
          error: processError,
          timedOut,
          aborted,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        }));
      };
      const stop = () => {
        if (settled || killTimer !== undefined) return;
        try {
          if (!child?.killed) child?.kill('SIGKILL');
        } catch {
          // The primary timeout/abort error remains authoritative.
        }
        if (settled) return;
        killTimer = setTimeout(() => {
          if (settled) return;
          const primaryError = processError ?? new Error('Process stopped');
          const unconfirmedError = new Error(
            `${primaryError.message}; termination unconfirmed after ${killGraceMs}ms`,
            { cause: primaryError },
          );
          Object.assign(unconfirmedError, primaryError);
          processError = unconfirmedError;
          for (const resource of [child?.stdin, child?.stdout, child?.stderr]) {
            try {
              resource?.destroy?.();
            } catch {
              // Best-effort handle release must not escape a timer callback.
            }
          }
          try {
            child?.unref?.();
          } catch {
            // Best-effort handle release must not escape a timer callback.
          }
          const onLateError = () => {};
          const onLateClose = () => {
            child?.removeListener('error', onLateError);
            child?.removeListener('close', onLateClose);
          };
          child?.on('error', onLateError);
          child?.on('close', onLateClose);
          finish();
        }, killGraceMs);
      };
      const onAbort = () => {
        if (timedOut || aborted) return;
        aborted = true;
        processError ??= Object.assign(new Error('Process aborted'), { code: 'ABORT_ERR' });
        stop();
      };
      const onStdout = (chunk) => stdout.add(chunk);
      const onStderr = (chunk) => stderr.add(chunk);
      const onError = (error) => {
        processError ??= error;
      };
      const onClose = (status, childSignal) => finish(status, childSignal);

      try {
        child = spawn(executable, invocation.argv, {
          cwd: invocation.cwd,
          env: invocation.env,
          windowsHide: invocation.windowsHide,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
        });
      } catch (error) {
        processError = error;
        finish();
        return;
      }

      child.stdout?.on('data', onStdout);
      child.stderr?.on('data', onStderr);
      child.on('error', onError);
      child.on('close', onClose);
      timer = setTimeout(() => {
        if (aborted || timedOut) return;
        timedOut = true;
        processError ??= Object.assign(new Error(`Process timed out after ${invocation.timeoutMs}ms`), {
          code: 'ETIMEDOUT',
        });
        stop();
      }, invocation.timeoutMs);
      timer.unref?.();
      invocation.signal?.addEventListener('abort', onAbort, { once: true });
      if (invocation.signal?.aborted) onAbort();
    });
  }

  function runSync(executable, argv, options = {}) {
    const invocation = validateInvocation(executable, argv, options);
    if (invocation.signal?.aborted) return abortedResult();

    let raw;
    try {
      raw = spawnSync(executable, invocation.argv, {
        cwd: invocation.cwd,
        env: invocation.env,
        windowsHide: invocation.windowsHide,
        timeout: invocation.timeoutMs,
        maxBuffer: Math.max(invocation.maxStdoutBytes, invocation.maxStderrBytes) + 1,
        encoding: 'buffer',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
    } catch (error) {
      return makeResult({ error });
    }

    const stdout = createCollector(invocation.maxStdoutBytes);
    const stderr = createCollector(invocation.maxStderrBytes);
    if (raw?.stdout !== undefined && raw.stdout !== null) stdout.add(raw.stdout);
    if (raw?.stderr !== undefined && raw.stderr !== null) stderr.add(raw.stderr);
    const timedOut = raw?.error?.code === 'ETIMEDOUT';
    const outputLimitExceeded = raw?.error?.code === 'ENOBUFS';

    return makeResult({
      status: raw?.error ? null : (raw?.status ?? null),
      signal: raw?.signal ?? null,
      stdout: stdout.value(),
      stderr: stderr.value(),
      error: raw?.error ?? null,
      timedOut,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      outputLimitExceeded,
    });
  }

  return Object.freeze({ run, runSync });
}

export const processAdapter = createProcessAdapter();
export const runProcess = processAdapter.run;
export const runProcessSync = processAdapter.runSync;
