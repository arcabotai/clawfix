#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
echo "=== env ==="
uname -a
node --version
npm --version
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH:$(npm prefix -g)/bin"
if ! command -v bun >/dev/null 2>&1; then
  echo "installing bun via npm package"
  npm install -g bun@1.2.21
fi
command -v bun
bun --version
echo "=== bun install ==="
bun install --frozen-lockfile
echo "=== bun test ==="
set +e
bun test
code=$?
set -e
echo "BUN_TEST_EXIT:$code"
exit "$code"
