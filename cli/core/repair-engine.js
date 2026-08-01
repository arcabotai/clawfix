// ClawFix Task 6: repair engine — turns a repairable Finding (cli/core/findings.js) into an
// immutable, one-time-use repair plan, and drives that plan through the catalog contract
// (cli/core/repair-catalog.js).
//
// Safety invariants this module enforces:
//   - A plan is frozen at creation and tied to the scan `revision` and a content `fingerprint`
//     derived from the finding that justified it. Applying a plan against a different revision,
//     or against a finding whose evidence has since changed, is rejected as stale — this is what
//     "current diagnostic revision/fingerprint" binding means in practice.
//   - Each plan carries a one-time approval token. Redeeming a plan (successfully or not) consumes
//     it immediately, so a captured/replayed token can never apply twice.
//   - verify() evidence comes from the catalog entry's own runtime check, never from comparing
//     issue titles/text.

import { randomUUID, createHash } from 'node:crypto';

const REFUSED_RISKS = new Set(['high', 'critical']);
const MAX_RETAINED_PLANS = 256;

function defaultRandomToken() {
  return randomUUID();
}

/** Rollback is best-effort cleanup — a throw here must never mask the apply/verify outcome. */
async function safeRollback(entry, ctx, applyResult, preflight) {
  try {
    return await entry.rollback(ctx, { applyResult, preflight });
  } catch (error) {
    return Object.freeze({ rolledBack: false, note: `rollback failed: ${error.message}` });
  }
}

function safeResultText(value, fallback) {
  try {
    const text = String(value)
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
      .trim();
    return text ? text.slice(0, 200) : fallback;
  } catch {
    return fallback;
  }
}

export function applyFailureReason(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return 'adapter returned no structured result';
  }

  const terminalFlags = [
    ['timedOut', 'command timed out'],
    ['aborted', 'command was aborted'],
    ['outputLimitExceeded', 'command output limit was exceeded'],
    ['stdoutTruncated', 'command stdout was truncated'],
    ['stderrTruncated', 'command stderr was truncated'],
    ['partial', 'command reported a partial apply'],
    ['partiallyApplied', 'command reported a partial apply'],
  ];
  for (const [field, message] of terminalFlags) {
    if (Object.hasOwn(result, field) && typeof result[field] !== 'boolean') {
      return `adapter returned invalid ${field} metadata`;
    }
    if (result[field] === true) return message;
  }

  if (result.signal != null) {
    return `command terminated by signal ${safeResultText(result.signal, 'unknown')}`;
  }
  if (result.error != null) {
    return `adapter error: ${safeResultText(result.error?.message || result.error, 'unknown error')}`;
  }
  if (result.errorCode != null) {
    return `adapter error code ${safeResultText(result.errorCode, 'unknown')}`;
  }
  const errorSummary = result.errorSummary == null ? '' : safeResultText(result.errorSummary, '');
  if (errorSummary) {
    return errorSummary;
  }
  if (result.changed === 'unknown') return 'adapter could not determine whether it changed state';
  if (result.status !== 0) return `status ${safeResultText(result.status, 'unknown')}`;
  return null;
}

function stableFingerprintInput(finding, revision) {
  return JSON.stringify({
    revision,
    findingId: finding.id,
    repairId: finding.repairId,
    title: finding.title,
    evidence: finding.evidence,
  });
}

function computeFingerprint(finding, revision) {
  return createHash('sha256').update(stableFingerprintInput(finding, revision)).digest('hex');
}

export function createRepairEngine({ catalog = {}, now = () => Date.now(), randomToken = defaultRandomToken } = {}) {
  if (!catalog || typeof catalog !== 'object') {
    throw new TypeError('catalog must be an object');
  }
  if (typeof now !== 'function' || typeof randomToken !== 'function') {
    throw new TypeError('now and randomToken must be functions');
  }

  const records = new Map(); // planId -> { plan, consumed }

  function createPlan({ finding, revision }) {
    if (!finding || typeof finding !== 'object') {
      throw new TypeError('finding must be an object');
    }
    if (!finding.repairable || typeof finding.repairId !== 'string' || !finding.repairId) {
      throw new Error('finding is not repairable');
    }
    if (typeof revision !== 'string' || revision.length === 0) {
      throw new TypeError('revision must be a non-empty string');
    }
    const entry = catalog[finding.repairId];
    if (!entry) {
      throw new Error(`no catalog entry for repair "${finding.repairId}"`);
    }

    // Consumed plans are dead weight; keep only enough history to keep rejecting replays of
    // recent tokens rather than growing for the life of the process.
    if (records.size > MAX_RETAINED_PLANS) {
      for (const [id, record] of records) {
        if (records.size <= MAX_RETAINED_PLANS) break;
        if (record.consumed) records.delete(id);
      }
    }

    const planId = randomUUID();
    const fingerprint = computeFingerprint(finding, revision);
    const approvalToken = randomToken();
    const plan = Object.freeze({
      planId,
      repairId: finding.repairId,
      findingId: finding.id,
      revision,
      fingerprint,
      title: entry.title,
      description: entry.description,
      risk: entry.risk,
      createdAt: now(),
      approvalToken,
    });
    records.set(planId, { plan, consumed: false });
    return plan;
  }

  function previewPlan(plan, ctx) {
    const entry = catalog[plan.repairId];
    return entry.preview(ctx);
  }

  async function applyPlan({ planId, approvalToken, revision, finding, ctx }) {
    const record = records.get(planId);
    if (!record) {
      return Object.freeze({ status: 'rejected', reason: 'unknown_plan' });
    }
    const { plan } = record;

    if (record.consumed) {
      return Object.freeze({ status: 'rejected', reason: 'token_reused', plan });
    }
    if (approvalToken !== plan.approvalToken) {
      return Object.freeze({ status: 'rejected', reason: 'invalid_token', plan });
    }

    // The token is single-use regardless of outcome from here on — mark it consumed before any
    // further check so a caller can never retry the same plan after a stale/blocked rejection.
    record.consumed = true;

    if (revision !== plan.revision) {
      return Object.freeze({ status: 'rejected', reason: 'stale_plan', plan });
    }
    if (!finding || finding.id !== plan.findingId) {
      return Object.freeze({ status: 'rejected', reason: 'stale_plan', plan });
    }
    const currentFingerprint = computeFingerprint(finding, revision);
    if (currentFingerprint !== plan.fingerprint) {
      return Object.freeze({ status: 'rejected', reason: 'stale_plan', plan });
    }

    const entry = catalog[plan.repairId];

    // High/critical repairs are never executed automatically. This belongs here rather than in
    // any one UI: the engine is the only layer every caller has to go through.
    if (REFUSED_RISKS.has(String(entry.risk ?? plan.risk).toLowerCase())) {
      return Object.freeze({ status: 'blocked', reason: 'risk_refused', plan });
    }

    let preflight;
    try {
      preflight = await entry.preflight(ctx);
    } catch (error) {
      return Object.freeze({ status: 'error', error: `preflight failed: ${error.message}`, plan });
    }
    if (!preflight.ok) {
      return Object.freeze({ status: 'blocked', reason: preflight.reason, plan, preflight });
    }

    let preview = null;
    try {
      preview = await entry.preview(ctx);
    } catch (error) {
      return Object.freeze({ status: 'error', error: `preview failed: ${error.message}`, plan });
    }

    let applyResult;
    try {
      applyResult = await entry.apply(ctx);
    } catch (error) {
      applyResult = Object.freeze({
        status: null,
        changed: 'unknown',
        changes: Object.freeze([]),
        errorSummary: error.message,
      });
      const rollback = await safeRollback(entry, ctx, applyResult, preflight);
      return Object.freeze({
        status: 'error',
        error: `apply failed: ${error.message}`,
        plan,
        preview,
        applyResult,
        rollback,
      });
    }

    const applyFailure = applyFailureReason(applyResult);
    if (applyFailure) {
      // A failed/ambiguous process result may still have changed state. Roll back every returned
      // failure rather than trusting an optional `changed` flag supplied by the failing adapter.
      const rollback = await safeRollback(entry, ctx, applyResult, preflight);
      return Object.freeze({
        status: 'error',
        error: `apply failed: ${applyFailure}`,
        plan,
        preview,
        applyResult,
        rollback,
      });
    }

    // Past this point the repair has run. Every remaining failure must still be reported as a
    // structured outcome that carries applyResult — throwing here would lose the one fact the
    // caller most needs, which is that the system was already changed.
    let verify;
    try {
      verify = await entry.verify(ctx);
    } catch (error) {
      const rollback = await safeRollback(entry, ctx, applyResult, preflight);
      return Object.freeze({
        status: 'verify_failed',
        plan,
        preview,
        applyResult,
        verify: Object.freeze({ ok: false, error: error.message }),
        rollback,
      });
    }

    if (!verify.ok) {
      const rollback = await safeRollback(entry, ctx, applyResult, preflight);
      return Object.freeze({ status: 'verify_failed', plan, preview, applyResult, verify, rollback });
    }

    return Object.freeze({ status: 'applied', plan, preview, applyResult, verify });
  }

  return Object.freeze({ createPlan, previewPlan, applyPlan });
}
