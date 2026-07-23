import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { normalizeFindings, dedupeFindingsForDisplay } from '../cli/core/findings.js';

test('a recognized local issue acquires a repairId when the repair actually exists', () => {
  const [finding] = normalizeFindings({
    localIssues: [{ severity: 'high', text: 'Gateway is not running' }],
    knownRepairIds: ['gateway-not-running'],
  });
  assert.equal(finding.repairId, 'gateway-not-running');
  assert.equal(finding.repairable, true);
});

test('a mapped local repairId is dropped when the caller has no such repair in its catalog', () => {
  const [finding] = normalizeFindings({
    localIssues: [{ severity: 'high', text: 'Gateway is not running' }],
    knownRepairIds: [],
  });
  assert.equal(finding.repairId, undefined);
  assert.equal(finding.repairable, false);
});

test('an unrecognized/fuzzy local issue title never acquires a repairId', () => {
  const [finding] = normalizeFindings({
    localIssues: [{ severity: 'medium', text: 'Something vaguely wrong with the widget' }],
    knownRepairIds: ['gateway-not-running', 'port-conflict'],
  });
  assert.equal(finding.repairId, undefined);
  assert.equal(finding.repairable, false);
});

test('a similar-but-not-identical local title is not fuzzily matched to a real issue', () => {
  const [finding] = normalizeFindings({
    localIssues: [{ severity: 'critical', text: 'Gateway is not running right now, apparently' }],
    knownRepairIds: ['gateway-not-running'],
  });
  assert.equal(finding.repairId, undefined);
  assert.equal(finding.repairable, false);
});

test('an explicit native checkId maps to its reviewed repair', () => {
  const [finding] = normalizeFindings({
    localIssues: [{
      severity: 'critical',
      text: 'Gateway port 18789 is occupied by node (PID 123), but OpenClaw cannot reach it',
      source: 'clawfix-port-probe',
      nativeCheckId: 'runtime/gateway-port-conflict',
    }],
    knownRepairIds: ['port-conflict'],
  });
  assert.equal(finding.repairId, 'port-conflict');
  assert.equal(finding.repairable, true);
  assert.equal(finding.source, 'clawfix-port-probe');
});

test('an unmapped native checkId stays advisory', () => {
  const [finding] = normalizeFindings({
    localIssues: [{
      severity: 'high',
      text: 'OpenClaw config schema validation failed',
      source: 'openclaw-config',
      nativeCheckId: 'config/schema-invalid',
    }],
    knownRepairIds: ['gateway-not-running', 'port-conflict'],
  });
  assert.equal(finding.repairId, undefined);
  assert.equal(finding.repairable, false);
});

test('server findings are always advisory, even when they carry an id/title matching a real repair', () => {
  const [finding] = normalizeFindings({
    serverFindings: [{
      id: 'gateway-not-running',
      title: 'Gateway is not running',
      severity: 'critical',
    }],
    knownRepairIds: ['gateway-not-running'],
  });
  assert.equal(finding.source, 'server');
  assert.equal(finding.repairId, undefined);
  assert.equal(finding.repairable, false);
});

test('AI findings are always advisory regardless of content', () => {
  const [finding] = normalizeFindings({
    aiFindings: [{
      id: 'gateway-not-running',
      title: 'Gateway is not running',
      severity: 'critical',
    }],
    knownRepairIds: ['gateway-not-running'],
  });
  assert.equal(finding.source, 'ai');
  assert.equal(finding.repairId, undefined);
  assert.equal(finding.repairable, false);
});

test('findings are frozen plain objects, including nested evidence', () => {
  const [finding] = normalizeFindings({
    localIssues: [{ severity: 'high', text: 'Gateway is not running', path: '/tmp/x' }],
    knownRepairIds: ['gateway-not-running'],
  });
  assert.ok(Object.isFrozen(finding));
  assert.ok(Object.isFrozen(finding.evidence));
  if (finding.evidence.length) assert.ok(Object.isFrozen(finding.evidence[0]));
});

test('finding ids are stable and deterministic across calls, and distinct issues get distinct ids', () => {
  const input = {
    localIssues: [
      { severity: 'high', text: 'Gateway is not running' },
      { severity: 'medium', text: 'Port conflict detected' },
    ],
    knownRepairIds: ['gateway-not-running', 'port-conflict'],
  };
  const first = normalizeFindings(input);
  const second = normalizeFindings(input);
  assert.equal(first[0].id, second[0].id);
  assert.notEqual(first[0].id, first[1].id);
});

test('the returned findings collection itself is frozen', () => {
  const findings = normalizeFindings({ localIssues: [{ severity: 'low', text: 'No memory files found' }] });
  assert.ok(Object.isFrozen(findings));
});

test('dedupeFindingsForDisplay collapses same-title findings for display without touching repairability', () => {
  const findings = normalizeFindings({
    localIssues: [{ severity: 'critical', text: 'Gateway is not running' }],
    serverFindings: [{ id: 'gateway-not-running', title: 'Gateway is not running', severity: 'critical' }],
    knownRepairIds: ['gateway-not-running'],
  });
  const deduped = dedupeFindingsForDisplay(findings);
  assert.equal(deduped.length, 1);
  // The surviving finding is the local one (first in insertion order) and keeps its real repairId;
  // display dedup must never grant the dropped server entry's identity to the survivor either way.
  assert.equal(deduped[0].source, 'clawfix');
  assert.equal(deduped[0].repairId, 'gateway-not-running');
});

test('dedupeFindingsForDisplay never merges distinct titles even when one contains the other', () => {
  const findings = normalizeFindings({
    localIssues: [
      { severity: 'critical', text: 'Gateway is not running' },
      { severity: 'medium', text: 'Gateway is not running as expected in staging' },
    ],
  });
  const deduped = dedupeFindingsForDisplay(findings);
  assert.equal(deduped.length, 2);
});

test('the real CLI authorizes repairs only through normalized repairId identity', async () => {
  const source = await readFile(new URL('../cli/bin/clawfix.js', import.meta.url), 'utf8');
  assert.match(source, /dedupeFindingsForDisplay\(normalizeFindings\(\{/);
  assert.match(source, /BUILTIN_FIXES\[issue\.repairId\]/);
  assert.match(source, /candidate\.id === issue\.id/);
  assert.doesNotMatch(source, /slice\(0, 20\)/);
});
