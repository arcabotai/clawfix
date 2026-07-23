#!/usr/bin/env node
/**
 * Orchestrate ClawFix TUI standalone release builds.
 *
 * Env:
 *   TUI_TARGETS   comma-separated target ids (default: linux-x64)
 *   TUI_OUTDIR    output directory (default: dist/tui)
 *   SKIP_INSTALL  if 1, do not run bun install in cli/tui
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const TUI = join(ROOT, "cli", "tui")
const DEFAULT_TARGETS = ["linux-x64"]

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`)
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts })
  if (r.status !== 0) {
    process.exit(r.status ?? 1)
  }
}

function sha256File(path) {
  const h = createHash("sha256")
  h.update(readFileSync(path))
  return h.digest("hex")
}

function main() {
  const outdir = resolve(process.env.TUI_OUTDIR || join(ROOT, "dist", "tui"))
  const targets = (process.env.TUI_TARGETS || DEFAULT_TARGETS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  mkdirSync(outdir, { recursive: true })

  if (process.env.SKIP_INSTALL !== "1") {
    run("bun", ["install", "--cwd", TUI, "--frozen-lockfile"], {
      env: process.env,
      shell: false,
    })
  }

  const built = []
  for (const target of targets) {
    run(
      "bun",
      ["run", join(TUI, "scripts", "build.ts"), "--target", target, "--outdir", outdir],
      { cwd: TUI, env: process.env },
    )
    built.push(target)
  }

  // checksums for binaries + launchers only (skip asset directories)
  const files = readdirSync(outdir).filter((f) => {
    const p = join(outdir, f)
    try {
      return statSync(p).isFile() && !f.endsWith(".sha256") && !f.endsWith(".json") && f !== "SHA256SUMS"
    } catch {
      return false
    }
  })
  const lines = []
  const manifest = { generatedAt: new Date().toISOString(), targets: built, artifacts: [] }
  for (const f of files) {
    const p = join(outdir, f)
    const digest = sha256File(p)
    lines.push(`${digest}  ${f}`)
    manifest.artifacts.push({ name: f, sha256: digest, bytes: readFileSync(p).byteLength })
  }
  writeFileSync(join(outdir, "SHA256SUMS"), lines.join("\n") + (lines.length ? "\n" : ""))
  writeFileSync(join(outdir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
  console.log(`Wrote ${join(outdir, "SHA256SUMS")} and manifest.json (${files.length} artifacts)`)
}

main()
