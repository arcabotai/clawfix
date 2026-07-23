import assert from 'node:assert/strict';
import test from 'node:test';

import { createOfflineAnalyzer } from '../cli/core/offline-analyzer.js';

function findingFixture(overrides = {}) {
  return Object.freeze({
    id: 'clawfix:gateway-is-not-running',
    source: 'clawfix',
    severity: 'critical',
    kind: 'failure',
    title: 'Gateway is not running',
    summary: 'The OpenClaw gateway process is not running.',
    evidence: Object.freeze([Object.freeze({ label: 'path', detail: '/tmp/gateway.log' })]),
    repairId: 'gateway-not-running',
    repairable: true,
    ...overrides,
  });
}

function fakeSession({ findings = [], scanResult = null } = {}) {
  const proposeCalls = [];
  const scanCalls = [];
  let currentFindings = findings;
  return {
    proposeCalls,
    scanCalls,
    getState() {
      return Object.freeze({ findings: currentFindings });
    },
    async scan() {
      scanCalls.push(true);
      if (scanResult) currentFindings = scanResult;
      return Object.freeze({ findings: currentFindings, scanError: null });
    },
    proposeRepair(findingId) {
      proposeCalls.push(findingId);
      const finding = currentFindings.find((f) => f.id === findingId);
      if (!finding) return Object.freeze({ status: 'not_found', findingId });
      return Object.freeze({
        status: 'proposed',
        finding,
        plan: Object.freeze({
          planId: 'plan-1', title: `Fix ${finding.title}`, description: 'desc', risk: 'low',
        }),
      });
    },
  };
}

// ============================================================
// Construction
// ============================================================

test('createOfflineAnalyzer requires a session boundary', () => {
  assert.throws(() => createOfflineAnalyzer({}), TypeError);
  assert.throws(() => createOfflineAnalyzer({ session: { getState: () => {} } }), TypeError);
});

// ============================================================
// help / issues / empty / unknown
// ============================================================

test('help is deterministic and lists the fixed command set', async () => {
  const analyzer = createOfflineAnalyzer({ session: fakeSession() });
  const response = await analyzer.handle('help');
  assert.equal(response.intent, 'help');
  assert.match(response.message, /issues/);
  assert.match(response.message, /scan/);
  assert.match(response.message, /explain/);
  assert.match(response.message, /fix/);

  const questionMark = await analyzer.handle('?');
  assert.equal(questionMark.intent, 'help');
});

test('empty input is handled without touching the session', async () => {
  const session = fakeSession();
  const analyzer = createOfflineAnalyzer({ session });
  const response = await analyzer.handle('   ');
  assert.equal(response.intent, 'empty');
  assert.equal(session.scanCalls.length, 0);
  assert.equal(session.proposeCalls.length, 0);
});

test('issues lists current findings with 1-based index and repairability', async () => {
  const finding = findingFixture();
  const analyzer = createOfflineAnalyzer({ session: fakeSession({ findings: [finding] }) });
  const response = await analyzer.handle('issues');
  assert.equal(response.intent, 'issues');
  assert.equal(response.status, 'ok');
  assert.match(response.message, /1\. \[CRITICAL\] Gateway is not running/);
  assert.match(response.message, /auto-fixable/);
});

test('issues reports a healthy system when there are no findings', async () => {
  const analyzer = createOfflineAnalyzer({ session: fakeSession({ findings: [] }) });
  const response = await analyzer.handle('issues');
  assert.match(response.message, /healthy/i);
});

test('unrecognized prose never resolves to a command and never touches the session', async () => {
  const session = fakeSession({ findings: [findingFixture()] });
  const analyzer = createOfflineAnalyzer({ session });
  const response = await analyzer.handle('please fix my gateway, it keeps dying');
  assert.equal(response.intent, 'unknown');
  assert.equal(session.proposeCalls.length, 0);
  assert.equal(session.scanCalls.length, 0);
});

// ============================================================
// rescan
// ============================================================

test('scan/rescan calls session.scan() and reports the refreshed findings', async () => {
  const finding = findingFixture();
  const session = fakeSession({ findings: [], scanResult: [finding] });
  const analyzer = createOfflineAnalyzer({ session });

  const response = await analyzer.handle('rescan');
  assert.equal(response.intent, 'rescan');
  assert.equal(session.scanCalls.length, 1);
  assert.match(response.message, /Gateway is not running/);

  const again = await analyzer.handle('scan');
  assert.equal(session.scanCalls.length, 2);
  assert.equal(again.intent, 'rescan');
});

// ============================================================
// explain <#|id>
// ============================================================

test('explain resolves a finding by 1-based index and includes evidence', async () => {
  const finding = findingFixture();
  const analyzer = createOfflineAnalyzer({ session: fakeSession({ findings: [finding] }) });
  const response = await analyzer.handle('explain 1');
  assert.equal(response.intent, 'explain');
  assert.equal(response.status, 'ok');
  assert.equal(response.finding.id, finding.id);
  assert.match(response.message, /path: \/tmp\/gateway\.log/);
});

test('explain resolves a finding by its stable id', async () => {
  const finding = findingFixture();
  const analyzer = createOfflineAnalyzer({ session: fakeSession({ findings: [finding] }) });
  const response = await analyzer.handle('explain clawfix:gateway-is-not-running');
  assert.equal(response.status, 'ok');
  assert.equal(response.finding.id, finding.id);
});

test('explain reports not_found for an out-of-range index or unknown id', async () => {
  const analyzer = createOfflineAnalyzer({ session: fakeSession({ findings: [] }) });
  const byIndex = await analyzer.handle('explain 3');
  assert.equal(byIndex.status, 'not_found');
  const byId = await analyzer.handle('explain clawfix:nope');
  assert.equal(byId.status, 'not_found');
});

// ============================================================
// fix/repair/propose <#|id> — propose only, never apply
// ============================================================

test('fix <#> proposes a repair for a repairable finding by index and never applies it', async () => {
  const finding = findingFixture();
  const session = fakeSession({ findings: [finding] });
  const analyzer = createOfflineAnalyzer({ session });

  const response = await analyzer.handle('fix 1');
  assert.equal(response.intent, 'propose_repair');
  assert.equal(response.status, 'proposed');
  assert.equal(session.proposeCalls.length, 1);
  assert.equal(session.proposeCalls[0], finding.id);
  assert.match(response.message, /proposal only/i);
  assert.equal(response.plan.planId, 'plan-1');
});

test('fix <id> proposes a repair by stable finding id', async () => {
  const finding = findingFixture();
  const session = fakeSession({ findings: [finding] });
  const analyzer = createOfflineAnalyzer({ session });
  const response = await analyzer.handle('repair clawfix:gateway-is-not-running');
  assert.equal(response.status, 'proposed');
  assert.equal(session.proposeCalls[0], finding.id);
});

test('fix <#> on a non-repairable finding refuses without calling session.proposeRepair', async () => {
  const finding = findingFixture({
    id: 'clawfix:no-soul', repairable: false, repairId: undefined, title: 'No SOUL.md found',
  });
  const session = fakeSession({ findings: [finding] });
  const analyzer = createOfflineAnalyzer({ session });

  const response = await analyzer.handle('fix 1');
  assert.equal(response.status, 'not_repairable');
  assert.equal(session.proposeCalls.length, 0);
});

test('fix <#> for an unknown index reports not_found without calling session.proposeRepair', async () => {
  const session = fakeSession({ findings: [] });
  const analyzer = createOfflineAnalyzer({ session });
  const response = await analyzer.handle('fix 5');
  assert.equal(response.status, 'not_found');
  assert.equal(session.proposeCalls.length, 0);
});

test('multi-word fuzzy phrasing around "fix" never triggers a proposal', async () => {
  const finding = findingFixture();
  const session = fakeSession({ findings: [finding] });
  const analyzer = createOfflineAnalyzer({ session });
  const response = await analyzer.handle('fix it please');
  assert.equal(response.intent, 'unknown');
  assert.equal(session.proposeCalls.length, 0);
});
