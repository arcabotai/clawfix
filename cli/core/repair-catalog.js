// ClawFix Task 6: repair catalog — the single source of truth for what an executable repair
// actually does. Each entry is the full contract the repair engine drives a repair through:
//
//   preflight(ctx) -> { ok, reason?, evidence }   — is this repair still applicable right now?
//   preview(ctx)   -> { steps: string[] }         — describe the plan; must have NO side effects.
//   apply(ctx)     -> { ... }                     — perform the repair via injected adapters only.
//   verify(ctx)    -> { ok, evidence }             — re-check *runtime* evidence, never title text.
//   rollback(ctx, { applyResult }) -> { rolledBack, note }
//
// `ctx` carries the adapters a repair is allowed to touch — never a raw shell string. For
// gateway-not-running, ctx.openclaw is the OpenClaw process boundary (cli/adapters/openclaw.js),
// which itself only ever spawns argv arrays (shell: false). ctx.wait is an injectable delay hook
// so tests can drive apply -> verify without real timers.

import { applyFailureReason } from './repair-engine.js';

/**
 * Preserve the process adapter's complete terminal verdict without retaining command output or
 * raw Error objects in repair/session state. The repair engine must see every failure marker;
 * projecting only `status` lets a status-zero timeout, abort, signal, or truncated result pass.
 */
function terminalResult(result, details = {}) {
  const source = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  const projected = {
    status: source.status,
    signal: source.signal ?? null,
    timedOut: source.timedOut ?? false,
    aborted: source.aborted ?? false,
    stdoutTruncated: source.stdoutTruncated ?? false,
    stderrTruncated: source.stderrTruncated ?? false,
    outputLimitExceeded: source.outputLimitExceeded ?? false,
    errorCode: source.errorCode ?? null,
    errorSummary: source.errorSummary ?? null,
    error: source.error == null ? null : true,
  };
  for (const field of ['partial', 'partiallyApplied']) {
    if (Object.hasOwn(source, field)) projected[field] = source[field];
  }
  return Object.freeze({ ...projected, ...details });
}

/**
 * Is the gateway actually up?
 *
 * The answer is the listening port. Two weaker signals were previously treated as proof and
 * both were wrong on a real install:
 *
 *  - `pgrep -f 'openclaw.*gateway'` matched ClawFix's own `openclaw gateway status` probe (run
 *    concurrently with it, right here) and never matched a real gateway, whose argv is just
 *    `openclaw`. verify() therefore returned ok with nothing listening on the port, which is
 *    how a repair that did nothing could be reported as applied.
 *  - the `/running.*pid|state active/i` test against status prose never fired on the real
 *    `openclaw gateway status` output at all.
 *
 * Status text and PIDs are still collected, as evidence for the caller — never as the verdict.
 */
async function checkGatewayRunning(ctx) {
  const { openclaw } = ctx;
  const port = Number.isInteger(ctx.gatewayPort) ? ctx.gatewayPort : 18789;
  const [statusText, pid, listening] = await Promise.all([
    openclaw.gatewayStatusText({ timeoutMs: 5000 }),
    typeof openclaw.gatewayProcesses === 'function'
      ? openclaw.gatewayProcesses({ timeoutMs: 5000 })
      : Promise.resolve(''),
    typeof openclaw.gatewayListening === 'function'
      ? openclaw.gatewayListening(port, { timeoutMs: 5000 })
      : Promise.resolve(null),
  ]);

  // Without a port probe, fall back to filtered PIDs rather than claiming knowledge.
  const running = listening === null ? Boolean(pid) : Boolean(listening);
  return Object.freeze({
    running,
    listening: listening === null ? null : Boolean(listening),
    port,
    statusText: statusText || '',
    pid: pid || '',
  });
}

const gatewayNotRunning = Object.freeze({
  id: 'gateway-not-running',
  title: 'Restart the OpenClaw gateway',
  description: 'The OpenClaw gateway process is not running. Restart it via the OpenClaw CLI.',
  risk: 'low',

  async preflight(ctx) {
    const evidence = await checkGatewayRunning(ctx);
    if (evidence.running) {
      return Object.freeze({ ok: false, reason: 'gateway_already_running', evidence });
    }
    return Object.freeze({ ok: true, evidence });
  },

  async preview() {
    return Object.freeze({
      steps: Object.freeze([
        'Invoke `openclaw gateway restart` through the OpenClaw process adapter (argv, no shell).',
        'Wait briefly for the gateway to come up.',
        'Re-check gateway process/port evidence to confirm recovery.',
      ]),
    });
  },

  async apply(ctx) {
    const { openclaw } = ctx;
    const result = await openclaw.invoke(['gateway', 'restart'], { timeoutMs: 60_000 });
    return terminalResult(result);
  },

  async verify(ctx) {
    if (typeof ctx.wait === 'function') await ctx.wait(3000);
    const evidence = await checkGatewayRunning(ctx);
    return Object.freeze({ ok: evidence.running, evidence });
  },

  async rollback() {
    return Object.freeze({
      rolledBack: false,
      note: 'Gateway restart has no config/state to revert; run `openclaw gateway stop` manually if this restart was unwanted.',
    });
  },
});

/** Normalized truthiness of an `openclaw config get` result. '' means unset or unreadable. */
function configFlag(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return null;
}

function configValue(read) {
  if (!read || read.ok !== true || typeof read.value !== 'string') return null;
  return read.value;
}

/**
 * A repair that flips one boolean OpenClaw config key to `target`.
 *
 * Every step goes through the OpenClaw CLI as argv — read the current value, set it, read it
 * back. Verification is the read-back, so a `config set` that reported success but changed
 * nothing still fails. A key OpenClaw cannot report is refused rather than assumed: unreadable
 * is not the same as false.
 */
function configToggleRepair({ id, key, target, title, description, blockedReason, risk = 'low' }) {
  const targetText = String(target);
  const previousText = String(!target);

  return Object.freeze({
    id,
    key,
    title,
    description,
    risk,

    async preflight(ctx) {
      const read = await ctx.openclaw.configGet(key, { timeoutMs: 10_000 });
      const current = configValue(read);
      const flag = configFlag(current);
      if (flag === null) {
        return Object.freeze({
          ok: false,
          reason: 'config_state_unknown',
          evidence: { key, current: current ?? '', errorSummary: read?.errorSummary ?? null },
        });
      }
      if (flag === target) {
        return Object.freeze({ ok: false, reason: blockedReason, evidence: { key, current } });
      }
      return Object.freeze({ ok: true, evidence: { key, current } });
    },

    async preview() {
      return Object.freeze({
        steps: Object.freeze([
          `Read ${key} through the OpenClaw CLI (argv, no shell).`,
          `Set ${key} to ${targetText}.`,
          'Read it back to confirm the change actually landed.',
        ]),
        summary: `openclaw config set ${key} ${targetText}`,
      });
    },

    async apply(ctx) {
      const result = await ctx.openclaw.configSet(key, targetText, { timeoutMs: 30_000 });
      const failure = applyFailureReason(result);
      return terminalResult(result, {
        changed: failure === null ? true : 'unknown',
        changes: failure === null
          ? Object.freeze([Object.freeze({ type: 'config', key, before: previousText, after: targetText })])
          : Object.freeze([]),
      });
    },

    async verify(ctx) {
      const read = await ctx.openclaw.configGet(key, { timeoutMs: 10_000 });
      const current = configValue(read);
      return Object.freeze({
        ok: configFlag(current) === target,
        evidence: { key, current: current ?? '', errorSummary: read?.errorSummary ?? null },
      });
    },

    async rollback(ctx) {
      const result = await ctx.openclaw.configSet(key, previousText, { timeoutMs: 30_000 });
      if (result.status !== 0) {
        return Object.freeze({
          rolledBack: false,
          note: `Could not restore ${key}; check \`openclaw config get ${key}\`.`,
        });
      }
      const read = await ctx.openclaw.configGet(key, { timeoutMs: 10_000 });
      const current = configValue(read);
      const restored = configFlag(current) === !target;
      return Object.freeze({
        rolledBack: restored,
        note: restored
          ? `Restored ${key} to ${previousText}.`
          : read?.ok === true
            ? `Rollback command completed but ${key} was not restored to ${previousText}.`
            : `Rollback command completed but ${key} could not be read back: `
              + `${read?.errorSummary ?? 'unknown read failure'}.`,
      });
    },
  });
}

const autoUpdateEnabled = configToggleRepair({
  id: 'auto-update-enabled-warning',
  key: 'update.auto.enabled',
  target: false,
  title: 'Disable OpenClaw auto-update',
  description:
    'Auto-update restarts the gateway on its own schedule, which is the documented cause of '
    + 'restart loops. This turns it off; updates then happen when you run them.',
  blockedReason: 'auto_update_already_disabled',
});

const hybridSearchDisabled = configToggleRepair({
  id: 'no-hybrid-search',
  key: 'agents.defaults.memorySearch.query.hybrid.enabled',
  target: true,
  title: 'Enable hybrid memory search',
  description:
    'Hybrid search combines keyword and semantic matching when the agent searches memory. '
    + 'OpenClaw recommends it; without it recall is keyword-only.',
  blockedReason: 'hybrid_search_already_enabled',
});

const memoryFlushDisabled = configToggleRepair({
  id: 'no-memory-flush',
  key: 'agents.defaults.compaction.memoryFlush.enabled',
  target: true,
  title: 'Enable memory flush on compaction',
  description:
    'Without a memory flush, anything the agent has not written down is lost when the context '
    + 'is compacted. This makes compaction persist memory first.',
  blockedReason: 'memory_flush_already_enabled',
});

const gatewayLoopbackNoAuth = Object.freeze({
  id: 'gateway-loopback-no-auth',
  title: 'Require a token on the gateway',
  description:
    'The gateway accepts unauthenticated connections. This switches auth to token mode, reuses '
    + 'an existing token or has OpenClaw generate one when missing, and verifies token presence '
    + 'without recording the token. Clients will need that token to connect afterwards.',
  // Medium, not low: existing clients stop working until they carry the new token.
  risk: 'medium',

  async preflight(ctx) {
    const read = await ctx.openclaw.configGet('gateway.auth.mode', { timeoutMs: 10_000 });
    const mode = configValue(read);
    const current = String(mode ?? '').trim().toLowerCase();
    if (mode === null || current === '') {
      return Object.freeze({
        ok: false,
        reason: 'config_state_unknown',
        evidence: { mode: current, errorSummary: read?.errorSummary ?? null },
      });
    }
    if (current === 'token' || current === 'password' || current === 'trusted-proxy') {
      return Object.freeze({ ok: false, reason: 'gateway_auth_already_enabled', evidence: { mode: current } });
    }
    if (current !== 'none') {
      return Object.freeze({ ok: false, reason: 'config_state_unknown', evidence: { mode: current } });
    }
    return Object.freeze({ ok: true, evidence: { mode: current } });
  },

  async preview() {
    return Object.freeze({
      steps: Object.freeze([
        'Check whether gateway.auth.token is present without recording its value.',
        'Set gateway.auth.mode to token through the OpenClaw CLI (argv, no shell).',
        'If no token exists, run `openclaw doctor --fix --generate-gateway-token` so OpenClaw generates one.',
        'Read gateway.auth.mode and token presence back to confirm token auth is usable.',
        'Restart the gateway yourself for it to take effect; existing clients need the new token.',
      ]),
      summary: 'verify/generate gateway token + openclaw config set gateway.auth.mode token',
    });
  },

  async apply(ctx) {
    const changes = [];
    const tokenBefore = await ctx.openclaw.configHasValue(
      'gateway.auth.token',
      { timeoutMs: 10_000 },
    );
    if (!tokenBefore.ok) {
      return terminalResult(tokenBefore, {
        stage: 'read-token-state',
        changed: false,
        changes: Object.freeze(changes),
        errorSummary: tokenBefore.errorSummary || 'could not determine gateway token presence',
      });
    }
    const set = await ctx.openclaw.configSet('gateway.auth.mode', 'token', { timeoutMs: 30_000 });
    if (applyFailureReason(set) !== null) {
      return terminalResult(set, {
        stage: 'set-mode',
        changed: 'unknown',
        changes: Object.freeze(changes),
        tokenPreviouslyPresent: tokenBefore.present,
        tokenMayHaveChanged: false,
      });
    }
    changes.push(Object.freeze({
      type: 'config',
      key: 'gateway.auth.mode',
      before: 'none',
      after: 'token',
    }));
    if (tokenBefore.present) {
      return terminalResult(set, {
        stage: 'set-mode',
        changed: true,
        changes: Object.freeze(changes),
        tokenPreviouslyPresent: true,
        tokenMayHaveChanged: false,
      });
    }
    let generated;
    try {
      generated = await ctx.openclaw.invoke(
        ['doctor', '--fix', '--generate-gateway-token'],
        { timeoutMs: 120_000 },
      );
    } catch (error) {
      return terminalResult(null, {
        stage: 'generate-token',
        changed: true,
        changes: Object.freeze(changes),
        tokenPreviouslyPresent: false,
        tokenMayHaveChanged: true,
        errorSummary: error.message,
        error: true,
      });
    }
    return terminalResult(generated, {
      stage: 'generate-token',
      changed: true,
      changes: Object.freeze(changes),
      tokenPreviouslyPresent: false,
      tokenMayHaveChanged: true,
    });
  },

  // Presence is the strongest safe local assertion: a client authentication round trip would
  // require handling token material, so end-to-end token usability remains an external OpenClaw
  // semantic rather than evidence retained by ClawFix.
  async verify(ctx) {
    const [modeRead, tokenState] = await Promise.all([
      ctx.openclaw.configGet('gateway.auth.mode', { timeoutMs: 10_000 }),
      ctx.openclaw.configHasValue('gateway.auth.token', { timeoutMs: 10_000 }),
    ]);
    const mode = String(configValue(modeRead) ?? '').trim();
    return Object.freeze({
      ok: modeRead?.ok === true
        && mode.toLowerCase() === 'token'
        && tokenState.ok === true
        && tokenState.present === true,
      evidence: {
        mode,
        tokenPresent: tokenState.ok === true ? tokenState.present : null,
        errorSummary: modeRead?.errorSummary ?? tokenState.errorSummary ?? null,
      },
    });
  },

  async rollback(ctx, { applyResult } = {}) {
    if (!applyResult?.changed) {
      return Object.freeze({ rolledBack: false, note: 'Auth mode was never changed.' });
    }
    const setMode = await ctx.openclaw.configSet(
      'gateway.auth.mode',
      'none',
      { timeoutMs: 30_000 },
    );
    if (setMode.status !== 0) {
      return Object.freeze({
        rolledBack: false,
        note: 'Could not restore gateway.auth.mode; inspect it before restarting the gateway.',
      });
    }
    const modeRead = await ctx.openclaw.configGet(
      'gateway.auth.mode',
      { timeoutMs: 10_000 },
    );
    const mode = String(configValue(modeRead) ?? '').trim().toLowerCase();
    if (modeRead?.ok !== true || mode !== 'none') {
      return Object.freeze({
        rolledBack: false,
        note: modeRead?.ok === true
          ? `Rollback command completed but gateway.auth.mode is ${mode || '(empty)'}, not none.`
          : 'Rollback command completed but gateway.auth.mode could not be read back: '
            + `${modeRead?.errorSummary ?? 'unknown read failure'}.`,
      });
    }

    if (applyResult.tokenPreviouslyPresent === false && applyResult.tokenMayHaveChanged) {
      const unset = await ctx.openclaw.configUnset(
        'gateway.auth.token',
        { timeoutMs: 30_000 },
      );
      if (unset.status !== 0) {
        return Object.freeze({
          rolledBack: false,
          note: 'Restored gateway.auth.mode to none, but could not remove the token this repair may have generated.',
        });
      }
      const tokenState = await ctx.openclaw.configHasValue(
        'gateway.auth.token',
        { timeoutMs: 10_000 },
      );
      if (!tokenState.ok || tokenState.present) {
        return Object.freeze({
          rolledBack: false,
          note: tokenState.ok
            ? 'Restored gateway.auth.mode to none, but the generated token is still present.'
            : 'Restored gateway.auth.mode to none, but token absence could not be verified: '
              + `${tokenState.errorSummary ?? 'unknown read failure'}.`,
        });
      }
    }

    return Object.freeze({
      rolledBack: true,
      note: applyResult.tokenPreviouslyPresent === false && applyResult.tokenMayHaveChanged
        ? 'Restored gateway.auth.mode to none and verified the generated token was removed.'
        : 'Restored gateway.auth.mode to its previous value, none.',
    });
  },
});

export const repairCatalog = Object.freeze({
  'gateway-not-running': gatewayNotRunning,
  'auto-update-enabled-warning': autoUpdateEnabled,
  'gateway-loopback-no-auth': gatewayLoopbackNoAuth,
  'no-hybrid-search': hybridSearchDisabled,
  'no-memory-flush': memoryFlushDisabled,
});
