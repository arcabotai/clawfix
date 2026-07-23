function response(fields) {
  return Object.freeze(fields);
}

function currentFindings(session) {
  const state = session.getState();
  return Array.isArray(state?.findings) ? state.findings : [];
}

function resolveFinding(findings, selector) {
  if (/^[1-9]\d*$/.test(selector)) return findings[Number(selector) - 1] || null;
  return findings.find((finding) => finding.id === selector) || null;
}

function formatIssues(findings) {
  if (findings.length === 0) return 'No issues found. The system looks healthy.';
  return findings.map((finding, index) => {
    const repair = finding.repairable ? ' — auto-fixable' : '';
    return `${index + 1}. [${String(finding.severity || 'unknown').toUpperCase()}] ${finding.title}${repair}`;
  }).join('\n');
}

function formatExplanation(finding) {
  const lines = [finding.title];
  if (finding.summary) lines.push(finding.summary);
  if (Array.isArray(finding.evidence)) {
    for (const item of finding.evidence) {
      if (item && typeof item === 'object') {
        lines.push(`${item.label || 'evidence'}: ${item.detail || ''}`);
      } else if (item !== undefined && item !== null) {
        lines.push(`evidence: ${String(item)}`);
      }
    }
  }
  return lines.join('\n');
}

export function createOfflineAnalyzer({ session } = {}) {
  if (!session
    || typeof session.getState !== 'function'
    || typeof session.scan !== 'function'
    || typeof session.proposeRepair !== 'function') {
    throw new TypeError('session must provide getState, scan, and proposeRepair');
  }

  async function handle(input) {
    if (typeof input !== 'string') throw new TypeError('input must be a string');
    const command = input.trim();
    if (command.length === 0) return response({ intent: 'empty', status: 'ok', message: '' });

    if (command === 'help' || command === '?') {
      return response({
        intent: 'help',
        status: 'ok',
        message: 'Commands: issues, scan/rescan, explain <#|id>, fix <#|id>, help.',
      });
    }

    if (command === 'issues') {
      return response({ intent: 'issues', status: 'ok', message: formatIssues(currentFindings(session)) });
    }

    if (command === 'scan' || command === 'rescan') {
      const state = await session.scan();
      const refreshed = Array.isArray(state?.findings) ? state.findings : [];
      return response({ intent: 'rescan', status: state?.scanError ? 'error' : 'ok', message: formatIssues(refreshed) });
    }

    const explainMatch = /^explain\s+(\S+)$/.exec(command);
    if (explainMatch) {
      const finding = resolveFinding(currentFindings(session), explainMatch[1]);
      if (!finding) return response({ intent: 'explain', status: 'not_found', message: 'Finding not found.' });
      return response({
        intent: 'explain',
        status: 'ok',
        finding,
        message: formatExplanation(finding),
      });
    }

    const repairMatch = /^(?:fix|repair|propose)\s+(\S+)$/.exec(command);
    if (repairMatch) {
      const finding = resolveFinding(currentFindings(session), repairMatch[1]);
      if (!finding) return response({ intent: 'propose_repair', status: 'not_found', message: 'Finding not found.' });
      if (!finding.repairable) {
        return response({
          intent: 'propose_repair',
          status: 'not_repairable',
          finding,
          message: 'This finding has no reviewed automatic repair.',
        });
      }
      const proposal = session.proposeRepair(finding.id);
      return response({
        intent: 'propose_repair',
        status: proposal.status,
        finding,
        plan: proposal.plan,
        message: proposal.status === 'proposed'
          ? `Repair prepared for ${finding.title}. This is a proposal only; approval is still required.`
          : `Could not prepare repair: ${proposal.status}.`,
      });
    }

    return response({
      intent: 'unknown',
      status: 'unknown',
      message: 'Unknown local command. Type help for the deterministic command list.',
    });
  }

  return Object.freeze({ handle });
}
