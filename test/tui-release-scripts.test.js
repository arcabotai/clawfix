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
      'scripts/smoke-tui-interactive.mjs',
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
  it('smoke script rejects a binary that starts but never renders the session UI', async () => {
    // The gate previously accepted any bytes on stdout plus exit 0, so a binary that emitted
    // escape codes and rendered nothing passed.
    const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'clawfix-smoke-'));
    const fake = join(dir, 'fake-tui');
    try {
      await writeFile(fake, '#!/bin/sh\nprintf "\\033[?1049h\\033[2J"\nexit 0\n');
      await chmod(fake, 0o755);

      const r = spawnSync(process.execPath, [join(root, 'scripts/smoke-tui-binary.mjs'), fake], {
        encoding: 'utf8',
        env: { ...process.env, SMOKE_TIMEOUT_MS: '4000' },
      });

      assert.notEqual(r.status, 0);
      assert.match(`${r.stdout}${r.stderr}`, /never rendered the session UI/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('build script passes the solid transform to the bundler', async () => {
    // Without this plugin `bun build --compile` uses the plain automatic JSX runtime: the
    // binary renders a correct first frame and then ignores every keystroke.
    const { readFile } = await import('node:fs/promises');
    const build = await readFile(join(root, 'cli/tui/scripts/build.ts'), 'utf8');
    assert.match(build, /createSolidTransformPlugin/);
    assert.match(build, /plugins: \[createSolidTransformPlugin\(\)\]/);
    // The CLI form cannot inherit the plugin, so it must not come back.
    assert.doesNotMatch(build, /spawnSync\("bun", \["build"/);
  });

  it('interactive smoke fails a binary that renders but ignores input', () => {
    const r = spawnSync(process.execPath, [join(root, 'scripts/smoke-tui-interactive.mjs'), '/no/such/binary'], {
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0);
    assert.match(`${r.stdout}${r.stderr}`, /binary not found/);
  });
});
