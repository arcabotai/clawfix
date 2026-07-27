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
    return Object.freeze({
      status: result.status,
      timedOut: result.timedOut,
      errorSummary: result.errorSummary,
      stdout: result.stdout,
    });
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
      const current = await ctx.openclaw.configGet(key, { timeoutMs: 10_000 });
      const flag = configFlag(current);
      if (flag === null) {
        return Object.freeze({ ok: false, reason: 'config_state_unknown', evidence: { key, current } });
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
      return Object.freeze({
        status: result.status,
        timedOut: result.timedOut,
        errorSummary: result.errorSummary,
      });
    },

    async verify(ctx) {
      const current = await ctx.openclaw.configGet(key, { timeoutMs: 10_000 });
      return Object.freeze({ ok: configFlag(current) === target, evidence: { key, current } });
    },

    async rollback(ctx) {
      const result = await ctx.openclaw.configSet(key, previousText, { timeoutMs: 30_000 });
      return Object.freeze({
        rolledBack: result.status === 0,
        note: result.status === 0
          ? `Restored ${key} to ${previousText}.`
          : `Could not restore ${key}; check \`openclaw config get ${key}\`.`,
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
    'The gateway accepts unauthenticated connections. This switches auth to token mode and has '
    + 'OpenClaw generate one. Clients will need that token to connect afterwards.',
  // Medium, not low: existing clients stop working until they carry the new token.
  risk: 'medium',

  async preflight(ctx) {
    const mode = await ctx.openclaw.configGet('gateway.auth.mode', { timeoutMs: 10_000 });
    const current = String(mode || '').trim().toLowerCase();
    if (current === 'token' || current === 'password' || current === 'trusted-proxy') {
      return Object.freeze({ ok: false, reason: 'gateway_auth_already_enabled', evidence: { mode: current } });
    }
    return Object.freeze({ ok: true, evidence: { mode: current || '(unset)' } });
  },

  async preview() {
    return Object.freeze({
      steps: Object.freeze([
        'Set gateway.auth.mode to token through the OpenClaw CLI (argv, no shell).',
        'Run `openclaw doctor --fix --generate-gateway-token` so OpenClaw generates the token.',
        'Read gateway.auth.mode back to confirm token auth is active.',
        'Restart the gateway yourself for it to take effect; existing clients need the new token.',
      ]),
      summary: 'openclaw config set gateway.auth.mode token + doctor --generate-gateway-token',
    });
  },

  async apply(ctx) {
    const previousModeRaw = await ctx.openclaw.configGet('gateway.auth.mode', { timeoutMs: 10_000 });
    const previousMode = String(previousModeRaw || '').trim() || 'none';
    const set = await ctx.openclaw.configSet('gateway.auth.mode', 'token', { timeoutMs: 30_000 });
    if (set.status !== 0) {
      return Object.freeze({ status: set.status, stage: 'set-mode', errorSummary: set.errorSummary });
    }
    const generated = await ctx.openclaw.invoke(
      ['doctor', '--fix', '--generate-gateway-token'],
      { timeoutMs: 120_000 },
    );
    let restoredMode = null;
    if (generated.status !== 0 || generated.timedOut) {
      const restored = await ctx.openclaw.configSet(
        'gateway.auth.mode',
        previousMode,
        { timeoutMs: 30_000 },
      );
      restoredMode = Object.freeze({
        attempted: true,
        status: restored.status,
        mode: previousMode,
      });
    }
    return Object.freeze({
      status: generated.status,
      stage: 'generate-token',
      timedOut: generated.timedOut,
      errorSummary: generated.errorSummary,
      restoredMode,
    });
  },

  async verify(ctx) {
    // Evidence is the mode only — never read the token itself into a repair record.
    const mode = String(await ctx.openclaw.configGet('gateway.auth.mode', { timeoutMs: 10_000 })).trim();
    return Object.freeze({ ok: mode.toLowerCase() === 'token', evidence: { mode } });
  },

  async rollback(ctx, { applyResult } = {}) {
    if (applyResult?.stage === 'set-mode') {
      return Object.freeze({ rolledBack: false, note: 'Auth mode was never changed.' });
    }
    return Object.freeze({
      rolledBack: false,
      note: 'Gateway auth was switched to token mode. To undo it deliberately, run '
        + '`openclaw config set gateway.auth.mode none` — that returns the gateway to accepting '
        + 'unauthenticated connections.',
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
