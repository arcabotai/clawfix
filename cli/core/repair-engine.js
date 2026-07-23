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

function defaultRandomToken() {
  return randomUUID();
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

    const preflight = await entry.preflight(ctx);
    if (!preflight.ok) {
      return Object.freeze({ status: 'blocked', reason: preflight.reason, plan, preflight });
    }

    const preview = await entry.preview(ctx);

    let applyResult;
    try {
      applyResult = await entry.apply(ctx);
    } catch (error) {
      return Object.freeze({ status: 'error', error: error.message, plan, preview });
    }

    const verify = await entry.verify(ctx);
    if (!verify.ok) {
      const rollback = await entry.rollback(ctx, { applyResult });
      return Object.freeze({ status: 'verify_failed', plan, preview, applyResult, verify, rollback });
    }

    return Object.freeze({ status: 'applied', plan, preview, applyResult, verify });
  }

  return Object.freeze({ createPlan, previewPlan, applyPlan });
}
