#!/usr/bin/env node

/**
 * ClawFix CLI entrypoint — mode dispatch only.
 * https://clawfix.dev
 *
 * Usage: npx clawfix          (OpenTUI session; plain fallback without Bun)
 *        npx clawfix --plain  (classic interactive session)
 *        npx clawfix --scan   (one-shot scan)
 *        npx clawfix --tui    (force OpenTUI; requires Bun)
 */

import { existsSync, readFileSync } from 'node:fs';
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
    return '0.11.2';
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
  (default)            Interactive session. This package ships the plain session; the OpenTUI
                       chat UI is a separate standalone binary (see below)
  --plain              Classic interactive readline session: scan, review, fix, optional chat
  --tui                Force the OpenTUI session UI (source checkout + Bun only)
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

OpenTUI chat session:
  Not bundled in this npm package. Download the standalone binary from
  https://github.com/arcabotai/clawfix/releases/latest

Examples:
  npx clawfix                  # interactive plain session
  npx clawfix --plain          # Classic interactive session
  npx clawfix --scan           # One-shot scan + repair guidance
  npx clawfix --dry-run        # See what data would be collected
  npx clawfix --yes --scan     # Auto-send for CI/scripting
`);
}

const TUI_RELEASES_URL = 'https://github.com/arcabotai/clawfix/releases/latest';

async function runOpenTuiMode({ quiet = false } = {}) {
  const cliDir = dirname(fileURLToPath(import.meta.url));
  const tuiEntry = join(cliDir, '../tui/src/main.tsx');
  const tuiDir = join(cliDir, '../tui');

  // The npm package ships the portable CLI only — the OpenTUI session is distributed as a
  // standalone binary. Detect that here instead of spawning Bun against a missing directory,
  // which surfaces as `spawn <bun> ENOENT` and wrongly blames a Bun install that is present.
  if (!existsSync(tuiEntry)) {
    if (quiet) return false;
    console.error(c.red('The OpenTUI session is not bundled in the clawfix npm package.'));
    console.error(c.dim(`Download the standalone binary: ${TUI_RELEASES_URL}`));
    console.error(c.dim('Or run it from a source checkout: cd cli/tui && bun install && bun run src/main.tsx'));
    console.error(c.dim('This session works today with: npx clawfix --plain'));
    process.exitCode = 2;
    return false;
  }

  let bunPath = '';
  try {
    bunPath = execSync('command -v bun', { encoding: 'utf8' }).trim();
  } catch {
    if (quiet) return false;
    console.error(c.red('OpenTUI mode requires Bun 1.2.21+ on PATH.'));
    console.error(c.dim('Install: https://bun.sh  then: cd cli/tui && bun install && bun run src/main.tsx'));
    process.exitCode = 2;
    return false;
  }

  const result = await new Promise(resolve => {
    const child = spawn(bunPath, [tuiEntry], {
      stdio: 'inherit',
      env: process.env,
      cwd: tuiDir,
    });
    child.on('error', error => resolve({ error }));
    child.on('exit', code => resolve({ code: code ?? 1 }));
  });

  if (result.error) {
    if (!quiet) {
      console.error(c.red(`OpenTUI failed to start: ${result.error.message}`));
      process.exitCode = 1;
    }
    return false;
  }
  // The TUI ran. A non-zero exit is its own outcome to report — it must not be mistaken for
  // "never launched", which would drop the user into a second, full plain session.
  if (result.code !== 0) process.exitCode = result.code;
  return true;
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

  if (CLI_MODE.kind === 'interactive') {
    // Default UI: OpenTUI when interactive TTY + Bun are available; plain session otherwise.
    const wantTui = !CLI_OPTIONS.plain && Boolean(process.stdout.isTTY && process.stdin.isTTY);
    if (wantTui) {
      const launched = await runOpenTuiMode({ quiet: true });
      if (launched) return;
      console.error(c.dim('OpenTUI unavailable — falling back to the plain session. Install Bun for the TUI: https://bun.sh'));
    }
    await runPlainInterface({
      mode: CLI_MODE.kind,
      options: CLI_OPTIONS,
      version: VERSION,
    });
    return;
  }

  if (CLI_MODE.kind === 'one-shot') {
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
