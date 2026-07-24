#!/usr/bin/env bash
# ClawFix installer
# https://clawfix.dev
#
# WHAT THIS SCRIPT DOES:
#   1. Downloads a pinned clawfix package tarball over HTTPS
#   2. Verifies the integrity hash from the npm registry metadata
#   3. Installs into ~/.clawfix and writes ~/.local/bin/clawfix
#
# WHAT THIS SCRIPT DOES NOT DO:
#   ✗ Pipe remote content into a shell (do not pipe this file into a shell)
#   ✗ Require root or a global npm install
#   ✗ Modify OpenClaw config
#
# PREREQUISITES:
#   - Node.js 22+
#   - tar, mktemp, mkdir (standard on macOS/Linux)
#   - curl preferred for downloads; Node fetch is used if curl is missing
#   - openssl preferred for integrity; Node crypto is used if openssl is missing
#
# VERIFY BEFORE RUNNING:
#   curl --fail --show-error --silent --location https://clawfix.dev/install --output install-clawfix.sh
#   cat install-clawfix.sh
#   shasum -a 256 install-clawfix.sh
#   curl --fail --show-error --silent https://clawfix.dev/install/sha256
#   Compare the printed hashes exactly before running the script.
#   bash install-clawfix.sh
#
# Source: https://github.com/arcabotai/clawfix/blob/main/scripts/install.sh

set -euo pipefail

VERSION="${CLAWFIX_VERSION:-0.11.1}"
PREFIX="${CLAWFIX_PREFIX:-${HOME}/.clawfix}"
BIN_DIR="${CLAWFIX_BIN_DIR:-${HOME}/.local/bin}"
REGISTRY="${CLAWFIX_REGISTRY:-https://registry.npmjs.org}"
PACKAGE_NAME="${CLAWFIX_PACKAGE:-clawfix}"
MIN_NODE_MAJOR=22

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
CYAN=$'\033[0;36m'
NC=$'\033[0m'
BOLD=$'\033[1m'

log() { printf '%s\n' "$*"; }
info() { printf '%s%s%s\n' "$CYAN" "$*" "$NC"; }
ok() { printf '%s%s%s\n' "$GREEN" "$*" "$NC"; }
warn() { printf '%s%s%s\n' "$YELLOW" "$*" "$NC"; }
die() { printf '%s%s%s\n' "$RED" "$*" "$NC" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    node -e 'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));' "$1"
  fi
}

node_major() {
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || true
}

json_get() {
  # json_get <file> <js-expression-using-d>
  node -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const out = (function (d) { return ('"$2"'); })(d);
if (out === undefined || out === null || out === "") process.exit(2);
process.stdout.write(String(out));
' "$1"
}

download_url() {
  # download_url <url> <output-path>
  local url="$1"
  local out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl --fail --show-error --silent --location "$url" --output "$out"
    return 0
  fi
  # Node 22+ has global fetch — enough for npm registry / tarball downloads.
  node -e '
const fs = require("fs");
const url = process.argv[1];
const out = process.argv[2];
fetch(url).then(async (res) => {
  if (!res.ok) {
    console.error("HTTP " + res.status + " for " + url);
    process.exit(2);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(out, buf);
}).catch((err) => {
  console.error(String(err && err.message ? err.message : err));
  process.exit(3);
});
' "$url" "$out"
}

verify_sri() {
  # verify_sri <file> <sha512-<base64>>
  local file="$1"
  local integrity="$2"
  local algo b64 actual
  algo="${integrity%%-*}"
  b64="${integrity#*-}"
  [ "$algo" = "sha512" ] || die "Unsupported integrity algorithm: $algo"
  if command -v openssl >/dev/null 2>&1; then
    actual="$(openssl dgst -sha512 -binary "$file" | openssl base64 -A)"
  else
    actual="$(node -e '
const fs = require("fs");
const crypto = require("crypto");
const file = process.argv[1];
const digest = crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64");
process.stdout.write(digest);
' "$file")"
  fi
  [ "$actual" = "$b64" ] || die "Integrity check failed for $file"
}

main() {
  log ""
  info "${BOLD}🦞 ClawFix installer v${VERSION}${NC}"
  info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  log ""

  need_cmd tar
  need_cmd node
  need_cmd mktemp
  need_cmd mkdir

  if ! command -v curl >/dev/null 2>&1; then
    warn "⚠️  curl not found — using Node fetch for downloads"
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    warn "⚠️  openssl not found — using Node crypto for integrity checks"
  fi

  local major
  major="$(node_major)"
  [ -n "$major" ] || die "Node.js ${MIN_NODE_MAJOR}+ is required"
  if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
    die "Node.js ${MIN_NODE_MAJOR}+ is required (found $(node --version 2>/dev/null || echo unknown))"
  fi
  ok "✅ Node $(node --version)"

  local meta tarball extract_dir version_dir launcher
  CLEANUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/clawfix-install.XXXXXX")"
  tmp="$CLEANUP_DIR"
  trap 'rm -rf "${CLEANUP_DIR:-}"' EXIT

  meta="$tmp/package.json"
  tarball="$tmp/package.tgz"
  extract_dir="$tmp/extract"

  info "📦 Fetching package metadata for ${PACKAGE_NAME}@${VERSION}..."
  download_url "${REGISTRY%/}/${PACKAGE_NAME}/${VERSION}" "$meta"

  local tarball_url integrity resolved_version
  tarball_url="$(json_get "$meta" 'd.dist && d.dist.tarball')"
  integrity="$(json_get "$meta" 'd.dist && d.dist.integrity')"
  resolved_version="$(json_get "$meta" 'd.version')"
  [ "$resolved_version" = "$VERSION" ] || die "Registry returned version ${resolved_version}, expected ${VERSION}"

  info "⬇️  Downloading ${tarball_url}"
  download_url "$tarball_url" "$tarball"

  info "🔒 Verifying package integrity (${integrity%%-*})..."
  verify_sri "$tarball" "$integrity"
  ok "✅ Package integrity verified"
  log "   sha256 $(sha256_file "$tarball")"

  mkdir -p "$extract_dir"
  tar -xzf "$tarball" -C "$extract_dir"
  [ -d "$extract_dir/package" ] || die "Unexpected tarball layout (missing package/)"

  version_dir="${PREFIX}/versions/${VERSION}"
  mkdir -p "${PREFIX}/versions"
  rm -rf "$version_dir"
  mkdir -p "$version_dir"
  # portable copy of extracted package tree
  tar -C "$extract_dir/package" -cf - . | tar -C "$version_dir" -xf -

  [ -f "$version_dir/bin/clawfix.js" ] || die "Installed package is missing bin/clawfix.js"

  mkdir -p "$BIN_DIR"
  launcher="${BIN_DIR}/clawfix"
  cat >"$launcher" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec node "${version_dir}/bin/clawfix.js" "\$@"
EOF
  chmod 755 "$launcher"

  # convenience current symlink
  ln -sfn "$version_dir" "${PREFIX}/current"

  ok "✅ Installed clawfix ${VERSION}"
  log "   Prefix:  $PREFIX"
  log "   Version: $version_dir"
  log "   Binary:  $launcher"
  log ""

  case ":${PATH}:" in
    *":${BIN_DIR}:"*) ;;
    *)
      warn "⚠️  ${BIN_DIR} is not on PATH"
      log "   Add this to your shell profile:"
      log "     export PATH=\"${BIN_DIR}:\$PATH\""
      log ""
      ;;
  esac

  if command -v clawfix >/dev/null 2>&1; then
    ok "✅ Ready: clawfix --version"
    clawfix --version || true
  else
    ok "✅ Ready: ${launcher} --version"
    "$launcher" --version || true
  fi

  log ""
  info "Next:"
  log "  clawfix --dry-run"
  log "  clawfix"
  log ""
}

main "$@"
