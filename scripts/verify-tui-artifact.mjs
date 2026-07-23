#!/usr/bin/env node
/**
 * Verify a ClawFix TUI standalone binary looks complete before publish.
 *
 * Checks:
 * - file exists and is executable (non-Windows)
 * - size above a floor (compiled Bun binaries are multi-MB)
 * - SHA256SUMS entry matches when present
 * - strings/bytes contain OpenTUI native marker for linux-x64 when target is linux
 *
 * Usage: node scripts/verify-tui-artifact.mjs <path-to-binary> [--target linux-x64]
 */
import { existsSync, readFileSync, statSync, accessSync, constants } from "node:fs"
import { createHash } from "node:crypto"
import { basename, dirname, join } from "node:path"

function fail(msg) {
  console.error(`verify-tui-artifact: ${msg}`)
  process.exit(1)
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex")
}

function parseArgs(argv) {
  let path = null
  let target = "linux-x64"
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target" && argv[i + 1]) target = argv[++i]
    else if (!argv[i].startsWith("-")) path = argv[i]
  }
  if (!path) fail("usage: node scripts/verify-tui-artifact.mjs <binary> [--target id]")
  return { path, target }
}

function main() {
  const { path, target } = parseArgs(process.argv.slice(2))
  if (!existsSync(path)) fail(`missing file: ${path}`)
  const st = statSync(path)
  if (!st.isFile()) fail(`not a file: ${path}`)
  if (st.size < 1_000_000) fail(`artifact too small (${st.size} bytes) — compile likely failed`)

  if (process.platform !== "win32" && !target.startsWith("windows")) {
    try {
      accessSync(path, constants.X_OK)
    } catch {
      fail(`not executable: ${path}`)
    }
  }

  const buf = readFileSync(path)
  const digest = sha256(buf)
  const sumsPath = join(dirname(path), "SHA256SUMS")
  if (existsSync(sumsPath)) {
    const lines = readFileSync(sumsPath, "utf8").split("\n")
    const name = basename(path)
    const hit = lines.find((l) => l.trim().endsWith(`  ${name}`) || l.trim().endsWith(` *${name}`))
    if (!hit) fail(`no SHA256SUMS line for ${name}`)
    const expected = hit.trim().split(/\s+/)[0]
    if (expected !== digest) fail(`checksum mismatch for ${name}: got ${digest} want ${expected}`)
  }

  // Native renderer package name should appear somewhere in a bundled linux binary.
  if (target.includes("linux")) {
    const hay = buf.toString("latin1")
    const markers = ["opentui", "OpenTUI", "core-linux", "createCliRenderer"]
    if (!markers.some((m) => hay.includes(m))) {
      fail(`linux artifact missing expected OpenTUI markers (${markers.join(", ")})`)
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        path,
        target,
        bytes: st.size,
        sha256: digest,
      },
      null,
      2,
    ),
  )
}

main()
