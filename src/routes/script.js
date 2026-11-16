import { Router } from 'express';
import { createHash } from 'node:crypto';

export const scriptRouter = Router();

// Serve the diagnostic script for download, review, and local execution.
scriptRouter.get('/fix', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('X-Script-SHA256', SCRIPT_HASH);
  res.send(DIAGNOSTIC_SCRIPT);
});

// Script hash endpoint for verification
scriptRouter.get('/fix/sha256', (req, res) => {
  res.json({
    sha256: SCRIPT_HASH,
    verify: 'curl --fail --show-error --silent --location https://clawfix.dev/fix --output clawfix.sh && shasum -a 256 clawfix.sh',
    note: 'Compare the printed hashes exactly before running the script. GitHub reference: https://github.com/arcabotai/clawfix/blob/main/SCRIPT_HASH',
  });
});

const DIAGNOSTIC_SCRIPT = `#!/usr/bin/env bash
# ClawFix: OpenClaw diagnostics and guarded repairs
# https://clawfix.dev
# 
# WHAT THIS SCRIPT DOES:
#   1. Checks your OpenClaw installation (config, logs, plugins, ports)
#   2. Detects common issues via pattern matching
#   3. Optionally sends diagnostic data with recognized secrets redacted (asks first)
#
# WHAT THIS SCRIPT DOES NOT DO:
#   ✗ Modify any files
#   ✗ Send data without your explicit approval
#   ✗ Read workspace document contents (only checks existence and counts)
#   ✗ Send your real hostname (SHA-256 hashed)
#   The top-level config env block is omitted; recognized secrets elsewhere are redacted.
#
# VERIFY THIS SCRIPT:
#   curl --fail --show-error --silent --location https://clawfix.dev/fix --output clawfix.sh
#   cat clawfix.sh
#   shasum -a 256 clawfix.sh
#   curl --fail --show-error --silent https://clawfix.dev/fix/sha256
#   Compare the printed hashes exactly before running the script.
#   bash clawfix.sh
#
# PREFER NPX (auditable source on npm/GitHub):
#   npx clawfix                 # Interactive scan
#   npx clawfix --dry-run       # See what data would be collected
#
# Source code: https://github.com/arcabotai/clawfix

set -euo pipefail

# --- Config ---
API_URL="\${CLAWFIX_API:-https://clawfix.dev}"
VERSION="0.12.0"

# --- Colors ---
RED='\\033[0;31m'
GREEN='\\033[0;32m'
YELLOW='\\033[1;33m'
BLUE='\\033[0;34m'
CYAN='\\033[0;36m'
NC='\\033[0m'
BOLD='\\033[1m'

echo ""
echo -e "\${CYAN}🦞 ClawFix v\${VERSION}: OpenClaw Diagnostics and Guarded Repairs\${NC}"
echo -e "\${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\${NC}"
echo ""

# --- Check dependencies ---
for cmd in node npm jq curl; do
  if ! command -v "\$cmd" &>/dev/null; then
    echo -e "\${RED}❌ Missing: \$cmd\${NC}"
    echo "Please install \$cmd and try again."
    exit 1
  fi
done

# --- Detect OpenClaw ---
OPENCLAW_BIN=""
OPENCLAW_DIR=""
OPENCLAW_CONFIG=""

# Find openclaw binary
if command -v openclaw &>/dev/null; then
  OPENCLAW_BIN=\$(which openclaw)
elif [ -f "/opt/homebrew/bin/openclaw" ]; then
  OPENCLAW_BIN="/opt/homebrew/bin/openclaw"
elif [ -f "/usr/local/bin/openclaw" ]; then
  OPENCLAW_BIN="/usr/local/bin/openclaw"
fi

# Find config directory
if [ -d "\$HOME/.openclaw" ]; then
  OPENCLAW_DIR="\$HOME/.openclaw"
elif [ -d "\$HOME/.config/openclaw" ]; then
  OPENCLAW_DIR="\$HOME/.config/openclaw"
fi

# Find config file
if [ -n "\$OPENCLAW_DIR" ] && [ -f "\$OPENCLAW_DIR/openclaw.json" ]; then
  OPENCLAW_CONFIG="\$OPENCLAW_DIR/openclaw.json"
fi

if [ -z "\$OPENCLAW_BIN" ] && [ -z "\$OPENCLAW_DIR" ]; then
  echo -e "\${RED}❌ OpenClaw not found on this system.\${NC}"
  echo "Make sure OpenClaw is installed: https://openclaw.ai"
  exit 1
fi

echo -e "\${GREEN}✅ OpenClaw found\${NC}"
[ -n "\$OPENCLAW_BIN" ] && echo "   Binary: \$OPENCLAW_BIN"
[ -n "\$OPENCLAW_DIR" ] && echo "   Config: \$OPENCLAW_DIR"

# --- Collect System Info ---
echo ""
echo -e "\${BLUE}📋 Collecting system information...\${NC}"

OS_NAME=\$(uname -s)
OS_VERSION=\$(uname -r)
OS_ARCH=\$(uname -m)
NODE_VERSION=\$(node --version 2>/dev/null || echo "unknown")
NPM_VERSION=\$(npm --version 2>/dev/null || echo "unknown")
HOSTNAME_HASH=\$(hostname | shasum -a 256 | cut -c1-8)

# OpenClaw version. Show the printed line locally. The payload keeps only the
# version token from \`OpenClaw <version>\` or \`OpenClaw <version> (<commit>)\`.
# stderr is kept so an incomplete package can be recognized without a network call.
OC_VERSION_LINE=""
OC_VERSION_STDERR=""
if [ -n "\$OPENCLAW_BIN" ]; then
  OC_VERSION_ERR_FILE=\$(mktemp 2>/dev/null || true)
  if [ -n "\$OC_VERSION_ERR_FILE" ]; then
    OC_VERSION_LINE=\$("\$OPENCLAW_BIN" --version 2>"\$OC_VERSION_ERR_FILE" || echo "unknown")
    OC_VERSION_STDERR=\$(head -c 2000 "\$OC_VERSION_ERR_FILE" 2>/dev/null || true)
    rm -f "\$OC_VERSION_ERR_FILE"
  else
    OC_VERSION_LINE=\$("\$OPENCLAW_BIN" --version 2>/dev/null || echo "unknown")
  fi
fi

echo -e "   OS: \$OS_NAME \$OS_VERSION (\$OS_ARCH)"
echo -e "   Node: \$NODE_VERSION"
echo -e "   OpenClaw: \${OC_VERSION_LINE:-not found}"

OC_VERSION="\$OC_VERSION_LINE"
case "\$OC_VERSION" in
  "OpenClaw "*)
    OC_VERSION="\${OC_VERSION#OpenClaw }"
    OC_VERSION="\${OC_VERSION%% (*}"
    ;;
esac
OC_VERSION="\${OC_VERSION%%\$'\\n'*}"

# Global npm installs are {prefix}/bin/openclaw -> {prefix}/lib/node_modules/openclaw.
# pnpm, yarn, bun, source checkouts, and unknown layouts are recorded and not treated
# as incomplete. Home directories are replaced with ~ before the payload is built.
INSTALL_JSON=null
INSTALL_JSON=\$(node - "\$OC_VERSION_LINE" "\$OC_VERSION_STDERR" "\$OPENCLAW_BIN" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const versionLine = process.argv[2] || '';
const versionErr = process.argv[3] || '';
const fallbackBin = process.argv[4] || '';
const versionText = [versionLine, versionErr].filter(Boolean).join('\\n');
const home = process.env.HOME || '';
const pathEnv = process.env.PATH || '';

function blank(manager) {
  return {
    manager: manager,
    packageJson: false,
    binTarget: false,
    distEntry: false,
    pluginPathMissing: false,
    lifecycleIncomplete: false,
    packageRoot: null,
    version: null,
  };
}
function partsOf(filePath) {
  return path.normalize(filePath).split(path.sep).filter(Boolean);
}
function foreign(filePath) {
  for (const part of partsOf(filePath)) {
    if (part === '.pnpm' || part === 'pnpm') return 'pnpm';
    if (part === '.yarn' || part === 'yarn') return 'yarn';
    if (part === '.bun' || part === 'bun') return 'bun';
  }
  return null;
}
function lastRoot(filePath) {
  const normalized = path.normalize(filePath);
  if (!path.isAbsolute(normalized)) return null;
  const list = partsOf(normalized);
  let index = -1;
  for (let i = 0; i <= list.length - 3; i += 1) {
    if (list[i] === 'lib' && list[i + 1] === 'node_modules' && list[i + 2] === 'openclaw') index = i;
  }
  if (index < 0) return null;
  return path.sep + list.slice(0, index + 3).join(path.sep);
}
function inside(root, candidate) {
  const rootNorm = path.normalize(root);
  const cand = path.normalize(candidate);
  return cand === rootNorm || cand.startsWith(rootNorm + path.sep);
}
function redact(root) {
  let text = path.normalize(root);
  const homeNorm = home ? path.normalize(home) : '';
  if (homeNorm && homeNorm !== path.sep && (text === homeNorm || text.startsWith(homeNorm + path.sep))) {
    text = '~' + text.slice(homeNorm.length);
  }
  if (!/^~?(?:\\/[A-Za-z0-9._@+-]+)+$/.test(text)) return null;
  if (text.split('/').filter(Boolean).some(function (segment) { return segment === '.' || segment === '..'; })) return null;
  if (!text.endsWith('/lib/node_modules/openclaw')) return null;
  return text;
}
function isMissing(error) {
  return error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}
function lstat(file) {
  try { return { info: fs.lstatSync(file) }; }
  catch (error) { if (isMissing(error)) return { missing: true }; throw error; }
}
function regular(file) {
  const state = lstat(file);
  if (state.missing) return state;
  if (!state.info.isSymbolicLink()) return state;
  try {
    const target = fs.realpathSync(file);
    const followed = lstat(target);
    if (followed.missing) return followed;
    return { info: followed.info, target: target };
  } catch (error) {
    if (isMissing(error)) return { missing: true };
    throw error;
  }
}
function isFile(state) {
  return Boolean(state && state.info && state.info.isFile());
}
function sourceTree(root) {
  const markers = ['.git', 'src/entry.ts', 'pnpm-lock.yaml'];
  for (let i = 0; i < markers.length; i += 1) {
    if (!lstat(path.join(root, markers[i])).missing) return true;
  }
  return false;
}
function safeRelative(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 240 || path.isAbsolute(text) || text.indexOf('\\0') >= 0) return null;
  const list = text.split(/[\\\\/]+/).filter(Boolean);
  if (list.length === 0 || list.some(function (part) { return part === '.' || part === '..'; })) return null;
  return list.join(path.sep);
}
function parseStored(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64) return null;
  const legacy = /^([vV]?[0-9]+\\.[0-9]+\\.[0-9]+)\\.beta(?:\\.([0-9A-Za-z.-]+))?$/.exec(trimmed);
  const normalized = legacy ? (legacy[2] ? legacy[1].replace(/^[vV]/, '') + '-beta.' + legacy[2] : legacy[1].replace(/^[vV]/, '') + '-beta') : trimmed;
  const match = /^(?:[vV])?(\\d{4})\\.(\\d{1,2})\\.(\\d+)(?:-(alpha|beta)\\.(\\d+)|-(\\d+))?$/.exec(normalized);
  if (!match) return null;
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (minor < 1 || minor > 12 || patch < 1) return null;
  if (match[4]) return match[1] + '.' + minor + '.' + patch + '-' + match[4] + '.' + match[5];
  if (match[6]) return match[1] + '.' + minor + '.' + patch + '-' + match[6];
  return match[1] + '.' + minor + '.' + patch;
}
function parsePrinted(value) {
  if (typeof value !== 'string') return null;
  const line = value.trim().split(/\\r?\\n/, 1)[0].trim();
  const stored = parseStored(line);
  if (stored) return stored;
  const printed = /^OpenClaw\\s+(\\S+?)(?:\\s+\\([^)\\s]+\\))?$/.exec(line);
  return printed ? parseStored(printed[1]) : null;
}
function resolveBin(binPath, stat) {
  let current = binPath;
  let info = stat;
  for (let hop = 0; hop < 8 && info && info.isSymbolicLink(); hop += 1) {
    const target = fs.readlinkSync(current);
    if (typeof target !== 'string' || !target || target.length > 1024) return null;
    const next = path.normalize(path.isAbsolute(target) ? target : path.resolve(path.dirname(current), target));
    const nextState = lstat(next);
    if (nextState.missing) return next;
    current = next;
    info = nextState.info;
  }
  return info && info.isSymbolicLink() ? null : current;
}
function firstBin() {
  const dirs = String(pathEnv).split(':').filter(Boolean).slice(0, 64);
  const candidates = dirs.map(function (dir) { return path.join(dir, 'openclaw'); });
  if (fallbackBin && candidates.indexOf(fallbackBin) < 0) candidates.push(fallbackBin);
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (!candidate || candidate.length > 1024) continue;
    const state = lstat(candidate);
    if (!state.missing) return { path: candidate, info: state.info };
  }
  return null;
}
function readPackage(root) {
  const file = path.join(root, 'package.json');
  const state = regular(file);
  if (state.missing || !state.info.isFile() || state.info.size > 2000000) return { present: false };
  let rootReal = root;
  try { rootReal = fs.realpathSync(root); } catch (error) { if (!isMissing(error)) throw error; }
  const target = state.target || file;
  if (!inside(rootReal, target)) return { present: false };
  const text = fs.readFileSync(target, 'utf8');
  if (text.length > 2000000) return { present: false };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { present: false };
    if (parsed.name !== 'openclaw') return { present: true, named: false };
    const declared = typeof parsed.bin === 'string' ? parsed.bin : parsed.bin && parsed.bin.openclaw;
    return { present: true, named: true, version: parsed.version, binRelative: safeRelative(declared) || 'openclaw.mjs' };
  } catch (error) {
    return { present: false };
  }
}
function pluginMissing(root) {
  const pattern = /plugin path not found:\\s*([^\\s"'\`]+)/g;
  const found = [];
  let match = pattern.exec(versionText);
  while (match) {
    let text = match[1].trim();
    if (text.charAt(0) === '~' && home && home !== '/') text = path.normalize(home) + text.slice(1);
    if (path.isAbsolute(text)) {
      const normalized = path.normalize(text);
      if (inside(root, normalized) && normalized !== path.normalize(root)) found.push(normalized);
    }
    match = pattern.exec(versionText);
  }
  for (let i = 0; i < found.length; i += 1) {
    if (lstat(found[i]).missing) return true;
  }
  return false;
}
let record = null;
try {
  if (process.platform === 'win32') record = blank('unknown');
  else {
    const bin = firstBin();
    if (!bin) record = null;
    else {
      const location = resolveBin(bin.path, bin.info);
      if (!location) record = blank('unknown');
      else {
        const other = foreign(location) || foreign(bin.path);
        if (other) record = blank(other);
        else {
          const lexical = lastRoot(location);
          if (!lexical) record = (sourceTree(path.dirname(location)) || sourceTree(location)) ? blank('source') : blank('unknown');
          else if (path.normalize(bin.path) !== path.join(path.dirname(path.dirname(path.dirname(lexical))), 'bin', 'openclaw')) record = blank('unknown');
          else if (lstat(lexical).missing) {
            record = blank('npm');
            record.packageRoot = redact(lexical);
            record.version = parsePrinted(versionText);
            record.lifecycleIncomplete = /openclaw: package lifecycle is incomplete\\b/.test(versionText);
          } else {
            let realRoot = lexical;
            try { realRoot = path.normalize(fs.realpathSync(lexical)); } catch (error) { if (!isMissing(error)) throw error; }
            const realForeign = foreign(realRoot);
            if (realForeign) record = blank(realForeign);
            else if (lastRoot(realRoot) !== realRoot) record = sourceTree(realRoot) ? blank('source') : blank('unknown');
            else if (sourceTree(realRoot)) record = blank('source');
            else {
              const pkg = readPackage(realRoot);
              if (pkg.named === false) record = blank('unknown');
              else {
                const binRelative = pkg.binRelative || 'openclaw.mjs';
                record = blank('npm');
                record.packageJson = pkg.present === true && pkg.named === true;
                record.binTarget = isFile(regular(path.join(realRoot, binRelative)));
                record.distEntry = isFile(regular(path.join(realRoot, 'dist', 'entry.js'))) || isFile(regular(path.join(realRoot, 'dist', 'entry.mjs')));
                record.pluginPathMissing = pluginMissing(realRoot);
                record.lifecycleIncomplete = /openclaw: package lifecycle is incomplete\\b/.test(versionText);
                record.packageRoot = redact(lexical);
                record.version = parseStored(pkg.version) || parsePrinted(versionText);
              }
            }
          }
        }
      }
    }
  }
} catch (error) {
  record = null;
}
process.stdout.write(record ? JSON.stringify(record) : 'null');
NODE
) || true
if [ -z "\$INSTALL_JSON" ]; then
  INSTALL_JSON=null
fi

# OpenClaw's own update status --json reports the configured channel.
# Only the current version, the available version, the channel, and the boolean
# are kept. Paths, git metadata, registry errors, and run history stay local.
# The probe is killed after 30 seconds, the same bound as the other JSON checks.
UPDATE_JSON=null
if [ -n "\$OPENCLAW_BIN" ]; then
  UPDATE_JSON=\$(node - "\$OPENCLAW_BIN" "\$OC_VERSION" <<'NODE'
const { spawnSync } = require('node:child_process');

const bin = process.argv[2] || '';
const currentText = process.argv[3] || '';
const channels = { stable: true, beta: true, 'extended-stable': true };
const channelRank = { prerelease: 0, stable: 1, correction: 2 };
const labelRank = { alpha: 0, beta: 1 };

function decimal(text) {
  if (typeof text !== 'string' || !/^(?:0|[1-9]\\d*)$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function parseStored(value) {
  if (typeof value !== 'string') return null;
  let trimmed = value.trim();
  if (!trimmed || trimmed.length > 64 || trimmed.indexOf('+') >= 0) return null;
  const legacy = /^([vV]?[0-9]+\\.[0-9]+\\.[0-9]+)\\.beta(?:\\.([0-9A-Za-z.-]+))?$/.exec(trimmed);
  if (legacy) {
    const base = legacy[1].replace(/^[vV]/, '');
    trimmed = legacy[2] ? base + '-beta.' + legacy[2] : base + '-beta';
  }
  if (trimmed.length > 64 || trimmed.indexOf('+') >= 0) return null;
  const match = /^(?:[vV])?(\\d{4})\\.(\\d{1,2})\\.(\\d+)(?:-(alpha|beta)\\.(\\d+)|-(\\d+))?$/.exec(trimmed);
  if (!match) return null;
  const major = decimal(match[1]);
  const minor = decimal(match[2]);
  const patch = decimal(match[3]);
  if (major === null || minor === null || patch === null) return null;
  if (minor < 1 || minor > 12 || patch < 1) return null;
  if (match[4]) {
    const seq = decimal(match[5]);
    if (seq === null || seq < 1) return null;
    return {
      major: major,
      minor: minor,
      patch: patch,
      channel: 'prerelease',
      label: match[4],
      seq: seq,
      text: major + '.' + minor + '.' + patch + '-' + match[4] + '.' + seq,
    };
  }
  if (match[6]) {
    const seq = decimal(match[6]);
    if (seq === null || seq < 1) return null;
    return {
      major: major,
      minor: minor,
      patch: patch,
      channel: 'correction',
      label: null,
      seq: seq,
      text: major + '.' + minor + '.' + patch + '-' + seq,
    };
  }
  return {
    major: major,
    minor: minor,
    patch: patch,
    channel: 'stable',
    label: null,
    seq: null,
    text: major + '.' + minor + '.' + patch,
  };
}

function parsePrinted(value) {
  const direct = parseStored(value);
  if (direct) return direct;
  if (typeof value !== 'string') return null;
  const line = value.trim().split(/\\r?\\n/, 1)[0].trim();
  const printed = /^OpenClaw\\s+(\\S+?)(?:\\s+\\([^)\\s]+\\))?$/.exec(line);
  return printed ? parseStored(printed[1]) : null;
}

function compare(left, right) {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  if (left.channel !== right.channel) {
    return channelRank[left.channel] < channelRank[right.channel] ? -1 : 1;
  }
  if (left.channel === 'prerelease') {
    if (left.label !== right.label) {
      return labelRank[left.label] < labelRank[right.label] ? -1 : 1;
    }
    if (left.seq !== right.seq) return left.seq < right.seq ? -1 : 1;
  } else if (left.channel === 'correction' && left.seq !== right.seq) {
    return left.seq < right.seq ? -1 : 1;
  }
  return 0;
}

function fits(channel, version, tag) {
  const parsed = parseStored(version);
  if (!parsed || parsed.text !== version) return false;
  const prerelease = parsed.channel === 'prerelease';
  if (channel === 'stable') {
    return (tag == null || tag === 'latest') && !prerelease && parsed.patch < 33;
  }
  if (channel === 'extended-stable') {
    return tag === 'extended-stable' && !prerelease && parsed.patch >= 33;
  }
  if (channel !== 'beta' || tag == null || (parsed.patch >= 33 && !prerelease)) return false;
  if (tag === 'latest') return !prerelease;
  return tag === 'beta';
}

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function project(parsed, currentText) {
  if (!isRecord(parsed)) return null;
  const update = parsed.update;
  const channelInfo = parsed.channel;
  const availability = parsed.availability;
  if (!isRecord(update) || !isRecord(channelInfo) || !isRecord(availability)) return null;
  if (update.error || update.installKind !== 'package') return null;
  const registry = update.registry;
  if (!isRecord(registry) || registry.error || registry.reason) return null;
  const channel = channelInfo.value;
  if (!channels[channel]) return null;
  if (channelInfo.config != null && channelInfo.config !== channel) return null;
  const tag = registry.tag == null ? null : registry.tag;
  if (tag != null && typeof tag !== 'string') return null;
  const current = parsePrinted(currentText);
  if (!current) return null;
  const reportedAvailable = availability.available === true
    && availability.hasRegistryUpdate === true
    && availability.hasGitUpdate !== true;
  if (availability.available !== true && availability.available !== false) return null;
  const rawAvailable = reportedAvailable ? availability.latestVersion : registry.latestVersion;
  const available = parseStored(rawAvailable);
  if (!available || !fits(channel, available.text, tag)) return null;
  const comparison = compare(current, available);
  if (reportedAvailable) {
    if (comparison >= 0) return null;
    if (!parseStored(availability.latestVersion) || parseStored(availability.latestVersion).text !== available.text) {
      return null;
    }
  } else if (comparison < 0) {
    return null;
  }
  return {
    currentVersion: current.text,
    availableVersion: available.text,
    channel: channel,
    updateAvailable: reportedAvailable,
  };
}

let parsed = null;
if (bin) {
  const result = spawnSync(bin, ['update', 'status', '--json', '--timeout', '10'], {
    timeout: 30000,
    encoding: 'utf8',
    maxBuffer: 2000000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const status = result.status;
  const failed = Boolean(result.error) || result.signal != null || (status !== 0 && status !== 1);
  if (!failed && typeof result.stdout === 'string') {
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      parsed = null;
    }
  }
}
const projected = project(parsed, currentText);
process.stdout.write(projected ? JSON.stringify(projected) : 'null');
NODE
) || true
fi
if [ -z "\$UPDATE_JSON" ]; then
  UPDATE_JSON=null
fi

# --- Sanitize Config (REDACT RECOGNIZED SECRETS) ---
echo ""
echo -e "\${BLUE}🔒 Reading config (recognized secrets will be redacted)...\${NC}"

SANITIZED_CONFIG="{}"
CONFIG_EXISTS=false
if [ -n "\$OPENCLAW_CONFIG" ]; then
  CONFIG_EXISTS=true
  # Redact recognized secrets. Keep OpenClaw's public __OPENCLAW_REDACTED__
  # placeholder so a persisted marker stays distinguishable from ClawFix's
  # own ***REDACTED*** replacement.
  SANITIZED_CONFIG=\$(jq '
    def clawfix_redact:
      if . == "__OPENCLAW_REDACTED__" then .
      else "***REDACTED***"
      end;
    walk(
      if type == "string" then
        if . == "__OPENCLAW_REDACTED__" then .
        elif (length > 20 and (test("^(sk-|xai-|eyJ|ghp_|gho_|npm_|m0-|AIza|ntn_)") or test("^[A-Za-z0-9+/=]{40,}$"))) then
          "***REDACTED***"
        elif (length > 8 and test("(key|token|secret|password|jwt|apiKey|accessToken)"; "i")) then
          "***REDACTED***"
        else .
        end
      else .
      end
    )
    | del(.env)
    | if .gateway.auth then .gateway.auth.token |= clawfix_redact else . end
    | if .channels then (.channels | to_entries | map(.value.accessToken |= clawfix_redact | .value.apiKey |= clawfix_redact) | from_entries) as \$ch | .channels = \$ch else . end
  ' "\$OPENCLAW_CONFIG" 2>/dev/null || echo '{"error": "could not parse config"}')
  
  echo -e "\${GREEN}   ✅ Config read and sanitized\${NC}"
else
  echo -e "\${YELLOW}   ⚠️  No config file found\${NC}"
fi

# --- Check Gateway Status ---
echo ""
echo -e "\${BLUE}🔌 Checking gateway status...\${NC}"

GATEWAY_STATUS="unknown"
GATEWAY_PID=""
GATEWAY_PORT=""

if [ -n "\$OPENCLAW_BIN" ]; then
  GATEWAY_STATUS=\$("\$OPENCLAW_BIN" gateway status 2>&1 || echo "error")
fi

# A gateway started by \`openclaw gateway run\` re-execs with argv \`openclaw\`, so
# \`pgrep -f 'openclaw.*gateway'\` misses it and matches ClawFix's own
# \`openclaw gateway status\` instead. Transient CLI verbs are not the server.
# The listening port, checked below, remains the liveness verdict.
GATEWAY_PID=""
while IFS= read -r GATEWAY_PROCESS_LINE || [ -n "\$GATEWAY_PROCESS_LINE" ]; do
  [ -n "\$GATEWAY_PROCESS_LINE" ] || continue
  GATEWAY_CANDIDATE_PID=\${GATEWAY_PROCESS_LINE%% *}
  GATEWAY_CANDIDATE_CMD=\${GATEWAY_PROCESS_LINE#* }
  case "\$GATEWAY_CANDIDATE_PID" in
    ''|*[!0-9]*) continue ;;
  esac
  if [ "\$GATEWAY_CANDIDATE_PID" = "\$\$" ]; then
    continue
  fi
  if printf '%s\n' "\$GATEWAY_CANDIDATE_CMD" | grep -Eq '(^|[[:space:]])(gateway[[:space:]]+(status|restart|stop|logs|probe|health|diagnostics|stability|call|discover|install)|doctor|config)([[:space:]]|\$)|--version|(^|[[:space:]])(pgrep|grep|tail|less|cat)([[:space:]]|\$)|sh -c|bash -c|node .*clawfix'; then
    continue
  fi
  GATEWAY_PID=\$GATEWAY_CANDIDATE_PID
  break
done < <(pgrep -af openclaw 2>/dev/null || true)

# Try to detect port from config
if [ -n "\$OPENCLAW_CONFIG" ]; then
  GATEWAY_PORT=\$(jq -r '.gateway.port // 18789' "\$OPENCLAW_CONFIG" 2>/dev/null || echo "18789")
fi

# Check if port is actually listening (process may exist but be zombie/shutdown)
PORT_LISTENING=false
PROCESS_EXISTS=false
[ -n "\$GATEWAY_PID" ] && PROCESS_EXISTS=true
if lsof -i ":\${GATEWAY_PORT:-18789}" &>/dev/null 2>&1 || ss -tlnp 2>/dev/null | grep -q ":\${GATEWAY_PORT:-18789} "; then
  PORT_LISTENING=true
fi

# --- Check Service Manager ---
echo ""
echo -e "\${BLUE}🔧 Checking service manager...\${NC}"

SERVICE_MANAGER="none"
SERVICE_STATE=""
SERVICE_EXIT_CODE=""
SERVICE_RUNS=""
SERVICE_PID=""

if [ "\$OS_NAME" = "Darwin" ]; then
  SERVICE_MANAGER="launchd"
  LAUNCHCTL_OUT=\$(launchctl list 2>/dev/null | grep -i openclaw || echo "")
  if [ -n "\$LAUNCHCTL_OUT" ]; then
    SERVICE_PID=\$(echo "\$LAUNCHCTL_OUT" | awk '{print \$1}')
    SERVICE_EXIT_CODE=\$(echo "\$LAUNCHCTL_OUT" | awk '{print \$2}')
    # Exit code -15 = SIGTERM, -1 = last run failed
    if [ "\$SERVICE_EXIT_CODE" = "-15" ]; then
      SERVICE_STATE="sigterm"
      echo -e "   \${RED}⚠️  Service received SIGTERM (exit -15) — possible crash loop or forced kill\${NC}"
    elif [ "\$SERVICE_EXIT_CODE" = "0" ] && [ "\$SERVICE_PID" != "-" ]; then
      SERVICE_STATE="running"
      echo -e "   \${GREEN}✅ launchd: running (pid \$SERVICE_PID)\${NC}"
    elif [ "\$SERVICE_PID" = "-" ] && [ "\$SERVICE_EXIT_CODE" != "0" ]; then
      SERVICE_STATE="crashed"
      echo -e "   \${RED}❌ launchd: not running (last exit: \$SERVICE_EXIT_CODE)\${NC}"
    else
      SERVICE_STATE="unknown"
      echo -e "   \${YELLOW}⚠️  launchd state unclear: \$LAUNCHCTL_OUT\${NC}"
    fi
    # Get ThrottleInterval / runs if plist exists
    PLIST_PATH="\$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
    if [ -f "\$PLIST_PATH" ]; then
      SERVICE_RUNS=\$(defaults read "\$PLIST_PATH" ThrottleInterval 2>/dev/null || echo "")
      echo -e "   plist: \$PLIST_PATH"
    fi
  else
    SERVICE_STATE="not_registered"
    echo -e "   \${YELLOW}⚠️  No openclaw LaunchAgent found in launchctl\${NC}"
  fi
elif command -v systemctl &>/dev/null; then
  SERVICE_MANAGER="systemd"
  SYSTEMCTL_OUT=\$(systemctl status openclaw-gateway 2>/dev/null | head -10 || echo "")
  if echo "\$SYSTEMCTL_OUT" | grep -q "active (running)"; then
    SERVICE_STATE="running"
    echo -e "   \${GREEN}✅ systemd: active (running)\${NC}"
  elif echo "\$SYSTEMCTL_OUT" | grep -q "failed"; then
    SERVICE_STATE="failed"
    SERVICE_EXIT_CODE=\$(echo "\$SYSTEMCTL_OUT" | grep -oP 'status=\K[0-9/]+' || echo "?")
    echo -e "   \${RED}❌ systemd: failed (exit \$SERVICE_EXIT_CODE)\${NC}"
  elif echo "\$SYSTEMCTL_OUT" | grep -q "inactive"; then
    SERVICE_STATE="inactive"
    echo -e "   \${YELLOW}⚠️  systemd: inactive (stopped)\${NC}"
  fi
  SERVICE_RUNS=\$(systemctl show openclaw-gateway --property=NRestarts 2>/dev/null | cut -d= -f2 || echo "0")
else
  echo -e "   No service manager detected"
fi

echo -e "   Status: \$GATEWAY_STATUS"
[ -n "\$GATEWAY_PID" ] && echo -e "   PID: \$GATEWAY_PID (exists: \$PROCESS_EXISTS)"
echo -e "   Port: \${GATEWAY_PORT:-18789} (listening: \$PORT_LISTENING)"

# --- Check Logs ---
echo ""
echo -e "\${BLUE}📜 Reading recent logs...\${NC}"

GATEWAY_LOG=""
ERROR_LOG=""
SIGTERM_COUNT=0

if [ -f "\$OPENCLAW_DIR/logs/gateway.log" ]; then
  GATEWAY_LOG=\$(tail -500 "\$OPENCLAW_DIR/logs/gateway.log" 2>/dev/null | grep -Ei 'error|warn|fail|crash|EADDRINUSE|EACCES|Legacy workspace setup state requires migration|legacy workspace setup conflicts with canonical SQLite state|missing or drifted index idx_agent_session_nodes_active|Legacy session store requires migration|sessions\\.json|Stopped the managed Gateway for Doctor repair|SQLite read-only snapshot|sqlite-source-revision|content-version|process census is incomplete|undergoing offline maintenance|Doctor interrupted by SIGTERM|CLI signal cleanup did not complete|Doctor complete|Gateway restarted and verified|invalid-config|Unrecognized key|HEARTBEAT.md cannot be migrated|HEARTBEAT.md was not migrated|symlink target escapes the agent workspace|heartbeat-migration|requires Node|detected Node|detected: Node|is unsupported|preflight-node-runtime|Active Gateway runtime|Node\\.js|owns this state directory|owns state-lifecycle|GatewayLockError|OPENCLAW_STATE_LEASE_ABORTED|state ownership is no longer current|cannot verify Gateway ownership|gateway\\.auth REMOVED|config reload: gateway\\.auth\\.mode|AUTH_PROFILE_MIGRATION_REQUIRED|requires legacy credential migration|without replaying credentials|withheld-cross-device|device token mismatch|stale device-token pattern|MemorySearch timed out after 15s|memory-lancedb embedding timed out|memory_search|reindex-lock\\.sqlite' | tail -30 || echo "")
  echo -e "   \${GREEN}✅ Gateway log found (\$(wc -l < "\$OPENCLAW_DIR/logs/gateway.log" | tr -d ' ') lines)\${NC}"
fi

ERR_LOG_SIZE_MB=0
HANDSHAKE_TIMEOUT_COUNT=0
if [ -f "\$OPENCLAW_DIR/logs/gateway.err.log" ]; then
  ERROR_LOG=\$(tail -50 "\$OPENCLAW_DIR/logs/gateway.err.log" 2>/dev/null || echo "")
  # Collect metrics about the error log
  ERR_LOG_SIZE_MB=\$(du -sm "\$OPENCLAW_DIR/logs/gateway.err.log" 2>/dev/null | awk '{print \$1}' || echo "0")
  HANDSHAKE_TIMEOUT_COUNT=\$(grep -c "invalid handshake\\|closed before connect\\|chrome-extension.*timeout" "\$OPENCLAW_DIR/logs/gateway.err.log" 2>/dev/null || echo "0")
  # Also scan for SIGTERM events in gateway log
  SIGTERM_COUNT=\$(grep -c "signal SIGTERM received\\|exit code -15" "\$OPENCLAW_DIR/logs/gateway.log" 2>/dev/null || echo "0")
  if [ "\$ERR_LOG_SIZE_MB" -gt 10 ]; then
    echo -e "   \${YELLOW}⚠️  Error log is \${ERR_LOG_SIZE_MB}MB (large — likely log spam)\${NC}"
  else
    echo -e "   \${GREEN}✅ Error log found (\${ERR_LOG_SIZE_MB}MB)\${NC}"
  fi
  [ "\$HANDSHAKE_TIMEOUT_COUNT" -gt 0 ] && echo -e "   \${YELLOW}⚠️  \$HANDSHAKE_TIMEOUT_COUNT handshake timeout lines (browser relay spam?)\${NC}"
  [ "\$SIGTERM_COUNT" -gt 0 ] && echo -e "   \${YELLOW}⚠️  \$SIGTERM_COUNT SIGTERM events in gateway log\${NC}"
fi

# --- Check Plugins ---
echo ""
echo -e "\${BLUE}🔌 Checking plugins...\${NC}"

PLUGINS_STATUS=""
if [ -n "\$OPENCLAW_CONFIG" ]; then
  PLUGINS_STATUS=\$(jq -r '
    .plugins.entries // {} | to_entries[] |
    "   " + (if .value.enabled == false then "❌" else "✅" end) + " " + .key
  ' "\$OPENCLAW_CONFIG" 2>/dev/null || echo "   Could not read plugins")
  echo "\$PLUGINS_STATUS"
fi

# --- Check Browser ---
echo ""
echo -e "\${BLUE}🌐 Checking browser setup...\${NC}"

BROWSER_DIR="\$OPENCLAW_DIR/browser"
BROWSER_STATUS="not configured"
if [ -d "\$BROWSER_DIR" ]; then
  BROWSER_STATUS="configured"
  [ -d "\$BROWSER_DIR/openclaw/user-data" ] && echo -e "   \${GREEN}✅ Managed browser profile found\${NC}"
  [ -d "\$BROWSER_DIR/chrome-extension" ] && echo -e "   \${GREEN}✅ Relay extension found\${NC}"
  [ -d "\$BROWSER_DIR/metamask-extension" ] && echo -e "   \${GREEN}✅ MetaMask extension found\${NC}"
fi

# --- Check Workspace ---
echo ""
echo -e "\${BLUE}📁 Checking workspace...\${NC}"

WORKSPACE_DIR=""
if [ -n "\$OPENCLAW_CONFIG" ]; then
  WORKSPACE_DIR=\$(jq -r '.agents.defaults.workspace // ""' "\$OPENCLAW_CONFIG" 2>/dev/null)
fi

WORKSPACE_FILES=0
MEMORY_FILES=0
SOUL_EXISTS=false
AGENTS_EXISTS=false

if [ -n "\$WORKSPACE_DIR" ] && [ -d "\$WORKSPACE_DIR" ]; then
  WORKSPACE_FILES=\$(find "\$WORKSPACE_DIR" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  [ -d "\$WORKSPACE_DIR/memory" ] && MEMORY_FILES=\$(ls "\$WORKSPACE_DIR/memory/"*.md 2>/dev/null | wc -l | tr -d ' ')
  [ -f "\$WORKSPACE_DIR/SOUL.md" ] && SOUL_EXISTS=true
  [ -f "\$WORKSPACE_DIR/AGENTS.md" ] && AGENTS_EXISTS=true
  
  echo -e "   Path: \$WORKSPACE_DIR"
  echo -e "   Files: \$WORKSPACE_FILES .md files"
  echo -e "   Memory: \$MEMORY_FILES daily notes"
  echo -e "   SOUL.md: \$SOUL_EXISTS"
  echo -e "   AGENTS.md: \$AGENTS_EXISTS"
fi

# HEARTBEAT.md is copied into cron scratch, which refuses more than 262144 bytes
# and invalid UTF-8 (openclaw src/cron/scratch-contract.ts:2 and :93-99).
HEARTBEAT_FILE_JSON=null
if [ -n "\$WORKSPACE_DIR" ] && [ -f "\$WORKSPACE_DIR/HEARTBEAT.md" ]; then
  HEARTBEAT_FILE_JSON=\$(node - "\$WORKSPACE_DIR/HEARTBEAT.md" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const MAX_BYTES = 262144;
try {
  const info = fs.lstatSync(file);
  if (!info.isFile()) {
    process.stdout.write('null');
  } else {
    const bytes = info.size;
    let utf8 = null;
    if (Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= MAX_BYTES) {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
        utf8 = true;
      } catch (error) {
        utf8 = false;
      }
    }
    process.stdout.write(JSON.stringify({ bytes: bytes, utf8: utf8 }));
  }
} catch (error) {
  process.stdout.write('null');
}
NODE
) || true
fi
if [ -z "\$HEARTBEAT_FILE_JSON" ]; then
  HEARTBEAT_FILE_JSON=null
fi

# --- Check Ports ---
echo ""
echo -e "\${BLUE}🔗 Checking port availability...\${NC}"

check_port() {
  local port=\$1
  local name=\$2
  if lsof -i ":\$port" &>/dev/null 2>&1 || ss -tlnp 2>/dev/null | grep -q ":\$port "; then
    echo -e "   \${YELLOW}⚠️  Port \$port (\$name) — IN USE\${NC}"
    return 1
  else
    echo -e "   \${GREEN}✅ Port \$port (\$name) — available\${NC}"
    return 0
  fi
}

check_port "\${GATEWAY_PORT:-18789}" "gateway"
check_port 18800 "browser CDP"
check_port 18791 "browser control"

# OpenClaw doctor --lint is read-only. Hosted diagnosis allows 120 seconds
# (openclaw src/commands/doctor-process.ts). A timeout is a collector state,
# not an OpenClaw finding, even if the killed process wrote partial JSON.
DOCTOR_JSON=null
if [ -n "\$OPENCLAW_BIN" ]; then
  DOCTOR_JSON=\$(node - "\$OPENCLAW_BIN" "\${GATEWAY_PORT:-18789}" "\$PORT_LISTENING" <<'NODE'
const { spawn } = require('node:child_process');
const { homedir } = require('node:os');
const net = require('node:net');

const bin = process.argv[2] || '';
const gatewayPort = Number(process.argv[3]);
const wasListening = process.argv[4] === 'true';
const DOCTOR_TIMEOUT_MS = 120000;
const DOCTOR_KILL_GRACE_MS = 5000;
const doctorLimits = { timeout: DOCTOR_TIMEOUT_MS, killGraceMs: DOCTOR_KILL_GRACE_MS };
const home = homedir();

function clean(value, maxLength) {
  return String(value || '')
    .replace(/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
}

function cleanErrorCode(value) {
  const text = clean(value, 80);
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(text) ? text : '';
}

function cleanLine(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1000000 ? value : null;
}

function projectFinding(finding) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return null;
  const severity = finding.severity === 'info' || finding.severity === 'warning' || finding.severity === 'error'
    ? finding.severity
    : 'warning';
  const requirement = redact(clean(finding.requirement, 200));
  const errorCode = cleanErrorCode(finding.errorCode);
  const line = cleanLine(finding.line);
  const projected = {
    checkId: clean(finding.checkId, 200),
    severity: severity,
    message: redact(finding.message),
    path: redact(finding.path) || null,
    fixHint: redact(finding.fixHint || finding.remediation) || null,
  };
  if (requirement) projected.requirement = requirement;
  if (errorCode) projected.errorCode = errorCode;
  if (line !== null) projected.line = line;
  return projected;
}

function isEnvelope(parsed) {
  return parsed
    && typeof parsed === 'object'
    && !Array.isArray(parsed)
    && typeof parsed.ok === 'boolean'
    && Number.isSafeInteger(parsed.checksRun)
    && parsed.checksRun >= 0
    && Number.isSafeInteger(parsed.checksSkipped)
    && parsed.checksSkipped >= 0
    && Array.isArray(parsed.findings);
}

function isFailureEnvelope(parsed) {
  if (!isEnvelope(parsed) || parsed.ok !== false || parsed.status !== 'blocked') return false;
  if (parsed.checksRun !== 0 || parsed.checksSkipped !== 0 || parsed.findings.length !== 1) return false;
  const finding = parsed.findings[0];
  return finding
    && typeof finding === 'object'
    && finding.checkId === 'core/doctor/lint-inspection'
    && finding.severity === 'error';
}

function redact(value) {
  let text = clean(value, 2000);
  text = text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, '***REDACTED***')
    .replace(/\\b((?:https?|postgres(?:ql)?|mysql|mongodb(?:\\+srv)?):\\/\\/)([^\\s/@:]+):([^\\s/@]+)@/gi, '\$1***REDACTED***:***REDACTED***@')
    .replace(/\\b(?:sk(?:-or-v\\d+)?[-_]|xai[-_]|gh[pousr]_|npm_|m0[-_]|ntn_|xox[baprs]-)[A-Za-z0-9._-]{8,}\\b/gi, '***REDACTED***')
    .replace(/\\bAIza[A-Za-z0-9_-]{20,}\\b/g, '***REDACTED***')
    .replace(/((?:api[_-]?key|access[_-]?token|cookie|credential|jwt|password|secret|token)\\s*[=:]\\s*)(?:(['\"])[\\s\\S]*?\\2|[^\\s,;]+)/gi, '\$1***REDACTED***');
  if (home && home !== '/') text = text.split(home).join('~');
  return text;
}

function runChild(args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer = null;
    let killTimer = null;
    const finish = (status, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        status: status == null ? null : status,
        signal: signal || null,
        stdout,
        stderr,
        error: timedOut ? { code: 'ETIMEDOUT' } : null,
      });
    };
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (error) {
      resolve({ status: null, signal: null, stdout: '', stderr: String(error && error.message || ''), error, timedOut: false });
      return;
    }
    const signalChild = (signal) => {
      const pid = child && child.pid;
      if (!pid) return;
      try { process.kill(-pid, signal); return; } catch (error) {}
      try { process.kill(pid, signal); } catch (error) {}
    };
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 1000000) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8000) stderr += chunk;
    });
    child.on('error', () => finish(null, null));
    child.on('close', (status, signal) => finish(status, signal));
    timer = setTimeout(() => {
      timedOut = true;
      signalChild('SIGTERM');
      killTimer = setTimeout(() => signalChild('SIGKILL'), doctorLimits.killGraceMs);
    }, timeoutMs);
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      resolve(false);
      return;
    }
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(300);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const doctorArgs = [
  'doctor',
  '--lint',
  '--json',
  '--severity-min',
  'warning',
  '--skip',
  'core/doctor/skills-readiness',
  '--no-workspace-suggestions',
];

(async () => {
  const result = await runChild(doctorArgs, doctorLimits.timeout);
  let projected;
  if (result.error && result.error.code === 'ETIMEDOUT') {
    projected = {
      available: false,
      timedOut: true,
      state: 'timed out',
      checksRun: 0,
      checksSkipped: 0,
      findings: [],
    };
  } else {
    let parsed = null;
    if (typeof result.stdout === 'string' && result.stdout.trim()) {
      try {
        parsed = JSON.parse(result.stdout);
      } catch (error) {
        parsed = null;
      }
    }
    const failureEnvelope = isFailureEnvelope(parsed);
    const failed = Boolean(result.error)
      || result.signal != null
      || !((result.status === 0 || result.status === 1) || (result.status === 2 && failureEnvelope));
    const findings = isEnvelope(parsed)
      ? parsed.findings.slice(0, 100).map(projectFinding)
      : null;
    const warnings = isEnvelope(parsed) && Array.isArray(parsed.warnings)
      ? parsed.warnings.slice(0, 20).map(function (item) {
        return projectFinding(typeof item === 'string' ? { message: item, severity: 'info' } : item);
      }).filter(Boolean)
      : [];
    if (failed || !findings || findings.some(function (finding) { return !finding; })) {
      projected = {
        available: false,
        timedOut: false,
        checksRun: 0,
        checksSkipped: 0,
        findings: [],
      };
    } else {
      projected = {
        available: true,
        timedOut: false,
        ok: parsed.ok === true,
        checksRun: parsed.checksRun,
        checksSkipped: parsed.checksSkipped,
        findings: findings,
      };
      if (warnings.length) projected.warnings = warnings;
    }
  }
  if (wasListening) {
    const open = await portOpen(gatewayPort);
    if (!open) await runChild(['gateway', 'restart'], 60000);
  }
  process.stdout.write(JSON.stringify(projected));
})().catch(() => {
  process.stdout.write('null');
});
NODE
) || true
fi
if [ -z "\$DOCTOR_JSON" ]; then
  DOCTOR_JSON=null
fi

# Elapsed time only. Command text can contain paths and is not uploaded.
DOCTOR_PROCESSES_JSON=\$(node <<'NODE'
const { spawnSync } = require('node:child_process');
function parseElapsed(value) {
  if (/^\\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  const parts = String(value).split(/[-:]/).map(Number);
  if (parts.length < 2 || parts.length > 4 || parts.some((part) => !Number.isSafeInteger(part) || part < 0)) return null;
  const weights = parts.length === 2 ? [60, 1] : parts.length === 3 ? [3600, 60, 1] : [86400, 3600, 60, 1];
  return parts.reduce((total, part, index) => total + part * weights[index], 0);
}
function project(text) {
  const found = [];
  const skip = new Set([String(process.pid), String(process.ppid || '')]);
  for (const line of String(text || '').split('\\n')) {
    const match = /^\\s*(\\d+)\\s+(\\S+)\\s+(.*)$/.exec(line);
    if (!match) continue;
    if (skip.has(match[1])) continue;
    const command = match[3];
    if (!/(^|\\s)openclaw(\\s|$)/.test(command) || !/(^|\\s)doctor(\\s|$)/.test(command)) continue;
    if (/\\bclawfix\\b/.test(command)) continue;
    const elapsedSeconds = parseElapsed(match[2]);
    if (elapsedSeconds === null) continue;
    found.push({ elapsedSeconds: elapsedSeconds, fix: /(^|\\s)--fix(\\s|$)/.test(command) });
    if (found.length >= 8) break;
  }
  return found;
}
const attempts = [
  ['-eo', 'pid=,etimes=,args='],
  ['-axo', 'pid=,etime=,args='],
];
let projected = [];
for (const args of attempts) {
  const result = spawnSync('ps', args, { encoding: 'utf8', timeout: 5000 });
  if (result.error || result.status !== 0) continue;
  projected = project(result.stdout);
  if (projected.length > 0 || args[0] === '-axo') break;
}
process.stdout.write(JSON.stringify(projected));
NODE
)
if [ -z "\$DOCTOR_PROCESSES_JSON" ]; then
  DOCTOR_PROCESSES_JSON='[]'
fi

# A running session_windows row whose session_nodes entry is '{}' and
# entry_valid is -1 is omitted by sessions list and by doctor session inspect.
# openclaw src/config/sessions/session-canonical-row.ts:48-53.
STUCK_SESSION_WINDOWS_JSON=null
if [ -n "\$OPENCLAW_DIR" ] && [ -d "\$OPENCLAW_DIR/agents" ]; then
  STUCK_SESSION_WINDOWS_JSON=\$(node - "\$OPENCLAW_DIR/agents" <<'NODE'
const { readdirSync, lstatSync } = require('node:fs');
const { join } = require('node:path');
const agentsDir = process.argv[2];
const sql = "SELECT COUNT(*) AS count FROM session_windows AS window INNER JOIN session_nodes AS node ON node.session_key = window.session_key WHERE node.entry_json = '{}' AND node.entry_valid = -1 AND node.current_session_id = window.session_id AND window.status = 'running' AND window.ended_at IS NULL";
const agentId = /^[A-Za-z0-9_-]{1,64}$/;
const databases = [];
try {
  for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (databases.length >= 32) break;
    if (!entry.isDirectory() || !agentId.test(entry.name)) continue;
    const databasePath = join(agentsDir, entry.name, 'agent', 'openclaw-agent.sqlite');
    let info;
    try { info = lstatSync(databasePath); } catch (error) { continue; }
    if (!info.isFile()) continue;
    databases.push({ agentId: entry.name, databasePath: databasePath });
  }
} catch (error) {
  process.stdout.write('null');
  process.exit(0);
}
if (databases.length === 0) {
  process.stdout.write(JSON.stringify({ count: 0, agents: [] }));
  process.exit(0);
}
const originalEmitWarning = process.emitWarning;
process.emitWarning = function emitWarning(warning, type) {
  const message = typeof warning === 'string' ? warning : warning && warning.message;
  const name = typeof warning === 'string' ? type : warning && warning.name;
  if (name === 'ExperimentalWarning' && String(message).indexOf('SQLite is an experimental feature') !== -1) return;
  return originalEmitWarning.apply(process, arguments);
};
let DatabaseSync;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch (error) {
  process.stdout.write('null');
  process.exit(0);
} finally {
  process.emitWarning = originalEmitWarning;
}
let count = 0;
const agents = [];
try {
  for (const candidate of databases) {
    try {
      const database = new DatabaseSync(candidate.databasePath, { readOnly: true });
      try {
        const row = database.prepare(sql).get();
        const found = Number(row && row.count);
        if (Number.isSafeInteger(found) && found > 0) {
          count += found;
          if (agents.length < 8) agents.push(candidate.agentId);
        }
      } finally {
        database.close();
      }
    } catch (error) {}
  }
  process.stdout.write(JSON.stringify({ count: count, agents: agents }));
} catch (error) {
  process.stdout.write('null');
}
NODE
) || true
fi
if [ -z "\$STUCK_SESSION_WINDOWS_JSON" ]; then
  STUCK_SESSION_WINDOWS_JSON=null
fi

# Node binaries the shell, the gateway service, and Companion actually use.
# Facts only. The service decides which ones fall outside the engine range.
NODE_RUNTIMES_JSON=null
NODE_RUNTIMES_JSON=\$(node - "\$OPENCLAW_BIN" "\$GATEWAY_PID" "\$OC_VERSION_STDERR" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const bin = process.argv[2] || '';
const gatewayPid = process.argv[3] || '';
const versionErr = process.argv[4] || '';
const home = process.env.HOME || process.env.USERPROFILE || '';
function redact(value) {
  let text = String(value || '');
  if (home && home !== '/' && home !== '\\\\') text = text.split(home).join('~');
  text = text.replace(/\\/(?:Users|home)\\/[^/\\s]+/g, '~');
  text = text.replace(/[A-Za-z]:\\\\Users\\\\[^\\\\\\s]+/g, '~');
  return text;
}
function versionOf(executable) {
  if (!executable || !path.isAbsolute(executable)) return null;
  try {
    const out = execFileSync(executable, ['--version'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const match = String(out).match(/v?(\\d+\\.\\d+\\.\\d+)/);
    return match ? match[1] : null;
  } catch (error) {
    return null;
  }
}
function push(list, runtime) {
  if (!runtime || !runtime.version || !/^\\d+\\.\\d+\\.\\d+\$/.test(runtime.version)) return;
  const itemPath = runtime.path ? redact(runtime.path).slice(0, 300) : null;
  const key = runtime.source + '|' + (itemPath || '') + '|' + runtime.version;
  if (list.some(function (item) { return item.key === key; })) return;
  list.push({ key: key, source: runtime.source, path: itemPath, version: runtime.version });
}
function readText(file) {
  try {
    const info = fs.statSync(file);
    if (!info.isFile() || info.size > 1000000) return '';
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    return '';
  }
}
function nodeToken(text) {
  const match = String(text || '').match(/(?:^|[\\s"'=])((?:~|\\/)[^\\s"']*\\/node)(?=\$|[\\s"'])/);
  return match ? match[1] : '';
}
function serviceNode() {
  const plist = readText(path.join(home, 'Library', 'LaunchAgents', 'ai.openclaw.gateway.plist'));
  const plistNode = plist.match(/<string>([^<]*\\/node)<\\/string>/i);
  if (plistNode) return plistNode[1];
  const units = [
    path.join(home, '.config', 'systemd', 'user', 'openclaw-gateway.service'),
    '/etc/systemd/system/openclaw-gateway.service',
  ];
  for (let i = 0; i < units.length; i += 1) {
    const exec = readText(units[i]).match(/^ExecStart=\\s*(.+)\$/m);
    const token = exec ? nodeToken(exec[1]) : '';
    if (token) return token;
  }
  if (process.platform === 'win32') {
    const names = ['OpenClaw Gateway', 'openclaw-gateway'];
    for (let i = 0; i < names.length; i += 1) {
      try {
        const xml = execFileSync('schtasks', ['/Query', '/TN', names[i], '/XML'], {
          encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const command = String(xml).match(/<Command>([^<]+)<\\/Command>/i);
        if (command && /node(?:\\.exe)?\$/i.test(command[1].trim())) return command[1].trim();
      } catch (error) {}
    }
  }
  if (/^\\d+\$/.test(gatewayPid)) {
    try {
      const exe = fs.readlinkSync('/proc/' + gatewayPid + '/exe');
      if (exe && /\\/node\$/.test(exe)) return exe;
    } catch (error) {}
    try {
      const args = execFileSync('ps', ['-p', gatewayPid, '-o', 'args='], {
        encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const token = nodeToken(args);
      if (token) return token;
    } catch (error) {}
  }
  return '';
}
const runtimes = [];
const shellMatch = String(process.version || '').match(/v?(\\d+\\.\\d+\\.\\d+)/);
if (shellMatch) push(runtimes, { source: 'shell', path: process.execPath, version: shellMatch[1] });
const gatewayPath = serviceNode();
if (gatewayPath) {
  const fromName = String(gatewayPath).match(/node-v(\\d+\\.\\d+\\.\\d+)/);
  push(runtimes, { source: 'gateway', path: gatewayPath, version: versionOf(gatewayPath) || (fromName && fromName[1]) });
}
try {
  const names = fs.readdirSync(path.join(home, '.openclaw', 'tools'));
  let kept = 0;
  for (let i = 0; i < names.length && kept < 3; i += 1) {
    const fromName = String(names[i]).match(/^node-v(\\d+\\.\\d+\\.\\d+)\$/);
    if (!fromName) continue;
    const executable = path.join(home, '.openclaw', 'tools', names[i], 'bin', 'node');
    let info;
    try { info = fs.statSync(executable); } catch (error) { continue; }
    if (!info.isFile()) continue;
    push(runtimes, { source: 'companion', path: executable, version: versionOf(executable) || fromName[1] });
    kept += 1;
  }
} catch (error) {}
let engines = null;
let current = bin;
try { current = fs.realpathSync(bin); } catch (error) {}
current = current ? path.dirname(current) : '';
for (let depth = 0; depth < 6 && current; depth += 1) {
  try {
    const parsed = JSON.parse(readText(path.join(current, 'package.json')) || 'null');
    const node = parsed && parsed.name === 'openclaw' && parsed.engines && parsed.engines.node;
    if (typeof node === 'string' && node.length > 0 && node.length < 200) {
      engines = node.trim();
      break;
    }
  } catch (error) {}
  const parent = path.dirname(current);
  if (parent === current) break;
  current = parent;
}
process.stdout.write(JSON.stringify({
  engines: engines,
  runtimes: runtimes.map(function (item) {
    return { source: item.source, path: item.path, version: item.version };
  }),
  versionError: redact(versionErr).slice(0, 2000),
}));
NODE
) || true
if [ -z "\$NODE_RUNTIMES_JSON" ]; then
  NODE_RUNTIMES_JSON=null
fi

# gateway.auth presence only. Mode is token, password, none, or trusted-proxy.
# The token value is never written into this payload.
GATEWAY_AUTH_JSON=null
GATEWAY_AUTH_JSON=\$(node - "\$OPENCLAW_CONFIG" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const configPath = process.argv[2] || '';
const names = [
  'openclaw.json.bak',
  'openclaw.json.bak.1',
  'openclaw.json.bak.2',
  'openclaw.json.pre-update',
  'openclaw.json.last-good',
];
const modes = { token: true, password: true, none: true, 'trusted-proxy': true };
function summarize(file) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const gateway = parsed.gateway;
  if (!gateway || typeof gateway !== 'object' || Array.isArray(gateway)) return { present: false, mode: null };
  const auth = gateway.auth;
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return { present: false, mode: null };
  const mode = typeof auth.mode === 'string' && modes[auth.mode] ? auth.mode : null;
  return { present: true, mode: mode };
}
let current = { read: false, present: false, mode: null };
if (configPath) {
  const summary = summarize(configPath);
  if (summary) current = { read: true, present: summary.present, mode: summary.mode };
}
const backups = [];
const dir = configPath ? path.dirname(configPath) : '';
if (dir) {
  for (let i = 0; i < names.length; i += 1) {
    const summary = summarize(path.join(dir, names[i]));
    if (!summary) continue;
    backups.push({ name: names[i], present: summary.present, mode: summary.mode });
  }
}
process.stdout.write(JSON.stringify({ current: current, backups: backups }));
NODE
) || true
if [ -z "\$GATEWAY_AUTH_JSON" ]; then
  GATEWAY_AUTH_JSON=null
fi

# *.reindex-lock.sqlite size and age. Never delete the file.
MEMORY_REINDEX_JSON=null
MEMORY_REINDEX_JSON=\$(node - "\$OPENCLAW_DIR" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const root = process.argv[2] || '';
const suffix = '.reindex-lock.sqlite';
function redact(value) {
  let text = String(value || '');
  const home = os.homedir();
  if (home && (text === home || text.startsWith(home + path.sep))) {
    text = '~' + text.slice(home.length);
  }
  const parts = text.split(path.sep);
  const usersAt = parts.findIndex(function (part) { return part === 'Users' || part === 'home'; });
  if (usersAt >= 0 && parts[usersAt + 1]) {
    text = ['~'].concat(parts.slice(usersAt + 2)).join('/');
  }
  return text.slice(0, 300);
}
let reindexAlive = false;
try {
  const out = execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8', timeout: 5000, maxBuffer: 200000 });
  reindexAlive = String(out).split('\\n').some(function (line) {
    if (/\\bclawfix\\b/i.test(line)) return false;
    return /\\bopenclaw\\b/.test(line) && /\\bmemory\\b/.test(line) && /\\b(?:index|reindex)\\b/.test(line);
  });
} catch (error) {
  reindexAlive = false;
}
const locks = [];
function walk(dir, depth) {
  if (locks.length >= 8 || depth > 6) return;
  let names;
  try { names = fs.readdirSync(dir); } catch (error) { return; }
  for (let i = 0; i < names.length; i += 1) {
    if (locks.length >= 8) return;
    const full = path.join(dir, names[i]);
    let info;
    try { info = fs.lstatSync(full); } catch (error) { continue; }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) { walk(full, depth + 1); continue; }
    if (!info.isFile() || !names[i].endsWith(suffix)) continue;
    locks.push({
      path: redact(full),
      bytes: info.size,
      ageMs: Math.max(0, Math.floor(Date.now() - info.mtimeMs)),
      reindexAlive: reindexAlive,
    });
  }
}
if (root && root !== 'not found') walk(root, 0);
process.stdout.write(JSON.stringify({ reindexAlive: reindexAlive, locks: locks }));
NODE
) || true
if [ -z "\$MEMORY_REINDEX_JSON" ]; then
  MEMORY_REINDEX_JSON=null
fi

# --- Build Diagnostic Payload ---
echo ""
echo -e "\${BLUE}📦 Building diagnostic report...\${NC}"

DIAGNOSTIC=\$(cat <<EOF
{
  "version": "\$VERSION",
  "timestamp": "\$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "hostHash": "\$HOSTNAME_HASH",
  "system": {
    "os": "\$OS_NAME",
    "osVersion": "\$OS_VERSION",
    "arch": "\$OS_ARCH",
    "nodeVersion": "\$NODE_VERSION",
    "npmVersion": "\$NPM_VERSION"
  },
  "openclaw": {
    "version": "\${OC_VERSION:-unknown}",
    "install": \$INSTALL_JSON,
    "updateAvailability": \$UPDATE_JSON,
    "binary": "\${OPENCLAW_BIN:-not found}",
    "configDir": "\${OPENCLAW_DIR:-not found}",
    "configExists": \$CONFIG_EXISTS,
    "nativeDoctor": \$(printf '%s' "\$DOCTOR_JSON" | jq -c .),
    "gatewayStatus": \$(echo "\$GATEWAY_STATUS" | jq -Rs .),
    "gatewayPid": "\${GATEWAY_PID:-none}",
    "gatewayPort": "\${GATEWAY_PORT:-18789}",
    "processExists": \$PROCESS_EXISTS,
    "portListening": \$PORT_LISTENING,
    "doctorProcesses": \$DOCTOR_PROCESSES_JSON,
    "stuckSessionWindows": \$STUCK_SESSION_WINDOWS_JSON,
    "nodeRuntimes": \$NODE_RUNTIMES_JSON,
    "gatewayAuth": \$GATEWAY_AUTH_JSON,
    "memoryReindexLocks": \$MEMORY_REINDEX_JSON
  },
  "service": {
    "manager": "\$SERVICE_MANAGER",
    "state": "\${SERVICE_STATE:-unknown}",
    "exitCode": "\${SERVICE_EXIT_CODE:-}",
    "pid": "\${SERVICE_PID:-}",
    "runs": "\${SERVICE_RUNS:-}"
  },
  "config": \$SANITIZED_CONFIG,
  "logs": {
    "errors": \$(echo "\$GATEWAY_LOG" | jq -Rs .),
    "stderr": \$(echo "\$ERROR_LOG" | jq -Rs .),
    "errLogSizeMB": \${ERR_LOG_SIZE_MB:-0},
    "handshakeTimeoutCount": \${HANDSHAKE_TIMEOUT_COUNT:-0},
    "sigtermCount": \${SIGTERM_COUNT:-0}
  },
  "workspace": {
    "path": "\${WORKSPACE_DIR:-unknown}",
    "mdFiles": \$WORKSPACE_FILES,
    "memoryFiles": \$MEMORY_FILES,
    "hasSoul": \$SOUL_EXISTS,
    "hasAgents": \$AGENTS_EXISTS,
    "heartbeatFile": \$HEARTBEAT_FILE_JSON
  },
  "browser": {
    "status": "\$BROWSER_STATUS"
  }
}
EOF
)

# --- Show Summary ---
echo ""
echo -e "\${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\${NC}"
echo -e "\${BOLD}📊 Diagnostic Summary\${NC}"
echo -e "\${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\${NC}"
echo ""

# Count issues
ISSUES=0
ISSUE_LIST=""

# Check for common problems.
# A service-manager line marked "diagnostic only, not the check target" is not
# the gateway verdict. "Connectivity check: ok" and "Listening:" mean it is up,
# even when that discarded line says "Runtime: stopped".
GATEWAY_PROBE=\$(printf '%s\n' "\$GATEWAY_STATUS" | grep -vi 'diagnostic only, not the check target' || true)
GATEWAY_RUNNING=false
if printf '%s\n' "\$GATEWAY_PROBE" | grep -Eqi 'connectivity check:[[:space:]]*ok|read check:[[:space:]]*ok|running.*pid|state active|^listening:'; then
  GATEWAY_RUNNING=true
fi
GATEWAY_DOWN=false
if [ "\$GATEWAY_RUNNING" != "true" ]; then
  if printf '%s\n' "\$GATEWAY_PROBE" | grep -Eqi 'connectivity check:[[:space:]]*(failed|timed out)|read check:[[:space:]]*(failed|timed out)|not running|failed to start|stopped|inactive'; then
    GATEWAY_DOWN=true
  elif ! printf '%s\n' "\$GATEWAY_PROBE" | grep -qi 'warning'; then
    GATEWAY_DOWN=true
  fi
fi
if [ "\$GATEWAY_DOWN" = "true" ]; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${RED}❌ Gateway is not running\${NC}\\n"
fi

if echo "\$GATEWAY_LOG" | grep -qi "EADDRINUSE"; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${RED}❌ Port conflict detected\${NC}\\n"
fi

if echo "\$SANITIZED_CONFIG" | jq -e '(.plugins.entries["openclaw-mem0"] | type == "object") and .plugins.entries["openclaw-mem0"].config.enableGraph == true' &>/dev/null; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${RED}❌ Mem0 enableGraph requires Pro plan (will silently fail)\${NC}\\n"
fi

if [ "\$CONFIG_EXISTS" = true ] && echo "\$SANITIZED_CONFIG" | jq -e '.agents.defaults' &>/dev/null && ! echo "\$SANITIZED_CONFIG" | jq -e '.agents.defaults.contextPruning' &>/dev/null; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${YELLOW}⚠️  No context pruning configured\${NC}\\n"
fi

if [ "\$CONFIG_EXISTS" = true ] && echo "\$SANITIZED_CONFIG" | jq -e '.agents.defaults' &>/dev/null && ! echo "\$SANITIZED_CONFIG" | jq -e '.agents.defaults.compaction.memoryFlush.enabled == true' &>/dev/null; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${YELLOW}⚠️  Memory flush not enabled (data loss on compaction)\${NC}\\n"
fi

if [ "\$SOUL_EXISTS" = "false" ]; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${YELLOW}⚠️  No SOUL.md found (agent has no personality)\${NC}\\n"
fi

if [ "\$MEMORY_FILES" -eq 0 ]; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${YELLOW}⚠️  No memory files found\${NC}\\n"
fi

# Doctor timeout is a collector state. It is not counted as an OpenClaw finding.
if [ "\$DOCTOR_JSON" != "null" ] && echo "\$DOCTOR_JSON" | jq -e '.timedOut == true' >/dev/null; then
  echo -e "   \${YELLOW}⚠️  OpenClaw Doctor timed out\${NC}"
fi

if printf '%s\\n' "\$GATEWAY_LOG" "\$ERROR_LOG" | grep -Eqi 'Legacy workspace setup state requires migration|legacy workspace setup conflicts with canonical SQLite state|missing or drifted index idx_agent_session_nodes_active|Legacy session store requires migration'; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${RED}❌ Post-upgrade migration crash loop — gateway restart will not fix it\${NC}\\n"
fi
DOCTOR_STALL=false
if printf '%s\\n' "\$GATEWAY_LOG" "\$ERROR_LOG" | grep -Eqi 'sqlite-source-revision|process census is incomplete|Doctor interrupted by SIGTERM|CLI signal cleanup did not complete|undergoing offline maintenance'; then
  DOCTOR_STALL=true
fi
SNAPSHOT_COUNT=\$(printf '%s\\n' "\$GATEWAY_LOG" "\$ERROR_LOG" | grep -c 'SQLite read-only snapshot' || true)
if [ "\${SNAPSHOT_COUNT:-0}" -ge 3 ]; then
  DOCTOR_STALL=true
fi
if printf '%s\\n' "\$DOCTOR_PROCESSES_JSON" | jq -e 'map(select(.elapsedSeconds >= 900)) | length > 0' >/dev/null 2>&1; then
  DOCTOR_STALL=true
fi
if [ "\$DOCTOR_STALL" = "true" ]; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${RED}❌ Doctor repair looks stalled — do not start another doctor --fix\${NC}\\n"
fi

# Zombie gateway detection
if [ "\$PROCESS_EXISTS" = "true" ] && [ "\$PORT_LISTENING" = "false" ]; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${RED}❌ Zombie gateway: process exists (PID \${GATEWAY_PID}) but port not listening\${NC}\\n"
fi

# SIGTERM / crashed service warning
if [ "\$SERVICE_STATE" = "sigterm" ]; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${RED}❌ Service received SIGTERM (exit -15) — crash loop or forced kill detected\${NC}\\n"
elif [ "\$SERVICE_STATE" = "crashed" ] || [ "\$SERVICE_STATE" = "failed" ]; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${RED}❌ Service is in \${SERVICE_STATE} state (exit code: \${SERVICE_EXIT_CODE})\${NC}\\n"
fi

if [ \$ISSUES -eq 0 ]; then
  echo -e "\${GREEN}✅ No issues detected! Your OpenClaw looks healthy.\${NC}"
else
  echo -e "\${RED}Found \$ISSUES issue(s):\${NC}"
  echo ""
  echo -e "\$ISSUE_LIST"
fi

echo ""
echo -e "\${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\${NC}"
echo ""

# --- Ask to send for AI analysis ---
if [ \$ISSUES -gt 0 ]; then
  echo -e "\${BOLD}Optional AI analysis can explain problems not covered by deterministic checks.\${NC}"
  echo ""
  echo -e "\${YELLOW}Data that will be sent:\${NC}"
  echo "  • OS type, version, architecture"
  echo "  • Node/npm versions"
  echo "  • OpenClaw version and config (recognized secrets redacted; top-level env omitted)"
  echo "  • OpenClaw install layout (package manager, which required files are present, home-redacted package root)"
  echo "  • OpenClaw update availability (current version, available version, channel, and whether an update is available)"
  echo "  • Recent logs (up to 30 matching gateway log lines and up to 50 recent stderr lines)"
  echo "  • Plugin status (enabled/disabled only)"
  echo "  • Gateway status"
  echo "  • OpenClaw doctor --lint result (findings, or a timed-out state when the 120 second budget is exhausted; recognized secrets redacted)"
  echo "  • Source IP is processed transiently by ClawFix for abuse prevention"
  echo "  • Redacted diagnostic data is analyzed by ClawFix and OpenRouter"
  echo ""
  echo -e "\${YELLOW}NOT sent:\${NC}"
  echo "  • Top-level config env block"
  echo "  • File contents (SOUL.md, AGENTS.md, etc.)"
  echo "  • Chat history or messages"
  echo "  • Real hostname (only an 8-character one-way hash is sent)"
  echo "  • Update-status paths, git metadata, registry errors, or run history"
  echo "  • Partial doctor output from a timed-out lint process"
  echo ""
  echo -e "\${YELLOW}To inspect the full payload first:\${NC}"
  echo "  npx clawfix --dry-run"
  echo ""
  read -p "Send diagnostic for AI analysis? [y/N] " -n 1 -r
  echo ""
  
  if [[ \$REPLY =~ ^[Yy]$ ]]; then
    echo ""
    echo -e "\${BLUE}📡 Sending diagnostic to ClawFix...\${NC}"
    
    RESPONSE=\$(curl -sS -X POST "\$API_URL/api/diagnose" \\
      -H "Content-Type: application/json" \\
      -d "\$DIAGNOSTIC" 2>&1)
    
    if echo "\$RESPONSE" | jq -e '.fixId' &>/dev/null; then
      FIX_ID=\$(echo "\$RESPONSE" | jq -r '.fixId')
      ISSUES_FOUND=\$(echo "\$RESPONSE" | jq -r '.issuesFound // 0')
      echo ""
      echo -e "\${GREEN}✅ Diagnosis complete! Found \${ISSUES_FOUND} issue(s).\${NC}"
      echo ""
      
      # Show known issues
      echo "\$RESPONSE" | jq -r '.knownIssues[]? | "  \\(.severity | ascii_upcase) — \\(.title): \\(.description)"' 2>/dev/null
      
      echo ""
      echo -e "\${BOLD}AI Analysis:\${NC}"
      echo "\$RESPONSE" | jq -r '.analysis // "Pattern matching only (no AI key configured)"' 2>/dev/null
      echo ""
      
      # Save fix script
      echo "\$RESPONSE" | jq -r '.fixScript' > "/tmp/clawfix-\$FIX_ID.sh" 2>/dev/null
      
      echo -e "\${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\${NC}"
      echo ""
      echo -e "\${BOLD}📋 Fix script saved to: /tmp/clawfix-\$FIX_ID.sh\${NC}"
      echo -e "   Review it:  \${CYAN}cat /tmp/clawfix-\$FIX_ID.sh\${NC}"
      echo -e "   Apply it:   \${CYAN}bash /tmp/clawfix-\$FIX_ID.sh\${NC}"
      echo ""
      echo -e "\${BOLD}🌐 View results in browser:\${NC}"
      echo -e "   \${CYAN}\$API_URL/results/\$FIX_ID\${NC}"
      echo ""
      echo -e "\${BOLD}Fix ID:\${NC} \$FIX_ID"
    else
      echo -e "\${RED}❌ Error from API:\${NC}"
      echo "\$RESPONSE"
    fi
  else
    echo ""
    echo -e "No problem! You can review the diagnostic data:"
    echo -e "  echo '\$DIAGNOSTIC' | jq ."
    echo ""
    echo -e "Or send it manually later:"
    echo -e "  curl -X POST \$API_URL/api/diagnose -H 'Content-Type: application/json' -d @diagnostic.json"
  fi
else
  echo -e "\${GREEN}Your OpenClaw is looking good! No fixes needed.\${NC}"
  echo -e "If you're still having issues, re-run your reviewed local copy with verbose mode:"
  echo -e "  VERBOSE=1 bash clawfix.sh"
fi

echo ""
echo -e "\${CYAN}🦞 ClawFix — made by Arca (arcabot.eth)\${NC}"
echo -e "\${CYAN}   https://clawfix.dev | https://x.com/arcabotai\${NC}"
echo ""
`;

// Compute hash of the script for verification.
// The repo's SCRIPT_HASH file is the out-of-band reference /fix/sha256 points users at, so it
// must equal this value — `npm run hash:script` regenerates it and a test enforces the match.
const SCRIPT_HASH = createHash('sha256').update(DIAGNOSTIC_SCRIPT).digest('hex');

export { DIAGNOSTIC_SCRIPT, SCRIPT_HASH };
