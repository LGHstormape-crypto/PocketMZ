#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Run PocketMZ local/CI verification checks.
# Usage: scripts/pocketmz-ci.sh [--headless] [--mz <dir>] [--mv <dir>]
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
HEADLESS=0
EXTRA_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --headless) HEADLESS=1; shift ;;
    --mz|--mv) HEADLESS=1; EXTRA_ARGS+=("$1" "$2"); shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

echo "=== [1/2] bash -n syntax check ==="
while IFS= read -r f; do
  bash -n "$f"
done < <(find "$REPO/scripts" "$REPO/beta" "$REPO/tools" "$REPO/tests" -type f -name '*.sh' 2>/dev/null | sort)
echo "bash -n OK"

echo "=== [2/2] Fast host CI checks ==="
node "$REPO/tests/ci-fast.js"

if [ "$HEADLESS" = 1 ] || [ -n "${PMZ_BENCH_MZ:-}" ]; then
  echo "=== [3/3] Headless llvmpipe bench regression ==="
  bash "$REPO/tests/run-headless-bench.sh" "${EXTRA_ARGS[@]}"
fi
