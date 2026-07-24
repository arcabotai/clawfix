import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, access, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { createServer } from 'node:http';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('install route is mounted and serves scripts/install.sh with sha256 metadata', async () => {
  const [serverSource, installRoute, installScript] = await Promise.all([
    read('src/server.js'),
    read('src/routes/install.js'),
    read('scripts/install.sh'),
  ]);

  assert.match(serverSource, /installRouter/);
  assert.match(installRoute, /app\.use|installRouter\.get\('\/install'/);
  assert.match(installRoute, /install\/sha256/);
  assert.match(installScript, /^#!\/usr\/bin\/env bash/m);
  assert.doesNotMatch(installScript, /curl[^\n]*\|\s*(?:ba)?sh/);
  assert.match(installScript, /Compare the printed hashes exactly before running the script/);
  assert.match(installScript, /CLAWFIX_VERSION/);
  assert.match(installScript, /registry\.npmjs\.org/);
  assert.match(installScript, /openssl dgst -sha512|createHash\("sha512"\)/);
  assert.match(installScript, /download_url|curl --fail/);
  assert.match(installScript, /Node fetch|crypto/);
  assert.match(installScript, /\$\{HOME\}\/\.local\/bin|\$\{HOME\}\/\.clawfix/);
  assert.match(installScript, /CLAWFIX_BIN_DIR/);

  const expectedHash = createHash('sha256').update(installScript).digest('hex');
  const { INSTALL_HASH, INSTALL_SCRIPT } = await import(new URL('../src/routes/install.js', import.meta.url).href);
  assert.equal(INSTALL_SCRIPT, installScript);
  assert.equal(INSTALL_HASH, expectedHash);
});

test('installer guidance never pipes curl into a shell on public surfaces', async () => {
  const sources = await Promise.all([
    read('scripts/install.sh'),
    read('src/routes/install.js'),
    read('src/landing.js'),
    read('README.md'),
  ]);
  for (const source of sources) {
    assert.doesNotMatch(source, /curl[^\n]*\|\s*(?:ba)?sh/);
  }
  assert.match(sources[2], /clawfix\.dev\/install/);
  assert.match(sources[2], /install\/sha256/);
  assert.match(sources[3], /clawfix\.dev\/install/);
});

test('install script installs a pinned package into a local prefix without npm install', async () => {
  // Build a fake npm registry + package tarball using the real published CLI layout.
  const work = await mkdtemp(join(tmpdir(), 'clawfix-install-test-'));
  const registryRoot = join(work, 'registry');
  const packDir = join(work, 'pack');
  const prefix = join(work, 'prefix');
  const binDir = join(work, 'bin');
  try {
    await run('mkdir', ['-p', packDir, join(registryRoot, 'clawfix'), prefix, binDir]);

    // Minimal package matching published clawfix bin layout
    const pkg = {
      name: 'clawfix',
      version: '0.10.0',
      bin: { clawfix: 'bin/clawfix.js' },
      type: 'module',
    };
    await writeFile(join(packDir, 'package.json'), JSON.stringify(pkg, null, 2));
    await run('mkdir', ['-p', join(packDir, 'bin')]);
    await writeFile(
      join(packDir, 'bin/clawfix.js'),
      '#!/usr/bin/env node\nconsole.log("clawfix v0.10.0-test");\n',
    );
    await chmod(join(packDir, 'bin/clawfix.js'), 0o755);

    // Create npm-style tarball package/
    const tarball = join(work, 'clawfix-0.10.0.tgz');
    await run('tar', ['-czf', tarball, '-C', packDir, '--transform=s,^,package/,', '.']);

    const integrity = await new Promise((resolve, reject) => {
      const child = spawn('bash', ['-lc', `openssl dgst -sha512 -binary ${JSON.stringify(tarball)} | openssl base64 -A`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', c => { out += c; });
      child.stderr.on('data', c => { err += c; });
      child.on('close', code => {
        if (code !== 0) reject(new Error(err || `openssl exit ${code}`));
        else resolve(`sha512-${out.trim()}`);
      });
    });

    // Fake registry HTTP server
    const tarballBytes = await readFile(tarball);
    const server = createServer((req, res) => {
      if (req.url === '/clawfix/0.10.0') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          name: 'clawfix',
          version: '0.10.0',
          dist: {
            tarball: `http://127.0.0.1:${server.address().port}/clawfix/-/clawfix-0.10.0.tgz`,
            integrity,
          },
        }));
        return;
      }
      if (req.url === '/clawfix/-/clawfix-0.10.0.tgz') {
        res.setHeader('content-type', 'application/octet-stream');
        res.end(tarballBytes);
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const registry = `http://127.0.0.1:${port}`;

    const installScript = new URL('../scripts/install.sh', import.meta.url).pathname;
    const result = await run('bash', [installScript], {
      CLAWFIX_VERSION: '0.10.0',
      CLAWFIX_PREFIX: prefix,
      CLAWFIX_BIN_DIR: binDir,
      CLAWFIX_REGISTRY: registry,
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: work,
    });

    assert.equal(result.code, 0, result.stdout + result.stderr);
    await access(join(binDir, 'clawfix'));
    await access(join(prefix, 'versions/0.10.0/bin/clawfix.js'));

    const version = await run(join(binDir, 'clawfix'), []);
    assert.equal(version.code, 0, version.stderr);
    assert.match(version.stdout, /clawfix v0\.10\.0-test/);

    server.close();
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
