import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('tui release scripts', () => {
  it('ships build/verify/smoke scripts and release workflow', () => {
    for (const p of [
      'cli/tui/scripts/build.ts',
      'scripts/build-tui-release.mjs',
      'scripts/verify-tui-artifact.mjs',
      'scripts/smoke-tui-binary.mjs',
      '.github/workflows/release-tui.yml',
    ]) {
      assert.equal(existsSync(join(root, p)), true, p);
    }
  });

  it('verify script fails on missing binary', () => {
    const r = spawnSync(process.execPath, [join(root, 'scripts/verify-tui-artifact.mjs'), '/no/such/binary'], {
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0);
  });
});
