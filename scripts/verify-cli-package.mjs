#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// This is the next source candidate allowlist (13 files); published clawfix@0.9.1 contains 7 files.
export const EXPECTED_CLI_FILES = Object.freeze([
  'LICENSE',
  'README.md',
  'adapters/openclaw.js',
  'adapters/process.js',
  'bin/clawfix.js',
  'bin/native-diagnostics.js',
  'bin/security.js',
  'bin/workspace.js',
  'core/diagnostics.js',
  'core/events.js',
  'core/modes.js',
  'core/options.js',
  'package.json',
]);

export function validateCliPackageManifest(manifest, expectedPackage) {
  if (!Array.isArray(manifest) || manifest.length !== 1) {
    throw new Error('npm pack must return exactly one package manifest');
  }
  const [packed] = manifest;
  if (packed.name !== expectedPackage.name || packed.version !== expectedPackage.version) {
    throw new Error(
      `packed identity ${packed.name}@${packed.version} does not match ${expectedPackage.name}@${expectedPackage.version}`,
    );
  }
  if (!Array.isArray(packed.files)) throw new Error('npm pack manifest has no files array');

  const actual = packed.files.map(file => file.path).sort();
  const expected = [...EXPECTED_CLI_FILES].sort();
  const missing = expected.filter(path => !actual.includes(path));
  const unexpected = actual.filter(path => !expected.includes(path));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error([
      missing.length > 0 ? `missing files: ${missing.join(', ')}` : '',
      unexpected.length > 0 ? `unexpected files: ${unexpected.join(', ')}` : '',
    ].filter(Boolean).join('; '));
  }
  return packed;
}

async function main() {
  const [manifestPath, packagePath = 'cli/package.json'] = process.argv.slice(2);
  if (!manifestPath) {
    throw new Error('Usage: node scripts/verify-cli-package.mjs <npm-pack.json> [cli/package.json]');
  }
  const [manifestText, packageText] = await Promise.all([
    readFile(manifestPath, 'utf8'),
    readFile(packagePath, 'utf8'),
  ]);
  const packed = validateCliPackageManifest(JSON.parse(manifestText), JSON.parse(packageText));
  console.log(`Verified ${packed.name}@${packed.version}: ${packed.files.length} allowlisted files`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`CLI package validation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
