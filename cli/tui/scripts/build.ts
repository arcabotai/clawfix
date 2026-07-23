#!/usr/bin/env bun
/**
 * Compile ClawFix OpenTUI into a standalone Bun executable for one target.
 *
 * OpenTUI needs relocatable runtime assets under bun --compile ($bunfs cannot
 * resolve import.meta asset URLs). After compile we stage OTUI_ASSET_ROOT next
 * to the binary and emit a thin launcher that sets the env var.
 *
 * Usage:
 *   bun run scripts/build.ts --target linux-x64 --outdir ../../dist/tui
 */
import {
  mkdirSync,
  existsSync,
  rmSync,
  cpSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs"
import { dirname, join, resolve, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const __dirname = dirname(fileURLToPath(import.meta.url))
const TUI_ROOT = resolve(__dirname, "..")
const ENTRY = join(TUI_ROOT, "src", "standalone.ts")
const NM = join(TUI_ROOT, "node_modules")

export type TuiTargetId =
  | "linux-x64"
  | "linux-x64-baseline"
  | "linux-arm64"
  | "darwin-arm64"
  | "darwin-x64"
  | "windows-x64"

export interface TargetSpec {
  readonly id: TuiTargetId
  readonly bunCompileTarget: string
  readonly outfileName: string
  readonly nativePackage: string
  readonly nativeFileName: string
  readonly platform: "linux" | "darwin" | "windows"
  readonly arch: "x64" | "arm64"
  readonly baseline?: boolean
}

export const TARGETS: Readonly<Record<TuiTargetId, TargetSpec>> = Object.freeze({
  "linux-x64": {
    id: "linux-x64",
    bunCompileTarget: "bun-linux-x64",
    outfileName: "clawfix-tui-linux-x64.bin",
    nativePackage: "@opentui/core-linux-x64",
    nativeFileName: "libopentui.so",
    platform: "linux",
    arch: "x64",
  },
  "linux-x64-baseline": {
    id: "linux-x64-baseline",
    bunCompileTarget: "bun-linux-x64-baseline",
    outfileName: "clawfix-tui-linux-x64-baseline.bin",
    nativePackage: "@opentui/core-linux-x64",
    nativeFileName: "libopentui.so",
    platform: "linux",
    arch: "x64",
    baseline: true,
  },
  "linux-arm64": {
    id: "linux-arm64",
    bunCompileTarget: "bun-linux-arm64",
    outfileName: "clawfix-tui-linux-arm64.bin",
    nativePackage: "@opentui/core-linux-arm64",
    nativeFileName: "libopentui.so",
    platform: "linux",
    arch: "arm64",
  },
  "darwin-arm64": {
    id: "darwin-arm64",
    bunCompileTarget: "bun-darwin-arm64",
    outfileName: "clawfix-tui-darwin-arm64.bin",
    nativePackage: "@opentui/core-darwin-arm64",
    nativeFileName: "libopentui.dylib",
    platform: "darwin",
    arch: "arm64",
  },
  "darwin-x64": {
    id: "darwin-x64",
    bunCompileTarget: "bun-darwin-x64",
    outfileName: "clawfix-tui-darwin-x64.bin",
    nativePackage: "@opentui/core-darwin-x64",
    nativeFileName: "libopentui.dylib",
    platform: "darwin",
    arch: "x64",
  },
  "windows-x64": {
    id: "windows-x64",
    bunCompileTarget: "bun-windows-x64",
    outfileName: "clawfix-tui-windows-x64.bin.exe",
    nativePackage: "@opentui/core-windows-x64",
    nativeFileName: "opentui.dll",
    platform: "windows",
    arch: "x64",
  },
})

function parseArgs(argv: string[]) {
  let target: TuiTargetId = "linux-x64"
  let outdir = join(TUI_ROOT, "..", "..", "dist", "tui")
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--target" && argv[i + 1]) target = argv[++i] as TuiTargetId
    else if (a === "--outdir" && argv[i + 1]) outdir = resolve(argv[++i])
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: bun run scripts/build.ts --target <id> --outdir <dir>
Targets: ${Object.keys(TARGETS).join(", ")}`)
      process.exit(0)
    }
  }
  if (!TARGETS[target]) throw new Error(`Unknown target ${target}`)
  return { target, outdir }
}

export function ensureNativePackage(spec: TargetSpec): void {
  const pkgJson = join(NM, ...spec.nativePackage.split("/"), "package.json")
  if (existsSync(pkgJson)) return
  console.log(`Installing native package ${spec.nativePackage} …`)
  const r = spawnSync("bun", ["add", "--cwd", TUI_ROOT, "--optional", `${spec.nativePackage}@0.4.5`], {
    stdio: "inherit",
    env: process.env,
  })
  if (r.status !== 0) throw new Error(`Failed to install ${spec.nativePackage}`)
}

function copyFile(src: string, dest: string) {
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(src, dest)
}

/** Stage OTUI_ASSET_ROOT layout expected by @opentui/core resolveAssetRootPath(key). */
export function stageOtuiAssetRoot(spec: TargetSpec, assetRoot: string): void {
  if (existsSync(assetRoot)) rmSync(assetRoot, { recursive: true, force: true })
  mkdirSync(assetRoot, { recursive: true })

  // web-tree-sitter/tree-sitter.wasm
  const wasmCandidates = [
    join(NM, "web-tree-sitter", "tree-sitter.wasm"),
    join(NM, "web-tree-sitter", "lib", "tree-sitter.wasm"),
  ]
  const wasm = wasmCandidates.find((p) => existsSync(p))
  if (!wasm) throw new Error("web-tree-sitter.wasm not found")
  copyFile(wasm, join(assetRoot, "web-tree-sitter", "tree-sitter.wasm"))

  // @opentui/core/parser.worker.js + assets/**
  const coreDir = join(NM, "@opentui", "core")
  copyFile(join(coreDir, "parser.worker.js"), join(assetRoot, "@opentui", "core", "parser.worker.js"))
  const assetsDir = join(coreDir, "assets")
  if (!existsSync(assetsDir)) throw new Error("missing @opentui/core/assets")
  cpSync(assetsDir, join(assetRoot, "@opentui", "core", "assets"), { recursive: true })

  // native library key: @opentui/core-<plat>-<arch>/<file>
  const nativeDir = join(NM, ...spec.nativePackage.split("/"))
  const nativeSrc = join(nativeDir, spec.nativeFileName)
  if (!existsSync(nativeSrc)) throw new Error(`missing native ${nativeSrc}`)
  copyFile(nativeSrc, join(assetRoot, spec.nativePackage, spec.nativeFileName))

  // inventory
  const files: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else files.push(relative(assetRoot, p))
    }
  }
  walk(assetRoot)
  writeFileSync(join(assetRoot, "MANIFEST.txt"), files.sort().join("\n") + "\n")
  console.log(`Staged ${files.length} OpenTUI assets under ${assetRoot}`)
}

function writeUnixLauncher(launcherPath: string, binName: string, assetDirName: string) {
  const script = `#!/usr/bin/env bash
# ClawFix TUI launcher — sets OTUI_ASSET_ROOT for bun --compile OpenTUI assets.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export OTUI_ASSET_ROOT="\${OTUI_ASSET_ROOT:-$HERE/${assetDirName}}"
export OTUI_TREE_SITTER_WORKER_PATH="\${OTUI_TREE_SITTER_WORKER_PATH:-$OTUI_ASSET_ROOT/@opentui/core/parser.worker.js}"
if [[ ! -d "$OTUI_ASSET_ROOT" ]]; then
  echo "clawfix-tui: missing assets at $OTUI_ASSET_ROOT" >&2
  exit 1
fi
exec "$HERE/${binName}" "$@"
`
  writeFileSync(launcherPath, script)
  chmodSync(launcherPath, 0o755)
}

function writeWindowsLauncher(launcherPath: string, binName: string, assetDirName: string) {
  const script = `@echo off
setlocal
set HERE=%~dp0
if not defined OTUI_ASSET_ROOT set OTUI_ASSET_ROOT=%HERE%${assetDirName}
if not defined OTUI_TREE_SITTER_WORKER_PATH set OTUI_TREE_SITTER_WORKER_PATH=%OTUI_ASSET_ROOT%\\@opentui\\core\\parser.worker.js
"%HERE%${binName}" %*
`
  writeFileSync(launcherPath, script)
}

export function buildTarget(spec: TargetSpec, outdir: string): { binary: string; launcher: string; assets: string } {
  mkdirSync(outdir, { recursive: true })
  ensureNativePackage(spec)

  const binary = join(outdir, spec.outfileName)
  if (existsSync(binary)) rmSync(binary)

  const args = ["build", "--compile", `--outfile=${binary}`, `--target=${spec.bunCompileTarget}`, ENTRY]
  console.log(`$ bun ${args.join(" ")}`)
  const r = spawnSync("bun", args, {
    cwd: TUI_ROOT,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "production" },
  })
  if (r.status !== 0) throw new Error(`bun build failed for ${spec.id}`)
  if (!existsSync(binary)) throw new Error(`Expected artifact missing: ${binary}`)
  chmodSync(binary, 0o755)

  const assetDirName = `assets-${spec.id}`
  const assets = join(outdir, assetDirName)
  stageOtuiAssetRoot(spec, assets)

  const launcherName =
    spec.platform === "windows"
      ? spec.outfileName.replace(/\.bin\.exe$/, ".cmd").replace(/\.bin$/, ".cmd")
      : spec.outfileName.replace(/\.bin$/, "")
  // public name without .bin
  const publicLauncher = join(
    outdir,
    spec.platform === "windows" ? `clawfix-tui-${spec.id}.cmd` : `clawfix-tui-${spec.id}`,
  )
  if (spec.platform === "windows") writeWindowsLauncher(publicLauncher, spec.outfileName, assetDirName)
  else writeUnixLauncher(publicLauncher, spec.outfileName, assetDirName)

  console.log(`Built binary ${binary}`)
  console.log(`Launcher ${publicLauncher}`)
  return { binary, launcher: publicLauncher, assets }
}

if (import.meta.main) {
  const { target, outdir } = parseArgs(process.argv.slice(2))
  buildTarget(TARGETS[target], outdir)
}
