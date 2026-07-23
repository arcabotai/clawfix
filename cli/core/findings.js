// ClawFix Task 5: normalize local diagnostic issues, native OpenClaw findings, server findings,
// and future AI repair proposals into one frozen Finding contract with stable, explicit identity.
//
// The rule this module exists to enforce: a repair may only be authorized from an *explicit
// reviewed mapping* keyed by a stable local `knownIssueId` or native `checkId` — never from a
// title/text heuristic, and never from server- or AI-supplied data. Server and AI findings are
// always advisory (`repairable: false`), regardless of any `id`/`title` they carry, because the
// CLI cannot verify how that identity was assigned upstream.

// Local issues are code-owned literal strings emitted by cli/core/diagnostics.js's deriveIssues().
// Matching them by exact equality is recognizing a specific reviewed message template, not fuzzy
// title matching — there is no free-form/user-supplied text on either side of this map.
const LOCAL_ISSUE_TEXT_REPAIR_MAP = new Map([
  ['Gateway is not running', 'gateway-not-running'],
  ['Port conflict detected', 'port-conflict'],
  ['Auto-update causing gateway restart loop', 'auto-update-restart-loop'],
  ['Auto-update enabled (risk of restart loops)', 'auto-update-enabled-warning'],
  ['Mem0 enableGraph requires Pro plan (will silently fail)', 'mem0-graph-free'],
  ['Hybrid search not enabled (recommended)', 'no-hybrid-search'],
  ['No context pruning configured', 'no-context-pruning'],
  ['Memory flush not enabled (data loss on compaction)', 'no-memory-flush'],
  ['No SOUL.md found (agent has no personality)', 'no-soul'],
  ['No memory files found', 'no-memory-files'],
]);

// Explicit knownIssueId -> repairId map. Populate as local detectors and reviewed repairs are
// added together; an unmapped knownIssueId stays advisory-only.
const LOCAL_KNOWN_ISSUE_ID_REPAIR_MAP = new Map([]);

// Explicit native checkId -> repairId map (exact checkId equality only).
const NATIVE_CHECK_ID_REPAIR_MAP = new Map([
  ['runtime/gateway-port-conflict', 'port-conflict'],
]);

function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function resolveLocalRepairId(issue) {
  if (typeof issue.knownIssueId === 'string' && LOCAL_KNOWN_ISSUE_ID_REPAIR_MAP.has(issue.knownIssueId)) {
    return LOCAL_KNOWN_ISSUE_ID_REPAIR_MAP.get(issue.knownIssueId);
  }
  if (typeof issue.nativeCheckId === 'string' && NATIVE_CHECK_ID_REPAIR_MAP.has(issue.nativeCheckId)) {
    return NATIVE_CHECK_ID_REPAIR_MAP.get(issue.nativeCheckId);
  }
  if (typeof issue.text === 'string' && LOCAL_ISSUE_TEXT_REPAIR_MAP.has(issue.text)) {
    return LOCAL_ISSUE_TEXT_REPAIR_MAP.get(issue.text);
  }
  return null;
}

function deriveKind(issue) {
  if (issue.kind) return issue.kind;
  return (issue.severity === 'critical' || issue.severity === 'high') ? 'failure' : 'warning';
}

function buildEvidence(issue) {
  const evidence = [];
  if (typeof issue.path === 'string' && issue.path) evidence.push({ label: 'path', detail: issue.path });
  if (typeof issue.fixHint === 'string' && issue.fixHint) evidence.push({ label: 'fixHint', detail: issue.fixHint });
  if (typeof issue.nativeCheckId === 'string' && issue.nativeCheckId) {
    evidence.push({ label: 'nativeCheckId', detail: issue.nativeCheckId });
  }
  return Object.freeze(evidence.map((entry) => Object.freeze(entry)));
}

function normalizeLocalFinding(issue, knownRepairIds) {
  if (!issue || typeof issue !== 'object') return null;
  const mappedRepairId = resolveLocalRepairId(issue);
  const repairId = mappedRepairId && knownRepairIds.has(mappedRepairId) ? mappedRepairId : undefined;
  const idSeed = issue.knownIssueId || issue.nativeCheckId || issue.text || issue.title;
  return Object.freeze({
    id: `clawfix:${slug(idSeed)}`,
    source: typeof issue.source === 'string' && issue.source ? issue.source : 'clawfix',
    severity: issue.severity || 'medium',
    kind: deriveKind(issue),
    title: issue.title || issue.text || '',
    summary: issue.description || issue.text || issue.title || '',
    evidence: buildEvidence(issue),
    repairId,
    repairable: Boolean(repairId),
  });
}

function normalizeServerFinding(finding) {
  if (!finding || typeof finding !== 'object') return null;
  const idSeed = finding.id || finding.title || finding.text;
  return Object.freeze({
    id: `server:${slug(idSeed)}`,
    source: 'server',
    severity: finding.severity || 'medium',
    kind: deriveKind(finding),
    title: finding.title || finding.text || '',
    summary: finding.description || finding.text || finding.title || '',
    evidence: Object.freeze([]),
    // Server data can never add or replace a repairId, regardless of what it carries — the CLI
    // has no way to verify how the server assigned any `id`/title it sends.
    repairId: undefined,
    repairable: false,
  });
}

function normalizeAiFinding(finding, index) {
  if (!finding || typeof finding !== 'object') return null;
  const idSeed = finding.id || finding.title || finding.text || String(index);
  return Object.freeze({
    id: `ai:${slug(idSeed)}`,
    source: 'ai',
    severity: finding.severity || 'info',
    kind: finding.kind || 'unknown',
    title: finding.title || finding.text || '',
    summary: finding.summary || finding.description || finding.text || finding.title || '',
    evidence: Object.freeze([]),
    // AI findings are always advisory: they never carry a repairId or executable repair.
    repairId: undefined,
    repairable: false,
  });
}

// normalizeFindings() is the single entry point that produces the frozen Finding[] contract from
// every provenance the CLI can see. `knownRepairIds` is the set of repair ids the caller's local
// repair catalog actually implements (e.g. Object.keys(BUILTIN_FIXES)) — a mapped repairId that
// isn't in that set is dropped rather than trusted, so this module can never authorize a repair
// the caller doesn't actually have.
export function normalizeFindings({
  localIssues = [],
  serverFindings = [],
  aiFindings = [],
  knownRepairIds = [],
} = {}) {
  const repairIdSet = knownRepairIds instanceof Set ? knownRepairIds : new Set(knownRepairIds);
  const findings = [];

  for (const issue of Array.isArray(localIssues) ? localIssues : []) {
    const normalized = normalizeLocalFinding(issue, repairIdSet);
    if (normalized) findings.push(normalized);
  }
  for (const finding of Array.isArray(serverFindings) ? serverFindings : []) {
    const normalized = normalizeServerFinding(finding);
    if (normalized) findings.push(normalized);
  }
  (Array.isArray(aiFindings) ? aiFindings : []).forEach((finding, index) => {
    const normalized = normalizeAiFinding(finding, index);
    if (normalized) findings.push(normalized);
  });

  return Object.freeze(findings);
}

function normalizeDisplayText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Display-only deduplication: collapses findings that describe the same thing so the transcript
// doesn't show the same issue twice. This is NEVER used to decide repairability — a finding's
// repairId/repairable flag from normalizeFindings() above is untouched and unrelated to this pass.
export function dedupeFindingsForDisplay(findings) {
  const deduped = [];
  const seenTitles = new Set();
  for (const finding of Array.isArray(findings) ? findings : []) {
    const key = normalizeDisplayText(finding?.title);
    if (key && seenTitles.has(key)) continue;
    if (key) seenTitles.add(key);
    deduped.push(finding);
  }
  return Object.freeze(deduped);
}
