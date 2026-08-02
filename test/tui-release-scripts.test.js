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

  it('interactive smoke fails a renderer that redraws but ignores input', async () => {
    const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'clawfix-interactive-'));
    const fake = join(dir, 'ignore-input');
    try {
      await writeFile(fake, `#!/usr/bin/env node
process.stdin.setRawMode?.(true);
process.stdin.resume();
setInterval(() => process.stdout.write('\\u001b[HClawFix redraw'), 50);
process.stdin.on('data', data => { if (data.includes(4)) process.exit(0); });
`);
      await chmod(fake, 0o755);
      const r = spawnSync(process.execPath, [join(root, 'scripts/smoke-tui-interactive.mjs'), fake], {
        encoding: 'utf8',
        env: { ...process.env, CLAWFIX_TUI_REQUIRE_PTY: '1' },
      });
      assert.notEqual(r.status, 0);
      assert.match(`${r.stdout}${r.stderr}`, /ignored typed input/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('interactive smoke fails a binary that crashes after accepting input', async () => {
    const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'clawfix-interactive-'));
    const fake = join(dir, 'crash-on-exit');
    try {
      await writeFile(fake, `#!/usr/bin/env node
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write('ClawFix');
process.stdin.on('data', data => {
  if (data.includes(4)) process.exit(7);
  process.stdout.write(data);
});
`);
      await chmod(fake, 0o755);
      const r = spawnSync(process.execPath, [join(root, 'scripts/smoke-tui-interactive.mjs'), fake], {
        encoding: 'utf8',
        env: { ...process.env, CLAWFIX_TUI_REQUIRE_PTY: '1' },
      });
      assert.notEqual(r.status, 0);
      assert.match(`${r.stdout}${r.stderr}`, /nonzero status 7/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('configures a nonzero PTY window before judging the compiled session', async () => {
    const { readFile } = await import('node:fs/promises');
    const smoke = await readFile(join(root, 'scripts/smoke-tui-interactive.mjs'), 'utf8');
    assert.match(smoke, /TIOCSWINSZ/);
    assert.match(smoke, /struct\.pack\("HHHH", 30, 100, 0, 0\)/);
  });

  it('emits a POSIX launcher that stock Alpine can execute without Bash', async () => {
    const { readFile } = await import('node:fs/promises');
    const buildSource = await readFile(join(root, 'cli/tui/scripts/build.ts'), 'utf8');
    assert.match(buildSource, /const script = `#!\/bin\/sh/);
    assert.match(buildSource, /set -eu/);
    assert.match(buildSource, /if \[ ! -d "\$OTUI_ASSET_ROOT" \]; then/);
    assert.doesNotMatch(buildSource, /#!\/usr\/bin\/env bash|set -euo pipefail|\[\[/);
  });

  it('restores modes and smokes the extracted final tarballs before attestation', async () => {
    const { readFile } = await import('node:fs/promises');
    const workflow = await readFile(join(root, '.github/workflows/release-tui.yml'), 'utf8');

    const publishJob = workflow.slice(workflow.indexOf('  publish-release-assets:'));
    assert.match(publishJob, /uses: actions\/checkout@v6/);
    assert.match(publishJob, /fetch-depth: 0/);
    assert.match(publishJob, /chmod 0755 "\$launcher" "\$binary"/);
    assert.match(publishJob, /assert_archive_mode "\$tarball" "\.\/clawfix-tui-\$target"/);
    assert.match(publishJob, /assert_archive_mode "\$tarball" "\.\/clawfix-tui-\$target\.bin"/);
    assert.match(publishJob, /tar -xzf "\$tarball" -C "\$smoke_dir"/);
    assert.match(publishJob, /test -x "\$smoke_launcher"/);
    assert.match(publishJob, /test -x "\$smoke_binary"/);
    assert.match(publishJob, /stat -c '%a' "\$smoke_launcher"/);
    assert.match(publishJob, /stat -c '%a' "\$smoke_binary"/);
    assert.match(publishJob, /smoke-tui-binary\.mjs "\$smoke_launcher"/);
    assert.match(publishJob, /smoke-tui-interactive\.mjs "\$smoke_launcher"/);
    assert.match(publishJob, /node:24-alpine/);
    assert.match(publishJob, /release-smoke\/linux-x64-musl/);
    assert.match(publishJob, /apk add --no-cache python3/);
    assert.match(publishJob, /CLAWFIX_TUI_REQUIRE_PTY=1 node scripts\/smoke-tui-interactive\.mjs/);

    const packageAt = publishJob.indexOf('- name: Package and smoke final target tarballs');
    const attestAt = publishJob.indexOf('- name: Attest TUI release tarballs');
    assert.ok(packageAt >= 0 && attestAt > packageAt, 'attestation must follow packaged-artifact smoke');
  });

  it('ships a musl target that stages its library under the key the runtime asks for', async () => {
    // @opentui/core resolves its native library by a hardcoded package name and has no musl
    // detection, so on Alpine it asks for @opentui/core-linux-x64. The musl build stages the
    // musl library under that key — without it the binary cannot load its renderer at all.
    const { readFile } = await import('node:fs/promises');
    const build = await readFile(join(root, 'cli/tui/scripts/build.ts'), 'utf8');
    assert.match(build, /"linux-x64-musl"/);
    assert.match(build, /bunCompileTarget: "bun-linux-x64-musl"/);
    assert.match(build, /nativePackage: "@opentui\/core-linux-x64-musl"/);
    assert.match(build, /nativeAssetPackage: "@opentui\/core-linux-x64"/);
    assert.match(build, /spec\.nativeAssetPackage \?\? spec\.nativePackage/);

    const workflow = await readFile(join(root, '.github/workflows/release-tui.yml'), 'utf8');
    assert.match(workflow, /target: linux-x64-musl/);
    assert.match(workflow, /@opentui\/core-linux-x64-musl/);
  });
});
