import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync, chmodSync, copyFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"

const version = "1.2.21"
const arch = process.arch === "arm64" ? "aarch64" : "x64"
const url = `https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-linux-${arch}.zip`
const zipPath = join(tmpdir(), `bun-${version}.zip`)
const install = process.env.BUN_INSTALL || join(process.env.HOME || "/root", ".bun")
mkdirSync(join(install, "bin"), { recursive: true })

const res = await fetch(url)
if (!res.ok) throw new Error(`download failed ${res.status} ${url}`)
writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()))

// Prefer Python stdlib zip extraction (no unzip/curl required on slim images).
execFileSync("python3", [
  "-c",
  "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
  zipPath,
  tmpdir(),
], { stdio: "inherit" })

const extracted = join(tmpdir(), `bun-linux-${arch}`, "bun")
const target = join(install, "bin", "bun")
copyFileSync(extracted, target)
chmodSync(target, 0o755)
console.log(`bun ${version} installed at ${target}`)
