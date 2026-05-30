#!/usr/bin/env bash
# G10.8 — drives bench/hook-worker-parent-exit.mts from outside.
#
# The bench exits without calling close()/terminate() — we want to see
# whether the hook-worker child observes the parent's exit and shuts
# down (the `process.on('disconnect')` path), or whether it sits idle
# matching the live-MCP-server orphan symptom.
#
# Run: bash scripts/hook-worker-parent-exit-runner.sh

set -uo pipefail
cd "$(dirname "$0")/.."

OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT

echo "=== running parent-exit bench ==="
bun bench/hook-worker-parent-exit.mts 2>&1 | tee "$OUT" >/dev/null
RC=$?
LINE=$(grep '^PARENT=' "$OUT" || true)
if [[ -z "$LINE" ]]; then
  echo "FATAL: bench did not emit PARENT/CHILDREN line"
  cat "$OUT"
  exit 2
fi
echo "bench output: $LINE"

# Extract PIDs from the marker line.
PARENT=$(echo "$LINE" | sed -E 's/.*PARENT=([0-9]+).*/\1/')
CHILDREN=$(echo "$LINE" | sed -E 's/.*CHILDREN=([0-9,]*).*/\1/')
TEMPDIR=$(echo "$LINE" | sed -E 's/.*TEMPDIR=(.*)$/\1/')

echo "parent pid: $PARENT  children: ${CHILDREN:-<none>}"

if [[ -z "$CHILDREN" ]]; then
  echo "no children were spawned (in-process fallback?)"
  exit 0
fi

# Wait for the OS to settle after the parent exits. Per Node/Bun
# semantics, the disconnect event on the child's IPC channel should
# fire and `process.exit(0)` runs.
SETTLE_MS=${G10_8_SETTLE_MS:-2000}
sleep $(awk "BEGIN { print $SETTLE_MS / 1000 }")

ORPHANS=()
IFS=',' read -ra ARR <<< "$CHILDREN"
for pid in "${ARR[@]}"; do
  if ps -p "$pid" >/dev/null 2>&1; then
    ORPHANS+=("$pid")
  fi
done

if [[ ${#ORPHANS[@]} -eq 0 ]]; then
  echo "✓ all hook-worker children exited cleanly after parent exit"
  exit 0
fi

echo "❌ orphan hook-worker children survived parent exit: ${ORPHANS[*]}"
ps -o pid,ppid,etime,%cpu,rss,command -p "${ORPHANS[@]}"
# Clean up orphans we created — these are bench-only, the live MCP's
# orphans (76866 / 77199) are deliberately left alone.
for pid in "${ORPHANS[@]}"; do
  kill "$pid" 2>/dev/null || true
done
# Clean up the tempdir as a courtesy.
[[ -n "$TEMPDIR" && -d "$TEMPDIR" ]] && rm -rf "$TEMPDIR"

exit 1
