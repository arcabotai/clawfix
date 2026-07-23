const SESSION_ROLES = new Set(['user', 'assistant', 'system']);

function asError(value) {
  const message = value instanceof Error ? value.message : String(value || 'Unknown scan error');
  return Object.freeze({ message });
}

function freezeList(value) {
  return Object.freeze([...(value || [])]);
}

export function isSessionEvent(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && Object.isFrozen(value)
    && typeof value.type === 'string'
    && value.type.startsWith('session.'),
  );
}

export function createSessionController({
  runDiagnostics,
  repairEngine,
  normalizeFindings,
  knownRepairIds = [],
  makeRevisionId,
  onEvent = () => {},
  remoteAnalyzer,
} = {}) {
  if (typeof runDiagnostics !== 'function') throw new TypeError('runDiagnostics must be a function');
  if (!repairEngine || typeof repairEngine.createPlan !== 'function' || typeof repairEngine.applyPlan !== 'function') {
    throw new TypeError('repairEngine must provide createPlan and applyPlan');
  }
  if (typeof normalizeFindings !== 'function') throw new TypeError('normalizeFindings must be a function');
  if (typeof makeRevisionId !== 'function') throw new TypeError('makeRevisionId must be a function');
  if (!Array.isArray(knownRepairIds)) throw new TypeError('knownRepairIds must be an array');
  if (typeof onEvent !== 'function') throw new TypeError('onEvent must be a function');
  if (remoteAnalyzer !== undefined && (!remoteAnalyzer || typeof remoteAnalyzer.analyze !== 'function')) {
    throw new TypeError('remoteAnalyzer must provide analyze when present');
  }

  let revision = null;
  let diagnostic = null;
  let issues = freezeList();
  let findings = freezeList();
  let summary = null;
  let scanning = false;
  let scanError = null;
  let transcript = freezeList();
  let activeScan = null;

  function getState() {
    return Object.freeze({
      revision,
      diagnostic,
      issues,
      findings,
      summary,
      scanning,
      scanError,
      transcript,
    });
  }

  function emitSession(type, fields = {}) {
    const event = Object.freeze({ type, ...fields });
    onEvent(event);
    return event;
  }

  function cancelActive(reason = 'cancelled') {
    if (!activeScan) return false;
    const cancelled = activeScan;
    activeScan = null;
    cancelled.controller.abort();
    scanning = false;
    emitSession('session.scan.cancelled', { revision: cancelled.revision, reason });
    return true;
  }

  async function scan() {
    cancelActive('superseded');

    const nextRevision = makeRevisionId();
    if (typeof nextRevision !== 'string' || nextRevision.length === 0) {
      throw new TypeError('makeRevisionId must return a non-empty string');
    }

    const token = {
      revision: nextRevision,
      controller: new AbortController(),
      staleReported: false,
    };
    activeScan = token;
    scanning = true;
    scanError = null;
    emitSession('session.scan.queued', { revision: nextRevision });

    const reportStale = (reason) => {
      if (token.staleReported) return;
      token.staleReported = true;
      emitSession('session.scan.stale', { revision: nextRevision, reason });
    };

    try {
      const result = await runDiagnostics({
        revision: nextRevision,
        signal: token.controller.signal,
        emit(event) {
          if (activeScan !== token) return;
          if (!event || event.revision !== nextRevision) return;
          onEvent(event);
        },
      });

      if (activeScan !== token) {
        reportStale('result');
        return getState();
      }

      revision = nextRevision;
      scanning = false;
      activeScan = null;

      if (result?.error) {
        diagnostic = null;
        issues = freezeList();
        findings = freezeList();
        summary = null;
        scanError = asError(result.error);
      } else {
        diagnostic = result?.diagnostic ?? null;
        issues = freezeList(result?.issues);
        findings = freezeList(normalizeFindings({
          localIssues: issues,
          nativeChecks: result?.nativeChecks,
          serverFindings: result?.serverFindings,
          aiFindings: result?.aiFindings,
          knownRepairIds,
        }));
        summary = result?.summary ?? null;
        scanError = null;
      }

      emitSession('session.scan.committed', {
        revision,
        findingsCount: findings.length,
        error: scanError,
      });
      return getState();
    } catch (error) {
      if (activeScan !== token) {
        reportStale('error');
        return getState();
      }
      activeScan = null;
      revision = nextRevision;
      scanning = false;
      scanError = asError(error);
      emitSession('session.scan.committed', {
        revision,
        findingsCount: findings.length,
        error: scanError,
      });
      throw error;
    }
  }

  function cancelScan() {
    return cancelActive('cancelled');
  }

  function appendMessage(role, text) {
    if (!SESSION_ROLES.has(role)) throw new TypeError('role must be user, assistant, or system');
    if (typeof text !== 'string' || text.trim().length === 0) throw new TypeError('text must be non-empty');
    const message = Object.freeze({ type: 'session.message', role, text, at: Date.now() });
    transcript = freezeList([...transcript, message]);
    onEvent(message);
    return message;
  }

  function proposeRepair(findingId) {
    if (revision === null) return Object.freeze({ status: 'no_active_revision', findingId });
    const finding = findings.find((candidate) => candidate.id === findingId);
    if (!finding) return Object.freeze({ status: 'not_found', findingId });
    if (!finding.repairable) return Object.freeze({ status: 'not_repairable', findingId, finding });

    const plan = repairEngine.createPlan({ finding, revision });
    emitSession('session.repair.proposed', {
      revision,
      findingId: finding.id,
      repairId: finding.repairId,
      planId: plan.planId,
    });
    return Object.freeze({ status: 'proposed', finding, plan });
  }

  async function applyRepair({ planId, approvalToken, findingId, ctx } = {}) {
    const finding = findings.find((candidate) => candidate.id === findingId);
    if (!finding) return Object.freeze({ status: 'rejected', reason: 'finding_not_found' });
    const outcome = await repairEngine.applyPlan({
      planId,
      approvalToken,
      revision,
      finding,
      ctx,
    });
    emitSession('session.repair.result', {
      revision,
      findingId,
      planId,
      status: outcome.status,
      reason: outcome.reason,
    });
    return outcome;
  }

  return Object.freeze({
    getState,
    scan,
    cancelScan,
    appendMessage,
    proposeRepair,
    applyRepair,
  });
}
