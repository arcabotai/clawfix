#!/usr/bin/env node

/**
 * ClawFix CLI entrypoint — mode dispatch only.
 * https://clawfix.dev
 *
 * Usage: npx clawfix          (interactive plain session)
 *        npx clawfix --scan   (one-shot scan)
 *        npx clawfix --tui    (experimental OpenTUI; requires Bun)
 */

import { readFileSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCliMode } from '../core/modes.js';
import { parseCliOptions } from '../core/options.js';
import { runPlainInterface } from '../interfaces/plain.js';

const CLI_OPTIONS = parseCliOptions(process.argv.slice(2), process.env);
const CLI_MODE = resolveCliMode(CLI_OPTIONS);

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.10.0';
  }
})();

const c = {
  red: s => `\x1b[31m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
};

function printHelp() {
  console.log(`
🦞 ClawFix v${VERSION}: OpenClaw diagnostics and guarded repairs

Usage: npx clawfix [options]

Modes:
  (default)            Interactive readline session: scan, review, fix, optional chat
  --tui                Experimental OpenTUI session UI (requires Bun)
  --scan               One-shot scan (legacy mode)
  --no-interactive     Same as --scan

Options:
  --dry-run, -n    Scan locally only — shows what would be collected, sends nothing
  --no-send        Local-only scan; never uploads (alias: --local-only)
  --json           Machine-readable local scan; sends nothing
  --show-data, -d  Display the full diagnostic payload before asking to send
  --server URL     Use a custom ClawFix API server (http or https)
  --yes, -y        Skip confirmation prompt and send automatically
  --version, -v    Show version
  --help, -h       Show this help message

Environment:
  CLAWFIX_API      Override API URL (default: https://clawfix.dev)
  CLAWFIX_API_TOKEN  Optional bearer token for a protected ClawFix server
  CLAWFIX_AUTO=1   Same as --yes

Interactive Commands:
  fix <#>          Fix issue (shows plan → confirm → apply → verify)
  fix-all          Fix all auto-fixable issues at once
  scan             Re-run diagnostics
  issues           Show detected issues
  help             Show help
  exit             Quit

  AI analysis is optional and only works when enabled on the selected server.

Security:
  • Recognized API keys, tokens, and passwords are redacted; inspect --dry-run before upload
  • Your hostname is SHA-256 hashed (only first 8 chars sent)
  • Workspace documents are checked by existence only; config and matching error lines may be collected
  • ClawFix discloses OpenRouter and asks before the first upload (unless --yes)
  • Source code: https://github.com/arcabotai/clawfix

Examples:
  npx clawfix                  # Interactive session (default)
  npx clawfix --tui            # Experimental OpenTUI (Bun required)
  npx clawfix --scan           # One-shot scan + repair guidance
  npx clawfix --dry-run        # See what data would be collected
  npx clawfix --yes --scan     # Auto-send for CI/scripting
`);
}

async function runOpenTuiMode() {
  const cliDir = dirname(fileURLToPath(import.meta.url));
  const tuiEntry = join(cliDir, '../tui/src/main.tsx');
  let bunPath = '';
  try {
    bunPath = execSync('command -v bun', { encoding: 'utf8' }).trim();
  } catch {
    console.error(c.red('OpenTUI mode requires Bun 1.2.21+ on PATH.'));
    console.error(c.dim('Install: https://bun.sh  then: cd cli/tui && bun install && bun run src/main.tsx'));
    process.exitCode = 2;
    return;
  }

  await new Promise((resolve, reject) => {
    const child = spawn(bunPath, [tuiEntry], {
      stdio: 'inherit',
      env: process.env,
      cwd: join(cliDir, '../tui'),
    });
    child.on('error', reject);
    child.on('exit', code => {
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}

async function main() {
  if (CLI_MODE.kind === 'version') {
    console.log(`clawfix v${VERSION}`);
    return;
  }

  if (CLI_MODE.kind === 'help') {
    printHelp();
    return;
  }

  if (CLI_MODE.kind === 'error') {
    console.error(CLI_MODE.error.message);
    process.exitCode = CLI_MODE.error.exitCode;
    return;
  }

  if (CLI_MODE.kind === 'tui') {
    await runOpenTuiMode();
    return;
  }

  if (CLI_MODE.kind === 'one-shot' || CLI_MODE.kind === 'interactive') {
    await runPlainInterface({
      mode: CLI_MODE.kind,
      options: CLI_OPTIONS,
      version: VERSION,
    });
    return;
  }

  console.error(c.red(`Unknown CLI mode: ${CLI_MODE.kind}`));
  process.exitCode = 2;
}

main().catch(err => {
  console.error(c.red(`Fatal error: ${err.message}`));
  process.exit(1);
});
