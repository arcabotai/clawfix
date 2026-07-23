#!/usr/bin/env bun
/**
 * Compile ClawFix OpenTUI into a standalone Bun executable for one target.
 *
 * Usage:
 *   bun run scripts/build.ts --target linux-x64 --outdir ../../dist/tui
 *   bun run scripts/build.ts --target linux-x64-baseline --outdir ../../dist/tui
 *
 * Targets map to Bun compile destinations + OpenTUI native optional packages.
 */
import { mkdirSync, existsSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const __dirname = dirname(fileURLToPath(import.meta.url))
const TUI_ROOT = resolve(__dirname, "..")
const ENTRY = join(TUI_ROOT, "src", "main.tsx")

export type TuiTargetId =
  | "linux-x64"
  | "linux-x64-baseline"
  | "linux-arm64"
  | "darwin-arm64"
  | "darwin-x64"
  | "windows-x64"

export interface TargetSpec {
  readonly id: TuiTargetId
  /** Bun --target for cross-compile when supported */
  readonly bunCompileTarget: string
  readonly outfileName: string
  readonly nativePackage: string
  readonly platform: "linux" | "darwin" | "windows"
  readonly arch: "x64" | "arm64"
  readonly baseline?: boolean
}

export const TARGETS: Readonly<Record<TuiTargetId, TargetSpec>> = Object.freeze({
  "linux-x64": {
    id: "linux-x64",
    bunCompileTarget: "bun-linux-x64",
    outfileName: "clawfix-tui-linux-x64",
    nativePackage: "@opentui/core-linux-x64",
    platform: "linux",
    arch: "x64",
  },
  "linux-x64-baseline": {
    id: "linux-x64-baseline",
    bunCompileTarget: "bun-linux-x64-baseline",
    outfileName: "clawfix-tui-linux-x64-baseline",
    nativePackage: "@opentui/core-linux-x64",
    platform: "linux",
    arch: "x64",
    baseline: true,
  },
  "linux-arm64": {
    id: "linux-arm64",
    bunCompileTarget: "bun-linux-arm64",
    outfileName: "clawfix-tui-linux-arm64",
    nativePackage: "@opentui/core-linux-arm64",
    platform: "linux",
    arch: "arm64",
  },
  "darwin-arm64": {
    id: "darwin-arm64",
    bunCompileTarget: "bun-darwin-arm64",
    outfileName: "clawfix-tui-darwin-arm64",
    nativePackage: "@opentui/core-darwin-arm64",
    platform: "darwin",
    arch: "arm64",
  },
  "darwin-x64": {
    id: "darwin-x64",
    bunCompileTarget: "bun-darwin-x64",
    outfileName: "clawfix-tui-darwin-x64",
    nativePackage: "@opentui/core-darwin-x64",
    platform: "darwin",
    arch: "x64",
  },
  "windows-x64": {
    id: "windows-x64",
    bunCompileTarget: "bun-windows-x64",
    outfileName: "clawfix-tui-windows-x64.exe",
    nativePackage: "@opentui/core-windows-x64",
    platform: "windows",
    arch: "x64",
  },
})

function parseArgs(argv: string[]) {
  let target: TuiTargetId = "linux-x64"
  let outdir = join(TUI_ROOT, "..", "..", "dist", "tui")
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--target" && argv[i + 1]) {
      target = argv[++i] as TuiTargetId
    } else if (a === "--outdir" && argv[i + 1]) {
      outdir = resolve(argv[++i])
    } else if (a === "--help" || a === "-h") {
      console.log(`Usage: bun run scripts/build.ts --target <id> --outdir <dir>
Targets: ${Object.keys(TARGETS).join(", ")}`)
      process.exit(0)
    }
  }
  if (!TARGETS[target]) {
    throw new Error(`Unknown target ${target}. Known: ${Object.keys(TARGETS).join(", ")}`)
  }
  return { target, outdir }
}

export function ensureNativePackage(spec: TargetSpec): void {
  const pkgJson = join(TUI_ROOT, "node_modules", ...spec.nativePackage.split("/"), "package.json")
  if (existsSync(pkgJson)) return
  console.log(`Installing native package ${spec.nativePackage} …`)
  const r = spawnSync(
    "bun",
    ["add", "--cwd", TUI_ROOT, "--optional", `${spec.nativePackage}@0.4.5`],
    { stdio: "inherit", env: process.env },
  )
  if (r.status !== 0) {
    throw new Error(`Failed to install ${spec.nativePackage}`)
  }
}

export function buildTarget(spec: TargetSpec, outdir: string): string {
  mkdirSync(outdir, { recursive: true })
  ensureNativePackage(spec)
  const outfile = join(outdir, spec.outfileName)
  if (existsSync(outfile)) rmSync(outfile)

  const args = [
    "build",
    "--compile",
    `--outfile=${outfile}`,
    `--target=${spec.bunCompileTarget}`,
    ENTRY,
  ]
  console.log(`$ bun ${args.join(" ")}`)
  const r = spawnSync("bun", args, {
    cwd: TUI_ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "production",
    },
  })
  if (r.status !== 0) {
    throw new Error(`bun build failed for ${spec.id} (exit ${r.status})`)
  }
  if (!existsSync(outfile)) {
    throw new Error(`Expected artifact missing: ${outfile}`)
  }
  console.log(`Built ${outfile}`)
  return outfile
}

if (import.meta.main) {
  const { target, outdir } = parseArgs(process.argv.slice(2))
  buildTarget(TARGETS[target], outdir)
}
