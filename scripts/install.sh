#!/usr/bin/env bash
# ClawFix installer
# https://clawfix.dev
#
# Install:
#   curl -fsSL https://clawfix.dev/install.sh | bash
#
# The installer body lives in main(), and main is called on the last line.
# A truncated download cannot run a partial install.
#
# WHAT THIS SCRIPT DOES:
#   1. Downloads a pinned clawfix package tarball over HTTPS
#   2. Verifies the integrity hash from the npm registry metadata
#   3. Installs into ~/.clawfix and writes ~/.local/bin/clawfix
#   4. Re-runs safely, including upgrades to another pinned version
#
# WHAT THIS SCRIPT DOES NOT DO:
#   - Require root, sudo, or a global npm install
#   - Modify OpenClaw config
#   - Install Node.js
#
# PREREQUISITES:
#   - Node.js 22 or newer. OpenClaw requires a newer Node.js
#     (>=24.16.0 <25, or >=26.1.0). See the error text if node is missing.
#   - tar, mktemp, mkdir (standard on macOS and Linux)
#   - curl preferred for downloads; Node fetch is used if curl is missing
#   - openssl preferred for integrity; Node crypto is used if openssl is missing
#
# Prompts, when a terminal is available, are read from /dev/tty. A piped
# install keeps the script on stdin, so reading stdin would consume it.
# With no terminal, the installer continues without questions.
#
# SECURE ALTERNATIVE — download, verify, then run:
#   curl --fail --show-error --silent --location https://clawfix.dev/install.sh --output install-clawfix.sh
#   cat install-clawfix.sh
#   shasum -a 256 install-clawfix.sh
#   curl --fail --show-error --silent https://clawfix.dev/install.sh.sha256
#   Compare the printed hashes exactly before running the script.
#   bash install-clawfix.sh
#
# /install is an alias of /install.sh. /install/sha256 is an alias of
# /install.sh.sha256.
#
# Source: https://github.com/arcabotai/clawfix/blob/main/scripts/install.sh

set -euo pipefail

DEFAULT_VERSION="0.12.0"
VERSION="${CLAWFIX_VERSION:-$DEFAULT_VERSION}"
PREFIX="${CLAWFIX_PREFIX:-${HOME}/.clawfix}"
BIN_DIR="${CLAWFIX_BIN_DIR:-${HOME}/.local/bin}"
REGISTRY="${CLAWFIX_REGISTRY:-https://registry.npmjs.org}"
PACKAGE_NAME="${CLAWFIX_PACKAGE:-clawfix}"
MIN_NODE_MAJOR=22
DRY_RUN=0
NO_PROMPT=0
CLEANUP_DIR=""
STAGE_DIR=""

RED=''
GREEN=''
YELLOW=''
CYAN=''
NC=''
BOLD=''

log() { printf '%s\n' "$*"; }
info() { printf '%s%s%s\n' "$CYAN" "$*" "$NC"; }
ok() { printf '%s%s%s\n' "$GREEN" "$*" "$NC"; }
warn() { printf '%s%s%s\n' "$YELLOW" "$*" "$NC"; }
die() { printf '%s%s%s\n' "$RED" "$*" "$NC" >&2; exit 1; }

enable_color() {
  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    RED=$'\033[0;31m'
    GREEN=$'\033[0;32m'
    YELLOW=$'\033[1;33m'
    CYAN=$'\033[0;36m'
    NC=$'\033[0m'
    BOLD=$'\033[1m'
  fi
}

cleanup() {
  if [ -n "${CLEANUP_DIR}" ]; then
    rm -rf "${CLEANUP_DIR}"
  fi
  if [ -n "${STAGE_DIR}" ] && [ -d "${STAGE_DIR}" ]; then
    rm -rf "${STAGE_DIR}"
  fi
}

print_usage() {
  cat <<EOF
Usage: install.sh [--version [VERSION]] [--dry-run] [--no-prompt] [--help]

Install ClawFix ${DEFAULT_VERSION} into ~/.clawfix and write ~/.local/bin/clawfix.
Re-running the installer upgrades or reinstalls that prefix in place.

  --version            Print the package version this installer would install
  --version VERSION    Install VERSION instead of the pinned release
  --dry-run            Download and verify the tarball, then exit without writing
  --no-prompt          Do not ask questions, even on a terminal
  --help, -h           Show this help

Environment:
  CLAWFIX_VERSION      Package version to install
  CLAWFIX_PREFIX       Install prefix (default: ~/.clawfix)
  CLAWFIX_BIN_DIR      Launcher directory (default: ~/.local/bin)
  CLAWFIX_REGISTRY     npm registry (default: https://registry.npmjs.org)
  CLAWFIX_NO_PROMPT=1  Same as --no-prompt
  CLAWFIX_DRY_RUN=1    Same as --dry-run

Examples:
  curl -fsSL https://clawfix.dev/install.sh | bash
  curl -fsSL https://clawfix.dev/install.sh | bash -s -- --dry-run
  curl -fsSL https://clawfix.dev/install.sh | bash -s -- --version

Node.js ${MIN_NODE_MAJOR}+ is required. This installer does not install Node.js
and does not use sudo. OpenClaw requires Node.js >=24.16.0 <25, or >=26.1.0.
EOF
}

# A /dev/tty node can exist while open() fails with ENXIO. Probe the open.
has_controlling_tty() {
  [ -r /dev/tty ] && [ -w /dev/tty ] || return 1
  { : </dev/tty; } >/dev/null 2>&1 || return 1
  return 0
}

# A piped install leaves the script on stdin. Read answers from the terminal.
prompt_yes_no() {
  local prompt="$1"
  local answer=""
  if [ "$NO_PROMPT" -eq 1 ] || ! has_controlling_tty; then
    return 1
  fi
  printf '%s' "$prompt" >/dev/tty
  IFS= read -r answer </dev/tty || true
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

sha256_file() {
  local hash=""
  if command -v sha256sum >/dev/null 2>&1; then
    hash="$(sha256sum "$1" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    hash="$(shasum -a 256 "$1" | awk '{print $1}')"
  else
    hash="$(node -e 'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));' "$1")" \
      || die "sha256 fallback failed (need sha256sum, shasum, or working Node crypto)"
  fi
  [ -n "$hash" ] || die "sha256 produced empty digest for $1"
  printf '%s\n' "$hash"
}

node_major() {
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || true
}

node_required_message() {
  local found="$1"
  printf '%s\n' \
    "Node.js ${MIN_NODE_MAJOR} or newer is required to install ClawFix (found: ${found})." \
    "OpenClaw requires Node.js >=24.16.0 <25, or >=26.1.0 (Node.js 26 recommended)." \
    "See https://docs.openclaw.ai/install/node" \
    "An OpenClaw install already has a new enough Node.js. If node is missing here, that Node is not first on PATH." \
    "This installer does not install Node.js and does not use sudo." \
    "Install or select Node.js ${MIN_NODE_MAJOR} or newer, then rerun:" \
    "  curl -fsSL https://clawfix.dev/install.sh | bash" \
    "OpenClaw's installer can install a supported Node.js for you:" \
    "  curl -fsSL https://openclaw.ai/install.sh | bash"
}

require_node() {
  local found="" major=""
  if ! command -v node >/dev/null 2>&1; then
    found="not found"
  else
    found="$(node --version 2>/dev/null || true)"
    [ -n "$found" ] || found="unknown"
    major="$(node_major)"
    case "$major" in
      ''|*[!0-9]*) major="" ;;
    esac
  fi
  if [ -n "$major" ] && [ "$major" -ge "$MIN_NODE_MAJOR" ]; then
    ok "Node ${found}"
    return 0
  fi
  die "$(node_required_message "$found")"
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
  local loopback=0
  case "$url" in
    https://*) ;;
    http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*)
      loopback=1
      ;;
    *) die "Refusing non-HTTPS download URL: $url" ;;
  esac
  if command -v curl >/dev/null 2>&1; then
    if [ "$loopback" -eq 1 ]; then
      curl --fail --show-error --silent --location \
        --connect-timeout 20 --max-time 120 \
        "$url" --output "$out"
    else
      curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 \
        --connect-timeout 20 --max-time 120 \
        "$url" --output "$out"
    fi
    return 0
  fi
  # Node 22+ has global fetch. The body is written to a file, never piped to a shell.
  node -e '
const fs = require("fs");
const { URL } = require("url");
const url = process.argv[1];
const out = process.argv[2];
const part = out + ".part";
const timeoutMs = 120000;
(async () => {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    console.error("Refusing non-HTTPS URL: " + url);
    process.exit(2);
  }
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    console.error("HTTP " + res.status + " for " + url);
    process.exit(2);
  }
  if (res.url) {
    const finalUrl = new URL(res.url);
    const fh = finalUrl.hostname;
    const floop = fh === "127.0.0.1" || fh === "localhost" || fh === "::1";
    if (finalUrl.protocol !== "https:" && !(finalUrl.protocol === "http:" && floop)) {
      console.error("Refusing non-HTTPS redirect target: " + res.url);
      process.exit(2);
    }
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(part, buf);
  fs.renameSync(part, out);
})().catch((err) => {
  try { fs.unlinkSync(part); } catch {}
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
    actual="$(openssl dgst -sha512 -binary "$file" | openssl base64 -A)" \
      || die "openssl integrity check failed"
  else
    actual="$(node -e '
const fs = require("fs");
const crypto = require("crypto");
const file = process.argv[1];
const digest = crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64");
process.stdout.write(digest);
' "$file")" || die "Node crypto integrity check failed"
  fi
  [ -n "$actual" ] || die "Empty integrity digest for $file"
  [ "$actual" = "$b64" ] || die "Integrity check failed for $file"
}

valid_version() {
  case "$1" in
    *[!0-9A-Za-z.+-]*) return 1 ;;
  esac
  case "$1" in
    [0-9]*.[0-9]*.[0-9]*) return 0 ;;
    *) return 1 ;;
  esac
}

parse_args() {
  local show_version=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --help|-h)
        print_usage
        exit 0
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --no-prompt)
        NO_PROMPT=1
        shift
        ;;
      --version)
        if [ "$#" -ge 2 ] && [ "${2#-}" = "$2" ]; then
          valid_version "$2" || die "Invalid version: $2"
          VERSION="$2"
          shift 2
        else
          show_version=1
          shift
        fi
        ;;
      *)
        printf 'Unknown option: %s\n' "$1" >&2
        print_usage >&2
        exit 2
        ;;
    esac
  done
  if [ "$show_version" -eq 1 ]; then
    printf 'clawfix-installer %s\n' "$VERSION"
    exit 0
  fi
}

print_path_guidance() {
  local shell_name="${SHELL:-bash}"
  shell_name="${shell_name##*/}"
  warn "${BIN_DIR} is not on PATH"
  log "This directory was not on PATH when the installer started."
  log "For this shell, run:"
  case "$shell_name" in
    fish)
      printf '  set -gx PATH "%s" $PATH\n' "$BIN_DIR"
      log "Bash/zsh:"
      printf '  export PATH="%s:$PATH"; hash -r\n' "$BIN_DIR"
      ;;
    *)
      printf '  export PATH="%s:$PATH"; hash -r\n' "$BIN_DIR"
      log "Fish:"
      printf '  set -gx PATH "%s" $PATH\n' "$BIN_DIR"
      ;;
  esac
  log "Open a new terminal, or add that line to your shell startup file."
}

persist_shell_path() {
  local shell_name rc line
  case "$BIN_DIR" in
    *[!A-Za-z0-9._~/-]*)
      warn "Bin directory contains unusual characters; shell startup file left unchanged"
      return 0
      ;;
  esac
  shell_name="${SHELL:-bash}"
  shell_name="${shell_name##*/}"
  case "$shell_name" in
    zsh) rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
    fish) rc="${HOME}/.config/fish/config.fish" ;;
    bash|sh) rc="${HOME}/.bashrc" ;;
    *)
      log "Shell startup files were not changed."
      return 0
      ;;
  esac
  if [ -f "$rc" ] && grep -F -q "ClawFix command" "$rc"; then
    log "PATH entry already recorded in ${rc}"
    return 0
  fi
  mkdir -p "$(dirname "$rc")"
  if [ "$shell_name" = "fish" ]; then
    line="fish_add_path \"${BIN_DIR}\""
  else
    line="case \":\$PATH:\" in *\":${BIN_DIR}:\"*) ;; *) export PATH=\"${BIN_DIR}:\$PATH\" ;; esac"
  fi
  printf '\n# ClawFix command\n%s\n' "$line" >>"$rc"
  ok "Added ${BIN_DIR} to PATH in ${rc}"
  log "Open a new terminal, or run the export line above for this shell."
}

install_tree() {
  local version_dir="$1"
  local extract_dir="$2"
  local stage="${version_dir}.partial"
  local backup="${version_dir}.prev"
  STAGE_DIR="$stage"
  rm -rf "$stage"
  mkdir -p "$stage"
  tar -C "$extract_dir/package" -cf - . | tar -C "$stage" -xf -
  [ -f "$stage/bin/clawfix.js" ] || die "Installed package is missing bin/clawfix.js"
  rm -rf "$backup"
  if [ -d "$version_dir" ]; then
    mv "$version_dir" "$backup"
  fi
  if ! mv "$stage" "$version_dir"; then
    if [ -d "$backup" ]; then
      mv "$backup" "$version_dir" || true
    fi
    STAGE_DIR=""
    die "Could not move the package into ${version_dir}"
  fi
  STAGE_DIR=""
  rm -rf "$backup"
}

write_launcher() {
  local launcher="$1"
  local version_dir="$2"
  local tmp="${launcher}.tmp"
  cat >"$tmp" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec node "${version_dir}/bin/clawfix.js" "\$@"
EOF
  chmod 755 "$tmp"
  mv -f "$tmp" "$launcher"
}

main() {
  local show_path_prompt=0
  enable_color
  if [ "${CLAWFIX_DRY_RUN:-0}" = "1" ]; then
    DRY_RUN=1
  fi
  if [ "${CLAWFIX_NO_PROMPT:-0}" = "1" ]; then
    NO_PROMPT=1
  fi
  parse_args "$@"

  log ""
  info "${BOLD}ClawFix installer v${VERSION}${NC}"
  info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  log ""

  need_cmd tar
  need_cmd mktemp
  need_cmd mkdir
  require_node

  if ! command -v curl >/dev/null 2>&1; then
    warn "curl not found — using Node fetch for downloads"
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    warn "openssl not found — using Node crypto for integrity checks"
  fi

  local meta tarball extract_dir version_dir launcher command_hint
  local tarball_url integrity resolved_version previous had_launcher
  CLEANUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/clawfix-install.XXXXXX")"
  trap cleanup EXIT
  meta="${CLEANUP_DIR}/package.json"
  tarball="${CLEANUP_DIR}/package.tgz"
  extract_dir="${CLEANUP_DIR}/extract"

  info "Fetching package metadata for ${PACKAGE_NAME}@${VERSION}..."
  download_url "${REGISTRY%/}/${PACKAGE_NAME}/${VERSION}" "$meta"

  tarball_url="$(json_get "$meta" 'd.dist && d.dist.tarball')"
  integrity="$(json_get "$meta" 'd.dist && d.dist.integrity')"
  resolved_version="$(json_get "$meta" 'd.version')"
  [ "$resolved_version" = "$VERSION" ] || die "Registry returned version ${resolved_version}, expected ${VERSION}"

  info "Downloading ${tarball_url}"
  download_url "$tarball_url" "$tarball"

  info "Verifying package integrity (${integrity%%-*})..."
  verify_sri "$tarball" "$integrity"
  ok "Package integrity verified"
  log "   sha256 $(sha256_file "$tarball")"

  mkdir -p "$extract_dir"
  tar -xzf "$tarball" -C "$extract_dir"
  [ -d "$extract_dir/package" ] || die "Unexpected tarball layout (missing package/)"

  version_dir="${PREFIX}/versions/${VERSION}"
  launcher="${BIN_DIR}/clawfix"
  command_hint="$launcher"
  previous=""
  had_launcher=0
  if [ -e "$launcher" ]; then
    had_launcher=1
  fi
  if [ -L "${PREFIX}/current" ]; then
    previous="$(basename "$(readlink "${PREFIX}/current")")"
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    ok "Dry run complete. Package integrity verified. No files were changed."
    log "   Would install: ${version_dir}"
    log "   Would write:   ${launcher}"
    case ":${PATH}:" in
      *":${BIN_DIR}:"*) ;;
      *) print_path_guidance ;;
    esac
    log ""
    log "Next, after a real install:"
    log "  ${command_hint} --version"
    log "  ${command_hint} --dry-run"
    log ""
    return 0
  fi

  mkdir -p "${PREFIX}/versions" "$BIN_DIR"
  install_tree "$version_dir" "$extract_dir"
  write_launcher "$launcher" "$version_dir"
  ln -sfn "$version_dir" "${PREFIX}/current"

  if [ -n "$previous" ] && [ "$previous" != "$VERSION" ]; then
    ok "Upgraded clawfix ${previous} to ${VERSION}"
  elif [ "$had_launcher" -eq 1 ] || [ -n "$previous" ]; then
    ok "Reinstalled clawfix ${VERSION}"
  else
    ok "Installed clawfix ${VERSION}"
  fi
  log "   Prefix:  ${PREFIX}"
  log "   Version: ${version_dir}"
  log "   Binary:  ${launcher}"
  log ""

  case ":${PATH}:" in
    *":${BIN_DIR}:"*)
      if [ "$(command -v clawfix 2>/dev/null || true)" = "$launcher" ]; then
        command_hint="clawfix"
      fi
      ;;
    *)
      show_path_prompt=1
      print_path_guidance
      ;;
  esac

  if [ "$show_path_prompt" -eq 1 ]; then
    if prompt_yes_no "Add ${BIN_DIR} to your shell startup file so clawfix stays on PATH? [y/N] "; then
      persist_shell_path
    fi
  fi

  ok "Verifying installed binary: ${launcher} --version"
  "$launcher" --version || die "Installed ClawFix failed its version check"

  log ""
  info "Next:"
  log "  ${command_hint} --dry-run"
  log "  ${command_hint}"
  log ""
}

# Call main only after the whole file has been read. A truncated piped
# download stops before this line and cannot run a partial install.
main "$@"
