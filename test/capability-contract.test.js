import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { repairCatalog } from '../cli/core/repair-catalog.js';
import {
  buildCapabilityContract,
  renderCapabilityMarkdown,
  serializeCapabilityContract,
} from '../scripts/generate-capability-contract.mjs';
import { KNOWN_ISSUES } from '../src/known-issues.js';

test('capability contract derives release, detector, and repair truth from shipped source', async () => {
  const contract = await buildCapabilityContract();
  const expectedRepairs = Object.keys(repairCatalog).sort();

  assert.equal(contract.release.version, '0.12.0');
  assert.equal(contract.release.state, 'published');
  assert.equal(contract.release.publishedAt, '2026-08-02T05:24:40Z');
  assert.equal(contract.release.nodeEngine, '>=22.0.0');
  assert.equal(contract.detectors.deterministicCount, KNOWN_ISSUES.length);
  assert.deepEqual(
    contract.detectors.ids,
    KNOWN_ISSUES.map(issue => issue.id).sort(),
  );
  assert.equal(contract.executableRepairs.count, expectedRepairs.length);
  assert.deepEqual(
    contract.executableRepairs.items.map(repair => repair.id),
    expectedRepairs,
  );
});

test('capability contract states the delivered interfaces and AI boundary without overclaiming', async () => {
  const contract = await buildCapabilityContract();

  assert.equal(contract.interfaces.npx.run, 'npx clawfix@0.12.0');
  assert.match(contract.interfaces.npx.delivers, /plain readline/i);
  assert.equal(contract.interfaces.standaloneTui.bundledWithNpm, false);
  assert.deepEqual(contract.interfaces.standaloneTui.assets, [
    'clawfix-tui-linux-x64-baseline.tar.gz',
    'clawfix-tui-linux-x64.tar.gz',
    'clawfix-tui-linux-x64-musl.tar.gz',
  ]);
  assert.equal(contract.aiBoundary.modelOutputCanBecomeExecutableShell, false);
  assert.equal(contract.aiBoundary.novelAiFindingsAutomaticallyRepairable, false);
  assert.deepEqual(contract.compatibility.supportedOpenClawVersions, []);
});

test('measured outcomes preserve unknowns and never manufacture a success rate', async () => {
  const contract = await buildCapabilityContract();

  assert.equal(contract.measuredOutcomes.totalDiagnoses, 207);
  assert.equal(contract.measuredOutcomes.recordedSuccesses, 5);
  assert.equal(contract.measuredOutcomes.unknown, 202);
  assert.match(contract.measuredOutcomes.interpretation, /not failures/i);
  assert.equal('successRate' in contract.measuredOutcomes, false);
});

test('checked-in capability artifacts exactly match the generator', async () => {
  const contract = await buildCapabilityContract();
  const [json, markdown] = await Promise.all([
    readFile(
      new URL(`../docs/capabilities/v${contract.release.version}.json`, import.meta.url),
      'utf8',
    ),
    readFile(
      new URL(`../docs/capabilities/v${contract.release.version}.md`, import.meta.url),
      'utf8',
    ),
  ]);

  assert.equal(json, serializeCapabilityContract(contract));
  assert.equal(markdown, renderCapabilityMarkdown(contract));
});

test('root README links to the generated current-version capability contract', async () => {
  const contract = await buildCapabilityContract();
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const expectedLink = [
    '[Versioned capability contract]',
    `(docs/capabilities/v${contract.release.version}.md)`,
  ].join('');

  assert.ok(readme.includes(expectedLink), `README must link to ${expectedLink}`);
});
