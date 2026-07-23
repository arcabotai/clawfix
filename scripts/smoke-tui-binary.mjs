#!/usr/bin/env node
/**
 * PTY smoke for a ClawFix TUI standalone binary.
 *
 * Starts the binary under a fake HOME with a minimal OpenClaw fixture,
 * waits for alternate-screen / app chrome, sends Ctrl+C, asserts clean exit
 * and restored terminal (cursor show / private mode off best-effort).
 *
 * Usage:
 *   node scripts/smoke-tui-binary.mjs <binary>
 *
 * Env:
 *   SMOKE_TIMEOUT_MS  default 20000
 *   SMOKE_SKIP_PTY=1  only exec --help-style / version probe (exit if binary runs 0 with CLAWFIX_TUI_SMOKE=1)
 */
import { spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

function fail(msg) {
  console.error(`smoke-tui-binary: ${msg}`)
  process.exit(1)
}

function makeFixture() {
  const home = mkdtempSync(join(tmpdir(), "clawfix-tui-smoke-"))
  const openclaw = join(home, ".openclaw")
  mkdirSync(openclaw, { recursive: true })
  writeFileSync(
    join(openclaw, "openclaw.json"),
    JSON.stringify(
      {
        version: "smoke-fixture",
        gateway: { port: 18789 },
        channels: { telegram: { enabled: false } },
      },
      null,
      2,
    ),
  )
  return home
}

async function loadPty() {
  try {
    return require("node-pty")
  } catch {
    return null
  }
}

async function smokeWithPty(binary, home, envExtra = {}) {
  const pty = await loadPty()
  if (!pty) {
    console.log("node-pty not installed; falling back to plain spawn smoke")
    return smokePlain(binary, home, envExtra)
  }

  const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 20000)
  let output = ""
  const term = pty.spawn(binary, [], {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: home,
    env: {
      ...process.env,
      ...envExtra,
      HOME: home,
      USERPROFILE: home,
      TERM: "xterm-256color",
      NO_COLOR: "",
      CLAWFIX_TUI_SMOKE: "1",
    },
  })

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        term.kill()
      } catch {
        /* ignore */
      }
      resolve({ ok: false, reason: "timeout", output, code: null })
    }, timeoutMs)

    term.onData((data) => {
      output += data
      // Any substantial TUI output or alternate screen is enough to prove start.
      if (
        output.includes("ClawFix") ||
        output.includes("\x1b[?1049h") ||
        output.includes("OpenClaw") ||
        output.length > 200
      ) {
        // request interrupt
        term.write("\x03")
      }
    })

    term.onExit(({ exitCode }) => {
      clearTimeout(timer)
      resolve({ ok: true, reason: "exit", output, code: exitCode })
    })
  })

  // Best-effort terminal restore markers after exit (may be absent if SIGINT abrupt).
  const restored =
    result.output.includes("\x1b[?1049l") ||
    result.output.includes("\x1b[?25h") ||
    result.code === 0 ||
    result.code === 130 ||
    result.code === 143

  if (!result.ok && result.reason === "timeout") {
    fail(`timed out waiting for TUI startup\n--- output ---\n${result.output.slice(-2000)}`)
  }

  if (!restored && result.code !== 0 && result.code !== 130) {
    fail(`unclean exit code ${result.code}\n--- output ---\n${result.output.slice(-2000)}`)
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "pty",
        exitCode: result.code,
        outputBytes: result.output.length,
        sawAltScreen: result.output.includes("\x1b[?1049h"),
      },
      null,
      2,
    ),
  )
}

function smokePlain(binary, home, envExtra = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 8000)
    const full = process.env.CLAWFIX_TUI_FULL_SMOKE === "1"
    const child = spawn(binary, [], {
      cwd: home,
      env: {
        ...process.env,
        ...envExtra,
        HOME: home,
        TERM: full ? "xterm-256color" : "dumb",
        CLAWFIX_TUI_SMOKE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    child.stdout.on("data", (d) => {
      out += d
    })
    child.stderr.on("data", (d) => {
      err += d
    })
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
    }, timeoutMs)
    child.on("error", (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      if (code === 127) reject(new Error("binary not executable or missing interpreter"))
      const started = out.length + err.length > 0 || code === 0 || signal === "SIGTERM" || signal === "SIGINT"
      if (!started) reject(new Error(`binary produced no output and exit ${code}`))
      // With OTUI_ASSET_ROOT, require no tree-sitter path crash
      if (err.includes("normalizeLoadedFilePath") || err.includes("loadedPath.startsWith")) {
        reject(new Error(`OpenTUI asset path still broken:\n${err.slice(-800)}`))
      }
      if (full && code !== 0 && code !== 130 && code !== 143) {
        reject(new Error(`full smoke failed exit ${code}: ${err.slice(-500)}`))
      }
      console.log(
        JSON.stringify(
          {
            ok: true,
            mode: "plain",
            full,
            exitCode: code,
            signal,
            stdoutBytes: out.length,
            stderrBytes: err.length,
            otuiAssetRoot: envExtra.OTUI_ASSET_ROOT || process.env.OTUI_ASSET_ROOT || null,
            stderrTail: err.slice(-500),
          },
          null,
          2,
        ),
      )
      resolve()
    })
  })
}

async function main() {
  const binaryArg = process.argv[2]
  if (!binaryArg) fail("usage: node scripts/smoke-tui-binary.mjs <binary-or-launcher>")
  const { resolve, dirname, join } = await import("node:path")
  const binary = resolve(binaryArg)
  if (!existsSync(binary)) fail(`missing binary: ${binary}`)

  // Prefer OTUI_ASSET_ROOT next to launcher (assets-<target>/)
  const dir = dirname(binary)
  const assetCandidates = readdirSync(dir).filter((n) => n.startsWith("assets-"))
  const envExtra = {}
  if (!process.env.OTUI_ASSET_ROOT && assetCandidates.length) {
    envExtra.OTUI_ASSET_ROOT = join(dir, assetCandidates[0])
    envExtra.OTUI_TREE_SITTER_WORKER_PATH = join(
      envExtra.OTUI_ASSET_ROOT,
      "@opentui/core/parser.worker.js",
    )
  }

  const home = makeFixture()
  try {
    if (process.env.CLAWFIX_TUI_FULL_SMOKE === "1") {
      await smokeWithPty(binary, home, envExtra)
    } else {
      await smokePlain(binary, home, envExtra)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

main().catch((e) => {
  fail(e?.stack || String(e))
})
