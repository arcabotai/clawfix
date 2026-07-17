export function assertCommandResult(name, result, { allowedExitCodes = [0] } = {}) {
  if (!result || typeof result !== 'object') {
    throw new Error(`${name} returned no command result`);
  }
  if (result.timedOut === true || result.timeout === true || result.error?.name === 'TimeoutError') {
    throw new Error(`${name} timed out`);
  }
  if (!Number.isInteger(result.exitCode)) {
    throw new Error(`${name} is missing a numeric exit code`);
  }
  if (!allowedExitCodes.includes(result.exitCode)) {
    throw new Error(`${name} failed with exit code ${result.exitCode}`);
  }
  return result;
}

export function parseJsonOutput(name, value) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${name} returned empty JSON output`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} returned invalid JSON: ${error.message}`);
  }
}

export function assertScenarioEvidence(
  scenario,
  result,
  { expectedIssueIds, evidence },
) {
  if (!result || !Array.isArray(result.issues)) {
    throw new Error(`${scenario} did not return a structured issues array`);
  }
  const foundIds = new Set(result.issues.flatMap(issue => (
    [issue.id, issue.nativeCheckId].filter(Boolean)
  )));
  const missing = expectedIssueIds.filter(id => !foundIds.has(id));
  if (missing.length > 0) {
    throw new Error(`${scenario} did not detect expected issue ID(s): ${missing.join(', ')}`);
  }
  if (typeof evidence !== 'function' || evidence(result) !== true) {
    throw new Error(`${scenario} did not contain expected evidence`);
  }
  return expectedIssueIds;
}
