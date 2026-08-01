#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { repairCatalog } from '../cli/core/repair-catalog.js';
import { KNOWN_ISSUES } from '../src/known-issues.js';

const ROOT = new URL('../', import.meta.url);
const OUTPUT_DIR = new URL('docs/capabilities/', ROOT);

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, ROOT), 'utf8'));
}

function assertUnique(label, values) {
  const unique = new Set(values);
  if (unique.size !== values.length) {
    throw new Error(`${label} contains duplicate ids`);
  }
}

export async function buildCapabilityContract() {
  const [rootPackage, cliPackage, evidence] = await Promise.all([
    readJson('package.json'),
    readJson('cli/package.json'),
    readJson('docs/capabilities/evidence.json'),
  ]);

  if (rootPackage.version !== cliPackage.version) {
    throw new Error(
      `root version ${rootPackage.version} does not match CLI version ${cliPackage.version}`,
    );
  }
  if (evidence.release.tag !== `v${cliPackage.version}`) {
    throw new Error(
      `evidence tag ${evidence.release.tag} does not match CLI version ${cliPackage.version}`,
    );
  }
  if (evidence.outcomes.recordedSuccesses + evidence.outcomes.unknown
      !== evidence.outcomes.totalDiagnoses) {
    throw new Error('outcome counts do not add up to totalDiagnoses');
  }

  const detectorIds = KNOWN_ISSUES.map(issue => issue.id).sort();
  const repairs = Object.values(repairCatalog)
    .map(entry => ({
      id: entry.id,
      title: entry.title,
      risk: entry.risk,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  assertUnique('detector catalog', detectorIds);
  assertUnique('repair catalog', repairs.map(repair => repair.id));

  const version = cliPackage.version;
  return {
    schemaVersion: 1,
    generatedFrom: {
      packageMetadata: ['package.json', 'cli/package.json'],
      detectorCatalog: 'src/known-issues.js',
      repairCatalog: 'cli/core/repair-catalog.js',
      evidenceSnapshot: 'docs/capabilities/evidence.json',
    },
    evidenceAsOf: evidence.asOf,
    release: {
      version,
      tag: evidence.release.tag,
      state: evidence.release.state || 'published',
      publishedAt: evidence.release.publishedAt,
      package: cliPackage.name,
      nodeEngine: cliPackage.engines.node,
      releaseMetadataSource: evidence.release.source,
      releaseAssets: evidence.release.assets,
    },
    interfaces: {
      installer: {
        preparation: [
          'Download https://clawfix.dev/install to install-clawfix.sh.',
          'Inspect the script and compare its SHA-256 with https://clawfix.dev/install/sha256.',
          'Run bash install-clawfix.sh.',
        ],
        run: 'clawfix',
        delivers: 'Portable plain readline CLI installed under ~/.clawfix with a ~/.local/bin/clawfix launcher.',
        platforms: evidence.platforms.portableCli,
      },
      npx: {
        run: `npx ${cliPackage.name}@${version}`,
        delivers: 'Portable plain readline CLI.',
        platforms: evidence.platforms.portableCli,
      },
      standaloneTui: {
        bundledWithNpm: false,
        delivers: 'Separate chat-first OpenTUI release asset.',
        platforms: evidence.platforms.standaloneTui,
        assets: evidence.release.assets.filter(asset => asset.endsWith('.tar.gz')),
      },
    },
    detectors: {
      deterministicCount: detectorIds.length,
      ids: detectorIds,
    },
    executableRepairs: {
      count: repairs.length,
      items: repairs,
      safetyBoundary: 'Repairs are deterministic catalog entries with preview, apply, verify, and rollback contracts.',
    },
    aiBoundary: {
      optional: true,
      serverControlled: true,
      purpose: 'Explain unmatched diagnostic evidence and provide advisory analysis.',
      modelOutputCanBecomeExecutableShell: false,
      novelAiFindingsAutomaticallyRepairable: false,
    },
    compatibility: evidence.validation,
    measuredOutcomes: evidence.outcomes,
    claimBoundary: 'ClawFix diagnoses OpenClaw in one command and can apply only the supported repairs listed in this contract.',
  };
}

export function serializeCapabilityContract(contract) {
  return `${JSON.stringify(contract, null, 2)}\n`;
}

function markdownList(values) {
  return values.map(value => `- ${value}`).join('\n');
}

export function renderCapabilityMarkdown(contract) {
  const repairRows = contract.executableRepairs.items
    .map(repair => `| \`${repair.id}\` | ${repair.title} | ${repair.risk} |`)
    .join('\n');
  const testedVersions = contract.compatibility.testedOpenClawVersions
    .map(item => `- OpenClaw ${item.version}: ${item.scope} ([source](../../${item.source}))`)
    .join('\n');
  const releaseLabel = contract.release.state === 'published' ? 'release' : 'release candidate';
  const assetVerb = contract.release.state === 'published'
    ? 'publishes these separate assets'
    : 'is expected to publish these separate assets';

  return `# ClawFix ${contract.release.version} ${releaseLabel} capability contract

Evidence snapshot: **${contract.evidenceAsOf}**. This file is generated; edit \`evidence.json\` or shipped source, then run \`npm run capabilities:generate\`.

## Product boundary

${contract.claimBoundary}

- Deterministic detectors: **${contract.detectors.deterministicCount}**
- Executable reviewed repairs: **${contract.executableRepairs.count}**
- Node.js: \`${contract.release.nodeEngine}\`

## Interfaces delivered

### Installer

${markdownList(contract.interfaces.installer.preparation)}

Run \`${contract.interfaces.installer.run}\`. It delivers: ${contract.interfaces.installer.delivers}

### npm

Run \`${contract.interfaces.npx.run}\`. It delivers: ${contract.interfaces.npx.delivers}

### Standalone TUI

The TUI is **not bundled with npm**. ClawFix ${contract.release.version} ${assetVerb}:

${markdownList(contract.interfaces.standaloneTui.assets.map(asset => `\`${asset}\``))}

Portable CLI platforms documented for this release: ${contract.interfaces.npx.platforms.join(', ')}.
Standalone TUI platforms evidenced by the release assets: ${contract.interfaces.standaloneTui.platforms.join(', ')}.

## Executable repair catalog

| ID | Action | Risk |
|---|---|---|
${repairRows}

${contract.executableRepairs.safetyBoundary}

## AI boundary

AI analysis is optional and controlled by the selected server. It may explain unmatched evidence, but model output never becomes executable shell and a novel AI finding is not automatically repairable.

## OpenClaw compatibility evidence

${contract.compatibility.supportStatement}

${testedVersions || '- No real-machine OpenClaw version evidence is recorded.'}

## Measured outcomes

The [public stats snapshot](${contract.measuredOutcomes.source}) recorded:

- Total diagnoses: **${contract.measuredOutcomes.totalDiagnoses}**
- Recorded successes: **${contract.measuredOutcomes.recordedSuccesses}**
- Unknown outcomes: **${contract.measuredOutcomes.unknown}**

${contract.measuredOutcomes.interpretation}

## Sources

- Release metadata: ${contract.release.releaseMetadataSource}
- Detector catalog: [\`src/known-issues.js\`](../../src/known-issues.js)
- Repair catalog: [\`cli/core/repair-catalog.js\`](../../cli/core/repair-catalog.js)
- Machine-readable contract: [\`v${contract.release.version}.json\`](./v${contract.release.version}.json)
`;
}

export async function generateCapabilityContract({ check = false } = {}) {
  const contract = await buildCapabilityContract();
  const outputs = [
    {
      url: new URL(`v${contract.release.version}.json`, OUTPUT_DIR),
      content: serializeCapabilityContract(contract),
    },
    {
      url: new URL(`v${contract.release.version}.md`, OUTPUT_DIR),
      content: renderCapabilityMarkdown(contract),
    },
  ];

  if (check) {
    for (const output of outputs) {
      const actual = await readFile(output.url, 'utf8').catch(() => '');
      if (actual !== output.content) {
        throw new Error(
          `${fileURLToPath(output.url)} is stale; run npm run capabilities:generate`,
        );
      }
    }
    return contract;
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  await Promise.all(outputs.map(output => writeFile(output.url, output.content, 'utf8')));
  return contract;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateCapabilityContract({ check: process.argv.includes('--check') })
    .then(contract => {
      const verb = process.argv.includes('--check') ? 'Verified' : 'Generated';
      console.log(`${verb} capability contract v${contract.release.version}`);
    })
    .catch(error => {
      console.error(`Capability contract generation failed: ${error.message}`);
      process.exitCode = 1;
    });
}
